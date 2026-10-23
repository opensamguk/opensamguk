import { nextActionSequence, type Prisma } from '@opensamguk/db';
import {
  applyTreatyInput,
  TICKS_PER_MONTH,
  TREATY_INPUTS,
  treatyRespondByTick,
  validateTreatyRecord,
  validateTreatyState,
  type TreatyApplied,
  type TreatyInput,
  type TreatyRecord,
  type TreatyRecordContext,
  type TreatyRejected,
  type WorldState,
} from '@opensamguk/rules';
import { loadTreaties } from './treatyState';
import { loadWorld } from './worldLoader';

type StoredWorld = Prisma.WorldGetPayload<Record<string, never>>;
type StoredInput = Prisma.InputEventGetPayload<Record<string, never>>;
type ActorInput = TreatyInput & { generalId: number };

function pendingInput(world: StoredWorld, event: StoredInput, tick: number): ActorInput {
  if (
    world.treatyFormat !== 1 ||
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
  if (kind !== 'treaty.propose' && kind !== 'treaty.respond') throw new Error('조약 입력 종류를 확인하세요.');
  if (!event.idempotencyKey.startsWith(`${kind}:`) || event.idempotencyKey.length === kind.length + 1)
    throw new Error('조약 요청의 식별자를 확인하세요.');
  return kind === 'treaty.propose'
    ? { kind, generalId: event.generalId, payload: TREATY_INPUTS[kind].payloadSchema.parse(event.payload) }
    : { kind, generalId: event.generalId, payload: TREATY_INPUTS[kind].payloadSchema.parse(event.payload) };
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
  const input = pendingInput(world, event, tick);
  if (world.actionSequence >= 2_147_483_647) throw new Error('조약 입력의 순서 저장 범위를 넘었습니다.');
  const sequence = await nextActionSequence(tx, world.id);
  const context: TreatyRecordContext = { treaty: { version: 1 }, monthlyTick: world.monthlyTick };
  if (world.status === 'ENDED') {
    const ended = await tx.worldResult.findUnique({ where: { worldId: world.id }, select: { endedTick: true } });
    if (!ended) throw new Error('종료된 월드의 종료 기록이 없습니다.');
    context.endTick = ended.endedTick;
  }
  const complete = (status: 'APPLIED' | 'REJECTED', result: TreatyApplied | TreatyRejected) =>
    validateTreatyRecord(
      { sequence, generalId: input.generalId, kind: input.kind, status, payload: input.payload, result },
      context,
    );
  const save = async (record: TreatyRecord) => {
    const updated = await tx.inputEvent.updateMany({
      where: { id: event.id, worldId: world.id, status: 'PENDING' },
      data: { status: record.status, sequence, result: record.result as unknown as Prisma.InputJsonValue },
    });
    if (updated.count !== 1) throw new Error('조약 대기 입력이 변경됐습니다.');
  };
  const reject = (code: TreatyRejected['code'], message: string) => save(complete('REJECTED', { tick, code, message }));
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
  // 공통 worldLoader에 조약을 합치는 caller 연결은 아직 별도 선행이다.
  const before: WorldState = { ...(await loadWorld(tx, world.id)), ...(await loadTreaties(tx, world.id)) };
  const applied = applyTreatyInput(before, input, { tick, sequence });
  const record = complete(applied.ok ? 'APPLIED' : 'REJECTED', applied.result);
  if (applied.ok) await persistApplied(tx, world.id, input, before, applied.state, applied.result, sequence);
  await save(record);
}

async function persistApplied(
  tx: Prisma.TransactionClient,
  worldId: string,
  input: ActorInput,
  before: WorldState,
  next: WorldState,
  result: TreatyApplied,
  sequence: number,
): Promise<void> {
  const id = Number(result.treatyId);
  if (result.outcome === 'ACCEPTED') {
    const row = validateTreatyState(next.treaties?.find((entry) => entry.id === id));
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
      const row = validateTreatyState(next.treaties?.find((entry) => entry.id === id));
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
