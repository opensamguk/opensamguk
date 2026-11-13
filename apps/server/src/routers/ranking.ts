import { z } from 'zod';
import {
  isInactive,
  GENERAL_PROFICIENCY_FEATURE,
  LINEAGE_EXITED_YEAR,
  nationRank,
  nowTick,
  rankGenerals,
  rankNations,
  toGameDate,
} from '@opensamguk/rules';
import { protectedProcedure, router } from '../trpc';
import { readWorld, worldClock, worldInput } from '../queries';
import { possessedGenerals } from '../game/possessedGenerals';

const nationIdentity = z.object({ id: z.number().int(), name: z.string(), color: z.string() });
// 캐시에 내부 항목이 추가돼도 공개 허용 필드만 반환한다.
const generalRows = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    nation: nationIdentity.nullable(),
    dedication: z.number().int(),
    experience: z.number().int(),
    proficiency: z.record(z.string(), z.number().int().nonnegative()).optional(),
    wins: z.number().int().nonnegative(),
    captures: z.number().int().nonnegative(),
    stratagemSuccesses: z.number().int().nonnegative().default(0),
    battleStats: z
      .object({
        engagements: z.number().int().nonnegative(),
        winRate: z.number().min(0).max(1),
        kills: z.number().int().nonnegative(),
        killRate: z.number().nonnegative(),
        humanKills: z.number().int().nonnegative().optional(),
        humanKillRate: z.number().nonnegative().optional(),
      })
      .nullable()
      .default(null),
  }),
);
const nationRows = z.array(
  nationIdentity.extend({
    philosophy: z.string().optional(),
    level: z.number().int().optional(),
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
  heritage: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const worldId = world.id;
      const united = world.status === 'ENDED' && world.result?.reason === 'UNIFIED';
      const rank = async (kinds: string[], sort: 'asc' | 'desc') => {
        const totals = await tx.heritageEntry.groupBy({
          by: ['userId'],
          where: { worldId, kind: { in: kinds }, delta: sort === 'asc' ? { lt: 0 } : { gt: 0 } },
          _sum: { delta: true },
          orderBy: [{ _sum: { delta: sort } }, { userId: 'asc' }],
          take: 10,
        });
        const roster = united
          ? await tx.seasonGeneral.findMany({
              where: { worldId, userId: { in: totals.map(({ userId }) => userId) } },
              select: { userId: true, name: true, nationName: true },
              orderBy: { generalId: 'asc' },
            })
          : [];
        const players = new Map(roster.map((row) => [row.userId, row]));
        return totals.map(({ userId, _sum }, index) => {
          const general = players.get(userId);
          return {
            rank: index + 1,
            points: Math.abs(_sum.delta ?? 0),
            name: general?.name ?? null,
            nationName: general?.nationName ?? null,
          };
        });
      };
      const spent = await rank(['CREATION_SPEND', 'BENEFIT_SPEND'], 'asc');
      const earned = await rank(['SEASON_CREDIT'], 'desc');
      return { spent, earned, identitiesVisible: united };
    }),
  ),
  generals: protectedProcedure
    .input(
      worldInput
        .extend({
          by: z.enum([
            'dedication',
            'experience',
            'merit',
            'stratagem',
            'engagements',
            'winRate',
            'kills',
            'killRate',
            'humanKills',
            'humanKillRate',
            'proficiency1',
            'proficiency2',
            'proficiency3',
            'proficiency4',
            'proficiency5',
          ]),
          kind: z.enum(['all', 'human', 'npc']).default('all'),
          page: z.number().int().min(1).max(10_000).default(1),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      readWorld(ctx.db, input.worldId, async (tx, world) => {
        const snapshot = await tx.rankingSnapshot.findUnique({
          where: { worldId: input.worldId },
          select: { tick: true, year: true, month: true, generals: true },
        });
        const proficiencyEnabled = world.ruleFeatures.includes(GENERAL_PROFICIENCY_FEATURE);
        const feature = proficiencyEnabled ? { proficiencyEnabled: true as const } : {};
        if (!snapshot) return { top: [], me: null, at: null, pagination: null, ...feature };
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
        const possessed = await possessedGenerals(
          tx,
          input.worldId,
          [...identity].filter(([, general]) => general.isHuman).map(([id]) => id),
        );
        const candidates =
          kind === 'all' ? generals : generals.filter(({ id }) => identity.get(id)?.isHuman === (kind === 'human'));
        const byId = new Map(generals.map((row) => [row.id, row]));
        const sort = input.by;
        const base = sort === 'dedication' || sort === 'experience' || sort === 'merit';
        const value = (id: number) => {
          const row = byId.get(id)!;
          switch (sort) {
            case 'stratagem':
              return row.stratagemSuccesses;
            case 'proficiency1':
            case 'proficiency2':
            case 'proficiency3':
            case 'proficiency4':
            case 'proficiency5':
              return row.proficiency?.[sort.at(-1)!] ?? 0;
            case 'dedication':
            case 'experience':
            case 'merit':
              return 0;
            default:
              return row.battleStats?.[sort] ?? -1;
          }
        };
        const ranked = rankGenerals(candidates, base ? sort : 'merit');
        if (!base) ranked.sort((a, b) => value(b.id) - value(a.id) || a.id - b.id);
        const rows = ranked.map(({ id, ...row }, index) => ({
          ...row,
          generalId: id,
          rank: index + 1,
          stratagemSuccesses: byId.get(id)!.stratagemSuccesses,
          battleStats: byId.get(id)!.battleStats,
          ...(proficiencyEnabled ? { proficiency: byId.get(id)!.proficiency ?? {} } : {}),
          portraitId: identity.get(id)?.portraitId ?? null,
          isHuman: identity.get(id)?.isHuman ?? null,
          possessedNpc: possessed.has(id),
          ...(!base ? { value: Math.max(0, value(id)) } : {}),
        }));
        const viewer = await tx.general.findUnique({
          where: { worldId_userId: { worldId: input.worldId, userId: ctx.user.id } },
          select: { id: true },
        });
        const pageCount = Math.max(1, Math.ceil(rows.length / 100));
        const page = Math.min(input.page, pageCount);
        const top = rows.slice((page - 1) * 100, page * 100);
        const me = viewer ? (rows.find((row) => row.generalId === viewer.id) ?? null) : null;
        return {
          top,
          me,
          at: snapshotAt(snapshot),
          pagination: pageCount > 1 ? { page, pageCount } : null,
          ...feature,
        };
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
        const missingMetadata = nations
          .filter((nation) => nation.philosophy === undefined || nation.level === undefined)
          .map(({ id }) => id);
        const liveNations = missingMetadata.length
          ? await tx.nation.findMany({
              where: { worldId: input.worldId, id: { in: missingMetadata } },
              select: { id: true, philosophy: true, level: true },
            })
          : [];
        const liveById = new Map(liveNations.map((nation) => [nation.id, nation]));
        const metadata = new Map(
          nations.map((nation) => {
            const live = liveById.get(nation.id);
            const level = nation.level ?? live?.level;
            return [
              nation.id,
              {
                philosophy: nation.philosophy ?? live?.philosophy ?? null,
                rankTitle: level === undefined ? null : (nationRank(level)?.title ?? null),
              },
            ] as const;
          }),
        );
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
            ...(metadata.get(id) ?? { philosophy: null, rankTitle: null }),
            ...(forceByNation.has(id) ? { forceEstimate: forceByNation.get(id)! } : {}),
            ...row,
          })),
          at: snapshotAt(snapshot),
        };
      }),
    ),
});
