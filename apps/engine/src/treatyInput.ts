import { nextActionSequence, type Prisma, type RealtimeSignal } from '@opensamguk/db';
import { createHash } from 'node:crypto';
import {
  applyTreatyInput,
  TICKS_PER_MONTH,
  TREATY_INPUTS,
  treatyRespondByTick,
  treatyBreakRecipients,
  toGameDate,
  validateTreatyRecord,
  validateTreatyState,
  validateBrokenTreatyRow,
  type TreatyApplied,
  type TreatyInput,
  type TreatyRecord,
  type TreatyRecordContext,
  type TreatyRejected,
  type WorldState,
} from '@opensamguk/rules';
import { loadTreaties } from './treatyState';
import { loadWorld } from './worldLoader';
import { loadReplayState } from './monthly';
import { databaseNow } from './lease';
import { readAdminEndTick } from './admin/end';

type StoredWorld = Prisma.WorldGetPayload<Record<string, never>>;
type StoredInput = Prisma.InputEventGetPayload<Record<string, never>>;
type ActorInput = TreatyInput & { generalId: number };

function pendingInput(
  world: StoredWorld,
  event: StoredInput,
  tick: number,
  treatyBreakEnabled = false,
  native = false,
): ActorInput {
  if (
    (!native && world.treatyFormat !== 1) ||
    event.worldId !== world.id ||
    event.id <= 0n ||
    event.status !== 'PENDING' ||
    event.sequence !== null ||
    event.result !== null ||
    !event.userId.length ||
    event.generalId === null ||
    !Number.isSafeInteger(event.generalId) ||
    event.generalId < 1 ||
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    tick > 2_147_483_647 - TICKS_PER_MONTH ||
    !Number.isSafeInteger(world.actionSequence) ||
    world.actionSequence < 0
  )
    throw new Error('조약 대기 입력의 출처와 구조를 확인하세요.');
  const kind = event.kind;
  if (kind !== 'treaty.propose' && kind !== 'treaty.respond' && !(treatyBreakEnabled && kind === 'treaty.break'))
    throw new Error('조약 입력 종류를 확인하세요.');
  if (!event.idempotencyKey.startsWith(`${kind}:`) || event.idempotencyKey.length === kind.length + 1)
    throw new Error('조약 요청의 식별자를 확인하세요.');
  if (kind === 'treaty.break')
    return { kind, generalId: event.generalId, payload: TREATY_INPUTS[kind].payloadSchema.parse(event.payload) };
  if (kind === 'treaty.respond')
    return { kind, generalId: event.generalId, payload: TREATY_INPUTS[kind].payloadSchema.parse(event.payload) };
  return { kind, generalId: event.generalId, payload: TREATY_INPUTS[kind].payloadSchema.parse(event.payload) };
}

// caller가 실제 cap6 선택, 리스·World 잠금과 최소 id PENDING 선택을 마친 뒤 부른다.
// 이 handler가 sequence를 한 번 배정한다. caller는 앞뒤에서 다시 올리지 않는다.
// origin 판정·큐·폴링·리스·별도 트랜잭션은 이 모듈의 책임이 아니다.
export async function processTreatyInput(
  tx: Prisma.TransactionClient,
  world: StoredWorld,
  event: StoredInput,
  tick: number,
): Promise<void> {
  pendingInput(world, event, tick);
  if (world.actionSequence >= 2_147_483_647) throw new Error('조약 입력의 순서 저장 범위를 넘었습니다.');
  const sequence = await nextActionSequence(tx, world.id);
  const record = await resolveTreatyInput(tx, world, event, { tick, sequence }, false);
  const updated = await tx.inputEvent.updateMany({
    where: { id: event.id, worldId: world.id, status: 'PENDING' },
    data: { status: record.status, sequence, result: record.result as unknown as Prisma.InputJsonValue },
  });
  if (updated.count !== 1) throw new Error('조약 대기 입력이 변경됐습니다.');
}

type TreatyQueuedContext = {
  tick: number;
  sequence: number;
  treatyBreakEnabled?: boolean;
  treatyTradeEnabled?: boolean;
  emit?: (signal: RealtimeSignal) => void;
};

// 형식3 중앙 처리기가 기능 검사·순서 배정·입력 CAS와 인사 후처리를 맡는다.
export async function processTreatyQueuedInput(
  tx: Prisma.TransactionClient,
  world: StoredWorld,
  event: StoredInput,
  context: TreatyQueuedContext,
): Promise<{ status: 'APPLIED' | 'REJECTED'; result: Prisma.InputJsonValue; generalId: number }> {
  const record = await resolveTreatyInput(tx, world, event, context, true);
  return {
    status: record.status,
    result: record.result as unknown as Prisma.InputJsonValue,
    generalId: record.generalId,
  };
}

