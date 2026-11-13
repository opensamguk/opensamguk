import { randomInt, randomUUID } from 'node:crypto';
import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const maxCards = 5;
const maxKeeps = 3;
const cardsSchema = z
  .array(
    z.strictObject({
      generalId: z.number().int().positive(),
      keepCount: z.number().int().min(0).max(maxKeeps),
    }),
  )
  .max(maxCards);
export const npcDraftRefresh = z.strictObject({
  nonce: z.uuid(),
  keepIds: z
    .array(z.number().int().positive())
    .max(maxCards)
    .refine((ids) => new Set(ids).size === ids.length),
});
export type NpcDraftRefresh = z.infer<typeof npcDraftRefresh>;
const pack = (row: { nonce: string; validUntil: Date; redrawAt: Date; cards: unknown }) => ({
  nonce: row.nonce,
  validUntil: row.validUntil.toISOString(),
  redrawAt: row.redrawAt.toISOString(),
  cards: cardsSchema.parse(row.cards),
});

export async function npcDraftIncludes(
  tx: Prisma.TransactionClient,
  worldId: string,
  userId: string,
  generalId: number,
  now: number,
) {
  const row = await tx.npcEntryDraft.findUnique({ where: { worldId_userId: { worldId, userId } } });
  return (
    row !== null &&
    row.validUntil.getTime() > now &&
    cardsSchema.parse(row.cards).some((card) => card.generalId === generalId)
  );
}

// The caller locks the world row for draws and possession admission so two users cannot hold the same NPC.
export async function readNpcDraft(
  tx: Prisma.TransactionClient,
  options: { worldId: string; userId: string; candidateIds: number[]; now: number; turnTermMinutes: number },
  draw: boolean,
  refresh?: NpcDraftRefresh,
) {
  const { worldId, userId, candidateIds, now, turnTermMinutes } = options;
  const key = { worldId, userId };
  const prior = await tx.npcEntryDraft.findUnique({ where: { worldId_userId: key } });
  const existing = prior && prior.validUntil.getTime() > now ? prior : null;
  if (!draw) return existing ? pack(existing) : undefined;
  if (existing && (!refresh || existing.nonce !== refresh.nonce)) return pack(existing);
  const previous = existing ? cardsSchema.parse(existing.cards) : [];
  if (existing && existing.redrawAt.getTime() > now)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '아직 다른 장수를 볼 수 없습니다.' });

  const selected = new Set(refresh?.keepIds ?? []);
  const eligible = new Set(candidateIds);
  const kept = previous.filter(
    ({ generalId, keepCount }) => selected.has(generalId) && keepCount > 0 && eligible.has(generalId),
  );
  if (existing && kept.length === previous.length && previous.length > 0) return pack(existing);

  const others = await tx.npcEntryDraft.findMany({
    where: { worldId, userId: { not: userId }, validUntil: { gt: new Date(now) } },
    select: { cards: true },
  });
  const unavailable = new Set(
    others.flatMap(({ cards }) => cardsSchema.parse(cards).map(({ generalId }) => generalId)),
  );
  const oldIds = new Set(previous.map(({ generalId }) => generalId));
  const cards = kept.map(({ generalId, keepCount }) => ({ generalId, keepCount: keepCount - 1 }));
  const pool = candidateIds.filter((id) => !unavailable.has(id) && !oldIds.has(id));
  const fallback = previous.filter(
    (card) =>
      !unavailable.has(card.generalId) &&
      eligible.has(card.generalId) &&
      !cards.some(({ generalId }) => generalId === card.generalId),
  );
  while (cards.length < maxCards && pool.length) {
    const [generalId] = pool.splice(randomInt(pool.length), 1);
    cards.push({ generalId: generalId!, keepCount: maxKeeps });
  }
  cards.push(...fallback.slice(0, maxCards - cards.length));
  if (
    existing &&
    cards.length === previous.length &&
    cards.every((card) => previous.some(({ generalId }) => generalId === card.generalId))
  )
    return pack(existing);

  // Timing follows core2026 c81d304 npcPossessionService.ts (MIT). Wall-clock time also works before opening.
  const validUntil = new Date(now + 1000 * Math.max(90, turnTermMinutes * 40));
  const wait = !existing || cards.length === 0 ? 0 : Math.max(10, Math.round(turnTermMinutes ** 0.672 * 8));
  const data = { nonce: randomUUID(), validUntil, redrawAt: new Date(now + 1000 * wait), cards };
  return pack(
    await tx.npcEntryDraft.upsert({ where: { worldId_userId: key }, create: { ...key, ...data }, update: data }),
  );
}
