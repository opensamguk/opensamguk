import { z } from 'zod';
import { rankGenerals, rankNations } from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { readWorld, worldInput } from '../queries';

const nationIdentity = z.object({ id: z.number().int(), name: z.string(), color: z.string() });
// 캐시에 내부 항목이 추가돼도 공개 허용 필드만 반환한다.
const generalRows = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    nation: nationIdentity.nullable(),
    dedication: z.number().int(),
    experience: z.number().int(),
    wins: z.number().int().nonnegative(),
    captures: z.number().int().nonnegative(),
  }),
);
const nationRows = z.array(
  nationIdentity.extend({
    cities: z.number().int().nonnegative(),
    generals: z.number().int().nonnegative(),
    power: z.number().int().nonnegative(),
  }),
);
const snapshotAt = (snapshot: { tick: number; year: number; month: number }) => ({
  tick: snapshot.tick,
  year: snapshot.year,
  month: snapshot.month,
});

export const rankingRouter = router({
  generals: protectedProcedure
    .input(
      worldInput
        .extend({
          by: z.enum(['dedication', 'experience', 'merit']),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      readWorld(ctx.db, input.worldId, async (tx) => {
        const snapshot = await tx.rankingSnapshot.findUnique({
          where: { worldId: input.worldId },
          select: { tick: true, year: true, month: true, generals: true },
        });
        if (!snapshot) return { top: [], me: null, at: null };
        const rows = rankGenerals(generalRows.parse(snapshot.generals), input.by).map(({ id, ...row }) => ({
          generalId: id,
          ...row,
        }));
        const viewer = await tx.general.findUnique({
          where: { worldId_userId: { worldId: input.worldId, userId: ctx.user.id } },
          select: { id: true },
        });
        return {
          top: rows.slice(0, 100),
          me: viewer ? (rows.find((row) => row.generalId === viewer.id) ?? null) : null,
          at: snapshotAt(snapshot),
        };
      }),
    ),
  nations: protectedProcedure
    .input(
      worldInput
        .extend({
          by: z.enum(['cities', 'generals', 'power']),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      readWorld(ctx.db, input.worldId, async (tx) => {
        const snapshot = await tx.rankingSnapshot.findUnique({
          where: { worldId: input.worldId },
          select: { tick: true, year: true, month: true, nations: true },
        });
        if (!snapshot) return { items: [], at: null };
        return {
          items: rankNations(nationRows.parse(snapshot.nations), input.by).map(({ id, ...row }) => ({
            nationId: id,
            ...row,
          })),
          at: snapshotAt(snapshot),
        };
      }),
    ),
});
