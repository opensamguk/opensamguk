import type { Prisma } from '@opensamguk/db';
import {
  governanceMovementSchema,
  readGovernanceState,
  type GovernanceMovement,
  type WorldState,
  type WorldView,
} from '@opensamguk/rules';
import { z } from 'zod';
import { databaseNow } from '../lease';
import { loadWorld } from '../worldLoader';
import { persistEffects } from '../persist';
import type { GovernanceRepository } from './port';

// 엔진의 기존 World 잠금·턴 트랜잭션 안에서만 호출한다.
export class PgGovernanceRepository implements GovernanceRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}
  async isUserActive(userId: string) {
    await this.tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
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
  async loadForGeneral(worldId: string, generalId: number) {
    await this.tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND id = ${generalId} FOR UPDATE`;
    return this.load(worldId);
  }
  async load(worldId: string) {
    return loadWorld(this.tx, worldId);
  }
  async save(worldId: string, before: WorldState, next: WorldState, at: { tick: number; sequence: number }) {
    await persistEffects(this.tx, worldId, next, [{ kind: 'world', state: next }], at, before);
  }
}

export async function persistGovernanceState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  if (!before.governance && !next.governance) return;
  if (
    !before.governance ||
    !next.governance ||
    !before.ruleFeatures?.includes('governance-v1') ||
    !next.ruleFeatures?.includes('governance-v1')
  )
    throw new Error('진행 중 황실 기능을 바꿀 수 없습니다.');
  const original = readGovernanceState(before.governance),
    final = readGovernanceState(next.governance);
  if (JSON.stringify(original.config) !== JSON.stringify(final.config))
    throw new Error('진행 중 황실 설정을 바꿀 수 없습니다.');
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, governanceState: { equals: original as Prisma.InputJsonValue } },
    data: { governanceState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new Error('저장할 황실 상태가 바뀌었습니다.');
}

export async function appendGovernanceMovements(
  tx: Prisma.TransactionClient,
  worldId: string,
  value: readonly GovernanceMovement[],
  at: { tick: number; sequence: number },
) {
  const rows = z.array(governanceMovementSchema).parse(value);
  if (rows.length === 0) return;
  const ordinal = await tx.governanceMovement.count({ where: { worldId, sequence: at.sequence } });
  await tx.governanceMovement.createMany({
    data: rows.map((row, index) => ({ ...row, worldId, ...at, ordinal: ordinal + index })),
  });
}

export type GovernanceLedgerEntry = GovernanceMovement & { tick: number; sequence: number; ordinal: number };

export async function readGovernanceLedger(tx: Prisma.TransactionClient, worldId: string) {
  await loadWorld(tx, worldId);
  return tx.governanceMovement.findMany({
    where: { worldId },
    orderBy: [{ sequence: 'asc' }, { ordinal: 'asc' }],
    select: {
      tick: true,
      sequence: true,
      ordinal: true,
      kind: true,
      refId: true,
      holder: true,
      holderId: true,
      resource: true,
      delta: true,
      fromNationId: true,
      toNationId: true,
    },
  });
}
