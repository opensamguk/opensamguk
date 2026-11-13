import type { Prisma, PrismaClient } from '@opensamguk/db';
import { HERITAGE_DIRECT_INPUT_KINDS, heritageActivityMonths, type HeritageActivityInput } from '@opensamguk/rules';
import type { HeritageBalanceStore, HeritageIdentity, HeritageReadStore } from './ports';

export async function heritageBalance(tx: Prisma.TransactionClient, userId: string) {
  return (await tx.heritageAccount.findUnique({ where: { userId }, select: { balance: true } }))?.balance ?? 0;
}
export class PgHeritageBalanceStore implements HeritageBalanceStore {
  constructor(private readonly tx: Prisma.TransactionClient) {}
  balance(userId: string) {
    return heritageBalance(this.tx, userId);
  }
}

export class PgHeritageReadStore implements HeritageReadStore {
  constructor(private readonly db: PrismaClient) {}
  async mine(identity: HeritageIdentity) {
    return this.db.$transaction(
      async (tx) => {
        const session = identity.sessionId
          ? await tx.session.findFirst({
              where: {
                id: identity.sessionId,
                userId: identity.userId,
                expiresAt: { gt: new Date(identity.now) },
                user: { status: 'ACTIVE' },
              },
              select: { id: true },
            })
          : null;
        if (!session) return { authenticated: false, balance: 0, entries: [], activeWorlds: [] };
        const balance = await heritageBalance(tx, identity.userId);
        const entries = await tx.heritageEntry.findMany({
          where: { userId: identity.userId },
          orderBy: { id: 'desc' },
          take: 20,
        });
        const worlds = await tx.world.findMany({
          where: {
            id: { in: [...new Set(entries.flatMap((entry) => (entry.worldId === null ? [] : [entry.worldId])))] },
          },
          select: { id: true, name: true },
        });
        const names = new Map(worlds.map((world) => [world.id, world.name]));
        const activeWorlds = await tx.world.findMany({
          where: {
            status: { not: 'ENDED' },
            ruleFeatures: { has: 'heritage-v1' },
            generals: { some: { userId: identity.userId, removedAt: null } },
          },
          select: { id: true, name: true, actionSequence: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        const inputs = await tx.inputEvent.findMany({
          where: {
            worldId: { in: activeWorlds.map((world) => world.id) },
            userId: identity.userId,
            status: 'APPLIED',
            kind: { in: [...HERITAGE_DIRECT_INPUT_KINDS] },
          },
          select: { worldId: true, userId: true, kind: true, status: true, sequence: true, tick: true, result: true },
        });
        const activityByWorld = new Map<string, HeritageActivityInput[]>();
        for (const row of inputs) {
          const activity = activityByWorld.get(row.worldId);
          if (activity) activity.push(row);
          else activityByWorld.set(row.worldId, [row]);
        }
        return {
          authenticated: true,
          balance,
          activeWorlds: activeWorlds.map((world) => ({
            worldId: world.id,
            worldName: world.name,
            activityMonths:
              heritageActivityMonths(activityByWorld.get(world.id) ?? [], world.actionSequence).get(identity.userId) ??
              0,
          })),
          entries: entries.map((entry) => ({
            id: String(entry.id),
            kind: entry.kind,
            worldId: entry.worldId,
            worldName: entry.worldId === null ? null : (names.get(entry.worldId) ?? null),
            delta: entry.delta,
            detail: entry.detail,
            createdAt: entry.createdAt.toISOString(),
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

// withdrawAccount가 User를 FOR UPDATE로 잡은 같은 트랜잭션에서만 호출한다.
export async function forfeitHeritageBalance(tx: Prisma.TransactionClient, userId: string) {
  const balance = await heritageBalance(tx, userId);
  if (balance === 0) return;
  const saved = await tx.heritageAccount.updateMany({ where: { userId, balance }, data: { balance: 0 } });
  if (saved.count !== 1) throw new Error('탈퇴 중 유산 잔액이 바뀌었습니다.');
  await tx.heritageEntry.create({
    data: {
      userId,
      key: 'forfeit',
      kind: 'FORFEIT',
      worldId: null,
      delta: -balance,
      detail: { version: 1, reason: 'ACCOUNT_WITHDRAWAL' },
    },
  });
}
