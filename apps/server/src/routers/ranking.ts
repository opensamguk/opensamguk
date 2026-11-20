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
    stratagemSuccesses: z.number().int().nonnegative().default(0),
  }),
);
const nationRows = z.array(
  nationIdentity.extend({
    philosophy: z.string().optional(),
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
          by: z.enum(['dedication', 'experience', 'merit', 'stratagem']),
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
        const generals = generalRows.parse(snapshot.generals);
        const successes = new Map(generals.map(({ id, stratagemSuccesses }) => [id, stratagemSuccesses]));
        const ranked = rankGenerals(generals, input.by === 'stratagem' ? 'merit' : input.by);
        if (input.by === 'stratagem') ranked.sort((a, b) => successes.get(b.id)! - successes.get(a.id)! || a.id - b.id);
        const rows = ranked.map(({ id, ...row }, index) => ({
          ...row,
          generalId: id,
          rank: index + 1,
          stratagemSuccesses: successes.get(id)!,
          ...(input.by === 'stratagem' ? { value: successes.get(id)! } : {}),
        }));
        const viewer = await tx.general.findUnique({
          where: { worldId_userId: { worldId: input.worldId, userId: ctx.user.id } },
          select: { id: true },
        });
        const top = rows.slice(0, 100);
        const me = viewer ? (rows.find((row) => row.generalId === viewer.id) ?? null) : null;
        const ids = top.map((row) => row.generalId);
        if (me) ids.push(me.generalId);
        const portraits = new Map(
          (
            await tx.general.findMany({
              where: { worldId: input.worldId, id: { in: ids } },
              select: { id: true, portraitId: true },
            })
          ).map(({ id, portraitId }) => [id, portraitId]),
        );
        const withPortrait = (row: (typeof rows)[number]) => ({
          ...row,
          portraitId: portraits.get(row.generalId) ?? null,
        });
        return {
          top: top.map(withPortrait),
          me: me ? withPortrait(me) : null,
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
        const nations = nationRows.parse(snapshot.nations);
        const missingPhilosophy = nations.filter((nation) => nation.philosophy === undefined).map(({ id }) => id);
        const liveNations = missingPhilosophy.length
          ? await tx.nation.findMany({
              where: { worldId: input.worldId, id: { in: missingPhilosophy } },
              select: { id: true, philosophy: true },
            })
          : [];
        const philosophy = new Map(liveNations.map((nation) => [nation.id, nation.philosophy]));
        for (const nation of nations) if (nation.philosophy !== undefined) philosophy.set(nation.id, nation.philosophy);
        return {
          items: rankNations(nations, input.by).map(({ id, ...row }) => ({
            nationId: id,
            philosophy: philosophy.get(id) ?? null,
            ...row,
          })),
          at: snapshotAt(snapshot),
        };
      }),
    ),
});
