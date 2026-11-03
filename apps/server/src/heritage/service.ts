import { z } from 'zod';
import { HERITAGE_V1 } from '@opensamguk/rules';
import type { HeritageBalanceStore, HeritageIdentity, HeritageReadStore } from './ports';

const kindSchema = z.enum(['SEASON_CREDIT', 'CREATION_SPEND', 'CREATION_REFUND', 'FORFEIT']);
const refundDetail = z.object({ reason: z.enum(['ADMIN_END', 'ADMIN_RESET']) });
const creditDetail = z.object({
  activityMonths: z.number().int().nonnegative(),
  activityPoints: z.number().int().min(0).max(3),
  winPoints: z.number().int().min(0).max(2),
});
export class HeritageReadError extends Error {
  readonly code = 'UNAUTHORIZED';
  constructor() {
    super('로그인이 필요합니다.');
  }
}
export async function readCreationHeritage(store: HeritageBalanceStore, userId: string) {
  return {
    version: 1 as const,
    userId,
    balance: await store.balance(userId),
    perStat: HERITAGE_V1.perStat,
    perGeneral: HERITAGE_V1.perGeneral,
  };
}
export async function readHeritageMine(store: HeritageReadStore, identity: HeritageIdentity) {
  const snapshot = await store.mine(identity);
  if (!snapshot.authenticated) throw new HeritageReadError();
  return {
    userId: identity.userId,
    balance: snapshot.balance,
    perStat: HERITAGE_V1.perStat,
    perGeneral: HERITAGE_V1.perGeneral,
    perSeason: HERITAGE_V1.perSeason,
    activityMonths: [...HERITAGE_V1.activityMonths],
    winPoints: HERITAGE_V1.winPoints,
    entries: snapshot.entries.map((entry) => ({
      id: entry.id,
      kind: kindSchema.parse(entry.kind),
      worldId: entry.worldId,
      worldName: entry.worldName,
      delta: entry.delta,
      createdAt: entry.createdAt,
      ...(entry.kind === 'SEASON_CREDIT' ? { credit: creditDetail.parse(entry.detail) } : {}),
      ...(entry.kind === 'CREATION_REFUND' ? { refund: refundDetail.parse(entry.detail) } : {}),
    })),
  };
}
