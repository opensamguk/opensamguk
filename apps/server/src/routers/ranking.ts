import { z } from 'zod';
import { isInactive, LINEAGE_EXITED_YEAR, nowTick, rankGenerals, rankNations, toGameDate } from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { readWorld, worldClock, worldInput } from '../queries';

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
    battleStats: z
      .object({
        engagements: z.number().int().nonnegative(),
        winRate: z.number().min(0).max(1),
        kills: z.number().int().nonnegative(),
        killRate: z.number().nonnegative(),
      })
      .nullable()
      .default(null),
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
const emptyForce = () => ({
  totalGeneralCount: 0,
  userCombatGeneralCount: 0,
  userTroops: 0,
  npcCombatGeneralCount: 0,
  npcTroops: 0,
  inactiveGeneralCount: 0,
});

export const rankingRouter = router({
  generals: protectedProcedure
    .input(
      worldInput
        .extend({
          by: z.enum(['dedication', 'experience', 'merit', 'stratagem', 'engagements', 'winRate', 'kills', 'killRate']),
          kind: z.enum(['all', 'human', 'npc']).default('all'),
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
        const identity = new Map(
          (
            await tx.general.findMany({
              where: { worldId: input.worldId, id: { in: generals.map(({ id }) => id) } },
              select: { id: true, portraitId: true, userId: true },
            })
          ).map(({ id, portraitId, userId }) => [id, { portraitId, isHuman: userId !== null }]),
        );
        const kind = input.kind;
        const candidates =
          kind === 'all' ? generals : generals.filter(({ id }) => identity.get(id)?.isHuman === (kind === 'human'));
        const byId = new Map(generals.map((row) => [row.id, row]));
        const sort = input.by;
        const base = sort === 'dedication' || sort === 'experience' || sort === 'merit';
        const value = (id: number) => {
          const row = byId.get(id)!;
          return sort === 'stratagem' ? row.stratagemSuccesses : base ? 0 : (row.battleStats?.[sort] ?? -1);
        };
        const ranked = rankGenerals(candidates, base ? sort : 'merit');
        if (!base) ranked.sort((a, b) => value(b.id) - value(a.id) || a.id - b.id);
        const rows = ranked.map(({ id, ...row }, index) => ({
          ...row,
          generalId: id,
          rank: index + 1,
          stratagemSuccesses: byId.get(id)!.stratagemSuccesses,
          battleStats: byId.get(id)!.battleStats,
          portraitId: identity.get(id)?.portraitId ?? null,
          isHuman: identity.get(id)?.isHuman ?? null,
          ...(!base ? { value: Math.max(0, value(id)) } : {}),
        }));
        const viewer = await tx.general.findUnique({
          where: { worldId_userId: { worldId: input.worldId, userId: ctx.user.id } },
          select: { id: true },
        });
        const top = rows.slice(0, 100);
        const me = viewer ? (rows.find((row) => row.generalId === viewer.id) ?? null) : null;
        return { top, me, at: snapshotAt(snapshot) };
      }),
    ),
  freeGenerals: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const year = toGameDate(world.startYear, world.clockTick).year;
      const items = await tx.general.findMany({
        where: {
          worldId: world.id,
          nationId: null,
          removedAt: null,
          activeFromYear: { lte: year, not: LINEAGE_EXITED_YEAR },
        },
        select: { id: true, name: true, portraitId: true, userId: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      return {
        count: items.length,
        items: items.map(({ userId, ...general }) => ({ ...general, isHuman: userId !== null })),
      };
    }),
  ),
  nations: protectedProcedure
    .input(
      worldInput
        .extend({
          by: z.enum(['cities', 'generals', 'power']),
          includeForceEstimate: z.boolean().optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      readWorld(ctx.db, input.worldId, async (tx, world) => {
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
        const forceByNation = new Map<number, ReturnType<typeof emptyForce>>();
        if (input.includeForceEstimate && world.status !== 'ENDED') {
          const tick = nowTick(worldClock(world), ctx.now);
          const { year } = toGameDate(world.startYear, tick);
          const generals = await tx.general.findMany({
            where: {
              worldId: input.worldId,
              nationId: { in: nations.map(({ id }) => id) },
              removedAt: null,
              activeFromYear: { lte: year, not: LINEAGE_EXITED_YEAR },
            },
            select: { nationId: true, userId: true, leadership: true, lastActiveTick: true },
          });
          for (const { id } of nations) forceByNation.set(id, emptyForce());
          for (const general of generals) {
            const force = forceByNation.get(general.nationId!)!;
            force.totalGeneralCount++;
            const human = general.userId !== null;
            if (
              human &&
              general.lastActiveTick !== null &&
              isInactive(general.lastActiveTick, tick, world.turnTermMinutes)
            ) {
              force.inactiveGeneralCount++;
              continue;
            }
            // core2026 c81d304, world/directory.ts. The combat groups share the leadership cutoff.
            if (general.leadership < 40) continue;
            if (human) {
              force.userCombatGeneralCount++;
              force.userTroops += general.leadership * 100;
            } else {
              force.npcCombatGeneralCount++;
              force.npcTroops += general.leadership * 100;
            }
          }
        }
        return {
          items: rankNations(nations, input.by).map(({ id, ...row }) => ({
            nationId: id,
            philosophy: philosophy.get(id) ?? null,
            ...(forceByNation.has(id) ? { forceEstimate: forceByNation.get(id)! } : {}),
            ...row,
          })),
          at: snapshotAt(snapshot),
        };
      }),
    ),
});
