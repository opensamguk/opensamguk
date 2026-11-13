import type { Prisma } from '@opensamguk/db';
import {
  readLineageState,
  lineagePublicEvents,
  type WorldView,
  type WorldState,
  type ReplayState,
  type LineageMonthEffects,
} from '@opensamguk/rules';
import { loadWorld } from '../worldLoader';
import { loadReplayState } from '../monthly';
import { persistEffects } from '../persist';
import { databaseNow } from '../lease';
import type { LineageRepository } from './port';
import { appendNationHistory } from '../commandPersistence';

export class PgLineageRepository implements LineageRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}
  async isUserActive(userId: string) {
    await this.tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR SHARE`;
    return (await this.tx.user.findUnique({ where: { id: userId }, select: { status: true } }))?.status === 'ACTIVE';
  }
  async isSanctioned(worldId: string, userId: string) {
    const now = await databaseNow(this.tx);
    return (
      (await this.tx.sanction.findFirst({
        where: {
          userId,
          liftedAt: null,
          AND: [{ OR: [{ worldId: null }, { worldId }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
        },
        select: { id: true },
      })) !== null
    );
  }
  load(worldId: string) {
    return loadWorld(this.tx, worldId);
  }
  async loadForGeneral(worldId: string, generalId: number) {
    await this.tx.$queryRaw`SELECT id FROM "General" WHERE "worldId"=${worldId} AND id=${generalId} FOR UPDATE`;
    return loadReplayState(this.tx, worldId);
  }
  async save(worldId: string, before: WorldState, next: WorldState, at: { tick: number; sequence: number }) {
    await persistEffects(this.tx, worldId, next, [{ kind: 'world', state: next }], at, before);
    await appendLineageHistory(this.tx, worldId, before, next, at);
  }
  async saveControl(
    worldId: string,
    before: ReplayState,
    next: ReplayState,
    fromId: number,
    toId: number,
    at: { tick: number; sequence: number },
  ) {
    // 후계자의 ID가 더 작아도 단일 사용자 UNIQUE를 위반하지 않게 전임자를 먼저 해제한다.
    const cleared = await this.tx.general.updateMany({
      where: {
        worldId,
        id: fromId,
        userId: before.state.generals[fromId]!.userId,
        turnRevision: before.revisions[fromId]!,
      },
      data: { userId: null },
    });
    if (cleared.count !== 1) throw Error('계승 전 조작권이 바뀌었습니다.');
    await this.save(worldId, before.state, next.state, at);
    await persistLineageControl(this.tx, worldId, before, next, [fromId, toId], [toId]);
  }
}

export async function persistLineageState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  if (!before.lineage && !next.lineage) return;
  if (
    !before.lineage ||
    !next.lineage ||
    !before.ruleFeatures?.includes('lineage-v1') ||
    !next.ruleFeatures?.includes('lineage-v1')
  )
    throw Error('진행 중 가문 기능을 바꿀 수 없습니다.');
  const original = readLineageState(before.lineage),
    final = readLineageState(next.lineage);
  if (JSON.stringify(original.config) !== JSON.stringify(final.config) || original.seed !== final.seed)
    throw Error('진행 중 가문 설정·시드를 바꿀 수 없습니다.');
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, lineageState: { equals: original as Prisma.InputJsonValue } },
    data: { lineageState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw Error('가문 상태가 바뀌어 저장을 취소했습니다.');
}

async function resetTurns(tx: Prisma.TransactionClient, worldId: string, next: ReplayState, generalId: number) {
  await tx.generalTurn.deleteMany({ where: { worldId, generalId } });
  await tx.generalTurn.createMany({
    data: next.turns[generalId]!.map((entry, slot) => ({
      worldId,
      generalId,
      slot,
      commandKey: entry.commandKey,
      args: entry.args as Prisma.InputJsonValue,
      explicit: next.policy ? (entry.explicit ?? false) : true,
    })),
  });
}

async function persistLineageControl(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: ReplayState,
  next: ReplayState,
  ids: readonly number[],
  resetIds: readonly number[],
) {
  const now = await databaseNow(tx);
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const active = next.state.generals[id]!.userId !== null && next.policy !== undefined;
    const changed = await tx.general.updateMany({
      where: { worldId, id, userId: next.state.generals[id]!.userId, turnRevision: before.revisions[id]! },
      data: {
        turnRevision: next.revisions[id]!,
        defaultPolicy: next.policy?.policies[id] ?? 'none',
        lastActiveTick: active ? next.policy!.lastActiveTicks[id]! : null,
        lastActiveAt: active ? now : null,
      },
    });
    if (changed.count !== 1) throw Error('계승 예약 변경 번호가 바뀌었습니다.');
  }
  for (const id of [...new Set(resetIds)].sort((a, b) => a - b)) await resetTurns(tx, worldId, next, id);
}

export async function persistLineageMonth(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: ReplayState,
  next: ReplayState,
  effects: LineageMonthEffects,
  at: { tick: number; sequence: number },
) {
  for (const { generalId } of effects.births) {
    const general = next.state.generals[generalId];
    if (
      !general ||
      before.state.generals[generalId] ||
      next.state.lineage?.persons[String(generalId)]?.bornTick !== effects.tick
    )
      throw Error('새 출생 행의 출처가 잘못됐습니다.');
    await tx.general.create({
      data: {
        ...general,
        worldId,
        ...(general.nationId === null ? {} : { nationJoinedTick: at.tick }),
        turnRevision: 0,
        defaultPolicy: 'none',
        lastActiveTick: null,
        lastActiveAt: null,
        residenceTick: null,
      },
    });
    await resetTurns(tx, worldId, next, generalId);
  }
  const inherited = effects.deaths.filter(
    (entry): entry is typeof entry & { successorId: number } => entry.successorId !== null,
  );
  await persistLineageControl(
    tx,
    worldId,
    before,
    next,
    inherited.flatMap((entry) => [entry.generalId, entry.successorId]),
    inherited.map((entry) => entry.successorId),
  );
  await appendLineageHistory(tx, worldId, before.state, next.state, at);
}

async function appendLineageHistory(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
  at: { tick: number; sequence: number },
) {
  let ordinal = 0;
  for (const event of lineagePublicEvents(before, next)) {
    for (const generalId of event.generalIds)
      await tx.generalLog.create({
        data: {
          worldId,
          generalId,
          tick: at.tick,
          sequence: at.sequence,
          ordinal: ordinal++,
          commandKey: event.commandKey,
          kind: 'success',
          text: event.text,
        },
      });
    for (const nationId of event.nationIds) await appendNationHistory(tx, worldId, at.tick, nationId, event.text);
  }
}