async function resolveTreatyInput(
  tx: Prisma.TransactionClient,
  world: StoredWorld,
  event: StoredInput,
  at: TreatyQueuedContext,
  native: boolean,
): Promise<TreatyRecord> {
  const { tick, sequence } = at;
  const input = pendingInput(world, event, tick, at.treatyBreakEnabled, native);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2_147_483_647)
    throw new Error('조약 입력의 순서 저장 범위를 넘었습니다.');
  const context: TreatyRecordContext = {
    treaty: { version: 1 },
    ...(at.treatyTradeEnabled ? { treatyTrade: { version: 1 } } : {}),
    ...(at.treatyBreakEnabled ? { treatyBreak: { version: 1 } } : {}),
    monthlyTick: world.monthlyTick,
  };
  if (world.status === 'ENDED') {
    const ended = await tx.worldResult.findUnique({ where: { worldId: world.id }, select: { endedTick: true } });
    context.endTick = ended ? ended.endedTick : await readAdminEndTick(tx, world);
  }
  const complete = (status: 'APPLIED' | 'REJECTED', result: TreatyApplied | TreatyRejected) =>
    validateTreatyRecord(
      { sequence, generalId: input.generalId, kind: input.kind, status, payload: input.payload, result },
      context,
    );
  const reject = (code: TreatyRejected['code'], message: string) => complete('REJECTED', { tick, code, message });
  if (world.status !== 'RUNNING') return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  if (!user || user.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '행동할 수 없는 계정입니다.');
  await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${world.id} AND id = ${input.generalId} FOR UPDATE`;
  const actor = await tx.general.findUnique({
    where: { worldId_id: { worldId: world.id, id: input.generalId } },
    select: { userId: true },
  });
  if (!actor || actor.userId !== event.userId) return reject('NO_GENERAL', '내 장수가 아닙니다.');
  const before: WorldState = native
    ? (await loadReplayState(tx, world.id)).state
    : { ...(await loadWorld(tx, world.id)), ...(await loadTreaties(tx, world.id)) };
  const applied = applyTreatyInput(before, input, { tick, sequence, tradeEnabled: at.treatyTradeEnabled ?? false });
  const record = complete(applied.ok ? 'APPLIED' : 'REJECTED', applied.result);
  if (applied.ok)
    await persistApplied(
      tx,
      world,
      input,
      before,
      applied.state,
      applied.result,
      sequence,
      at.emit,
      at.treatyTradeEnabled ?? false,
    );
  return record;
}

async function persistApplied(
  tx: Prisma.TransactionClient,
  world: StoredWorld,
  input: ActorInput,
  before: WorldState,
  next: WorldState,
  result: TreatyApplied,
  sequence: number,
  emit?: (signal: RealtimeSignal) => void,
  tradeEnabled = false,
): Promise<void> {
  const worldId = world.id;
  const id = Number(result.treatyId);
  if (result.outcome === 'BROKEN') {
    if (input.kind !== 'treaty.break') throw new Error('파기 결과의 입력 종류를 확인하세요.');
    const stored = await tx.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id } } });
    if (stored.status !== 'ACTIVE' || stored.closedSequence !== null) throw new Error('파기할 조약이 변경됐습니다.');
    const { worldId: ignored, ...row } = stored;
    void ignored;
    validateBrokenTreatyRow({ ...row, status: 'BROKEN', closedSequence: sequence }, { tradeEnabled });
    const closed = await tx.treaty.updateMany({
      where: { worldId, id, status: 'ACTIVE', closedSequence: null },
      data: { status: 'BROKEN', closedSequence: sequence },
    });
    if (closed.count !== 1) throw new Error('파기할 조약이 변경됐습니다.');
    const nationA = Math.min(stored.fromNationId, stored.toNationId);
    const nationB = Math.max(stored.fromNationId, stored.toNationId);
    const pair = before.diplomacies.find((entry) => entry.nationA === nationA && entry.nationB === nationB);
    if (pair && !next.diplomacies.some((entry) => entry.nationA === nationA && entry.nationB === nationB)) {
      const removed = await tx.diplomacy.deleteMany({ where: { worldId, ...pair } });
      if (removed.count !== 1) throw new Error('파기할 조약의 외교 관계가 변경됐습니다.');
    }
    const previous = before.nationTrust?.find((entry) => entry.nationId === result.brokenByNationId);
    const changed = next.nationTrust?.find((entry) => entry.nationId === result.brokenByNationId);
    if (!changed) throw new Error('파기한 국가의 신의 기록이 없습니다.');
    if (previous) {
      const written = await tx.nationTrust.updateMany({ where: { worldId, ...previous }, data: changed });
      if (written.count !== 1) throw new Error('파기한 국가의 신의 기록이 변경됐습니다.');
    } else await tx.nationTrust.create({ data: { worldId, ...changed } });
    const recipients = treatyBreakRecipients(before, result);
    const nation = before.nations[result.brokenByNationId];
    if (!nation) throw new Error('파기한 국가가 없습니다.');
    const date = toGameDate(world.startYear, result.tick);
    if (recipients.length) {
      const sentAt = await databaseNow(tx);
      const messages = await tx.message.createMany({
        data: recipients.map((nationId) => {
          const receiver = before.nations[nationId]!;
          return {
            id: treatyBreakMessageId(worldId, sequence, nationId),
            worldId,
            scope: 'NATION' as const,
            senderId: null,
            senderNationId: null,
            recipientId: null,
            recipientNationId: nationId,
            fromParty: { generalId: null, name: '조약 기록', nation: null },
            toParty: {
              generalId: null,
              name: receiver.name,
              nation: { id: receiver.id, name: receiver.name, color: receiver.color },
            },
            body: `${nation.name} 국가가 조약을 파기했습니다. 지금까지 파기 ${changed.brokenTreaties}회입니다.`,
            sentAt,
            year: date.year,
            month: date.month,
          };
        }),
      });
      if (messages.count !== recipients.length) throw new Error('파기 알림을 모두 저장하지 못했습니다.');
    }
    for (const nationId of recipients) emit?.({ kind: 'message.new', scope: 'NATION', target: { nationId } });
    emit?.({ kind: 'treaty.new', target: { nationIds: [stored.fromNationId, stored.toNationId] } });
    return;
  }
  if (result.outcome === 'ACCEPTED') {
    const row = validateTreatyState(
      next.treaties?.find((entry) => entry.id === id),
      { tradeEnabled },
    );
    for (const nationId of [row.fromNationId, row.toNationId]) {
      const oldGold = before.nations[nationId]!.gold;
      const gold = next.nations[nationId]!.gold;
      if (gold === oldGold) continue;
      const updated = await tx.nation.updateMany({ where: { worldId, id: nationId, gold: oldGold }, data: { gold } });
      if (updated.count !== 1) throw new Error('조약 납부 대상의 국고가 변경됐습니다.');
    }
    const nationA = Math.min(row.fromNationId, row.toNationId);
    const nationB = Math.max(row.fromNationId, row.toNationId);
    const pair = (state: WorldState) =>
      state.diplomacies.find((entry) => entry.nationA === nationA && entry.nationB === nationB);
    const oldPair = pair(before);
    const nextPair = pair(next);
    if (JSON.stringify(oldPair) !== JSON.stringify(nextPair)) {
      const removed = await tx.diplomacy.deleteMany({ where: { worldId, nationA, nationB } });
      if (removed.count !== (oldPair ? 1 : 0)) throw new Error('조약 대상의 외교 관계가 변경됐습니다.');
      if (nextPair) await tx.diplomacy.create({ data: { ...nextPair, worldId } });
    }
  }
  if (input.kind === 'treaty.propose') {
    if (result.outcome === 'DECLINED') {
      const fromNationId = before.generals[input.generalId]?.nationId;
      if (fromNationId === null || fromNationId === undefined) throw new Error('제안 장수의 국가가 없습니다.');
      await tx.treaty.create({
        data: {
          worldId,
          id,
          fromNationId,
          toNationId: input.payload.toNationId,
          clauses: input.payload.clauses as Prisma.InputJsonValue,
          status: 'REJECTED',
          proposedTick: result.tick,
          respondByTick: treatyRespondByTick(result.tick),
          startTick: null,
          endTick: null,
          costFrom: null,
          costTo: null,
          closedSequence: sequence,
        },
      });
    } else {
      const row = validateTreatyState(
        next.treaties?.find((entry) => entry.id === id),
        { tradeEnabled },
      );
      await tx.treaty.create({
        data: {
          ...row,
          worldId,
          clauses: row.clauses as Prisma.InputJsonValue,
          closedSequence: null,
          costFrom: result.outcome === 'ACCEPTED' ? result.cost.from : null,
          costTo: result.outcome === 'ACCEPTED' ? result.cost.to : null,
        },
      });
    }
    return;
  }
  if (result.outcome === 'PROPOSED') throw new Error('조약 응답 결과가 제안으로 기록됐습니다.');
  const updated = await tx.treaty.updateMany({
    where: { worldId, id, status: 'PROPOSED', closedSequence: null },
    data:
      result.outcome === 'DECLINED'
        ? { status: 'REJECTED', closedSequence: sequence }
        : {
            status: 'ACTIVE',
            startTick: result.tick,
            endTick: result.endTick,
            costFrom: result.cost.from,
            costTo: result.cost.to,
          },
  });
  if (updated.count !== 1) throw new Error('응답할 조약이 변경됐습니다.');
}

export function treatyBreakMessageId(worldId: string, sequence: number, nationId: number): string {
  const bytes = createHash('sha256').update(`treaty.break:${worldId}:${sequence}:${nationId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
