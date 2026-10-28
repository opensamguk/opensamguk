import type { PrismaClient } from '@opensamguk/db';

export const activeSanctionWhere = (now: number) => ({
  liftedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
});

export async function hasGlobalSanction(db: Pick<PrismaClient, 'sanction'>, userId: string, now: number) {
  return (
    (await db.sanction.findFirst({
      where: { userId, worldId: null, ...activeSanctionWhere(now) },
      select: { id: true },
    })) !== null
  );
}
