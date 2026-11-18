import { providedRuleKeys } from '@opensamguk/rules';
import { readPublishedResources, type Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import {
  creationBlock,
  effectiveWorldOptions,
  parsePreset,
  nowTick,
  isLocalOffice,
  localOfficeTitle,
  officerTitle,
  nationRank,
  scenarioIdentitySchema,
  toGameDate,
  parseResourceKey,
  HUMAN_GENERAL_LIMIT,
} from '@opensamguk/rules';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { worldClock, worldInput } from '../queries';
import { lobbyEntry, lobbySettings } from '../game/lobbySummary';
import { publicHeadlines } from '../game/publicHeadlines';

export async function scenarioTitle(key: string, db: Pick<Prisma.TransactionClient, 'gameResource'>): Promise<string> {
  return (await scenarioDetails(key, db)).title;
}

async function scenarioDetails(key: string, db: Pick<Prisma.TransactionClient, 'gameResource'>) {
  try {
    const ref = parseResourceKey(key);
    const [resource] = await readPublishedResources(db, [{ kind: 'SCENARIO', ...ref }]);
    const value = scenarioIdentitySchema
      .extend({ fiction: z.union([z.literal(0), z.literal(1)]).optional() })
      .parse(resource!.content);
    if (value.id !== ref.name) throw new Error();
    return value;
  } catch {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
  }
}

const presetNameSchema = z.object({ name: z.string().min(1) });
const statusOrder = { RUNNING: 0, PREOPEN: 1, PAUSED: 2, ENDED: 3 } as const;

export const lobbyRouter = router({
  headlines: publicProcedure
    .input(worldInput.extend({ limit: z.number().int().min(1).max(50).default(20) }).strict())
    .query(({ ctx, input }) =>
      ctx.db.$transaction((tx) => publicHeadlines(tx, input, ctx.now, ctx.publicMapConfig.delayMinutes), {
        isolationLevel: 'RepeatableRead',
      }),
    ),
  worlds: publicProcedure
    .input(z.strictObject({ includeEnded: z.boolean().optional() }).optional())
    .query(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) => {
          const worlds = await tx.world.findMany({
            where: input?.includeEnded ? {} : { status: { not: 'ENDED' } },
            select: {
              id: true,
              name: true,
              status: true,
              preset: true,
              runtimeOptions: true,
              replayFormat: true,

              statRules: true,
              scenarioKey: true,
              startYear: true,
              clockMode: true,
              clockTick: true,
              clockAnchorAt: true,
              turnTermMinutes: true,
              startedAt: true,
              createdAt: true,
              result: { select: { endedYear: true, endedMonth: true, winnerName: true, winnerColor: true } },
              _count: { select: { generals: { where: { userId: { not: null }, removedAt: null } } } },
            },
          });
          const ids = worlds.map((world) => world.id);
          const counts = await tx.general.groupBy({
            by: ['worldId'],
            where: { worldId: { in: ids }, userId: null, removedAt: null },
            _count: true,
          });
          const nationCounts = await tx.nation.groupBy({
            by: ['worldId'],
            where: { worldId: { in: ids } },
            _count: true,
          });
          const mine = ctx.user
            ? await tx.general.findMany({
                where: { worldId: { in: ids }, userId: ctx.user.id },
                select: {
                  worldId: true,
                  id: true,
                  name: true,
                  portraitId: true,
                  officerLevel: true,
                  leadership: true,
                  strength: true,
                  intel: true,
                  politics: true,
                  charm: true,
                  nation: { select: { name: true, color: true, level: true } },
                  city: { select: { name: true } },
                },
              })
            : [];
          const pending = ctx.user
            ? await tx.inputEvent.findMany({
                where: { worldId: { in: ids }, userId: ctx.user.id, kind: 'general.create', status: 'PENDING' },
                select: { worldId: true },
                distinct: ['worldId'],
              })
            : [];
          const byWorld = new Map(mine.map((general) => [general.worldId, general]));
          const pendingWorlds = new Set(pending.map((event) => event.worldId));
          const scenarioTitles = new Map(
            await Promise.all(
              [...new Set(worlds.map((world) => world.scenarioKey))].map(
                async (key) => [key, await scenarioDetails(key, tx)] as const,
              ),
            ),
          );
          worlds.sort(
            (a, b) =>
              statusOrder[a.status] - statusOrder[b.status] ||
              (b.startedAt ?? b.createdAt).getTime() - (a.startedAt ?? a.createdAt).getTime() ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
          return worlds.map((world) => {
            const general = byWorld.get(world.id);
            const options = effectiveWorldOptions(
              world.preset === null ? null : parsePreset(world.preset),
              world.runtimeOptions,
            );
            const npcGenerals = counts.find((row) => row.worldId === world.id)?._count ?? 0;
            const joinModes = lobbyEntry(world, options, world._count.generals, npcGenerals);
            const preset = world.preset === null ? null : presetNameSchema.safeParse(world.preset);
            if (preset && !preset.success) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
            return {
              id: world.id,
              name: world.name,
              status: world.status,
              presetName: preset?.success ? preset.data.name : null,
              scenarioTitle: scenarioTitles.get(world.scenarioKey)!.title,
              startYear: world.startYear,
              gameDate:
                world.status === 'ENDED' && world.result
                  ? { year: world.result.endedYear, month: world.result.endedMonth }
                  : toGameDate(world.startYear, nowTick(worldClock(world), ctx.now)),
              turnTermMinutes: world.turnTermMinutes,
              startedAt: world.startedAt?.toISOString() ?? null,
              humanGenerals: world._count.generals,
              capacity: HUMAN_GENERAL_LIMIT,
              registrationClosed: joinModes.length === 0,
              npcGenerals,
              nations: nationCounts.find((row) => row.worldId === world.id)?._count ?? 0,
              settingsSummary: lobbySettings(
                providedRuleKeys,
                options,
                world.statRules,
                scenarioTitles.get(world.scenarioKey)!.fiction,
              ),
              upcomingPreopen:
                world.status === 'PREOPEN'
                  ? {
                      preopenAt: world.createdAt.toISOString(),
                      openAt: null,
                      scenarioTitle: scenarioTitles.get(world.scenarioKey)!.title,
                      turnTermMinutes: world.turnTermMinutes,
                      startYear: world.startYear,
                    }
                  : null,
              joinModes,
              winner:
                world.status === 'ENDED' && world.result?.winnerName != null && world.result.winnerColor != null
                  ? { name: world.result.winnerName, color: world.result.winnerColor }
                  : null,
              ...(world.replayFormat === 3 &&
              effectiveWorldOptions(world.preset === null ? null : parsePreset(world.preset), world.runtimeOptions)
                .entry.npcPlay === 'on'
                ? { npcPlayEnabled: true as const }
                : {}),
              myGeneral: general
                ? {
                    id: general.id,
                    name: general.name,
                    nationName: general.nation?.name ?? null,
                    nationColor: general.nation?.color ?? null,
                    portraitId: general.portraitId,
                    officerTitle: isLocalOffice(general.officerLevel)
                      ? localOfficeTitle(general.officerLevel)
                      : (officerTitle(general.officerLevel) ?? (general.nation ? '장수' : '재야')),
                    courtTitle: general.nation
                      ? (nationRank(general.nation.level)?.offices.find(
                          (office) => office.officerLevel === general.officerLevel,
                        )?.title ?? null)
                      : null,
                    cityName: general.city?.name ?? '',
                    stats: {
                      leadership: general.leadership,
                      strength: general.strength,
                      intel: general.intel,
                      ...{ politics: general.politics ?? 0, charm: general.charm ?? 0 },
                    },
                  }
                : null,
              createBlockedReason:
                creationBlock({
                  status: world.status,
                  hasGeneral: general !== undefined,
                  hasPending: pendingWorlds.has(world.id),
                  humanCount: world._count.generals,
                  entryOpen:
                    effectiveWorldOptions(
                      world.preset === null ? null : parsePreset(world.preset),
                      world.runtimeOptions,
                    ).entry.generalCreation === 'open',
                })?.reason ?? null,
            };
          });
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ),
  notices: publicProcedure.input(z.undefined()).query(async ({ ctx }) => {
    const rows = await ctx.db.notice.findMany({
      where: { scope: 'LOBBY', worldId: null, hiddenAt: null },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { id: true, title: true, body: true, publishedAt: true },
    });
    return rows.map((row) => {
      if (row.title === null) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      return { id: row.id, title: row.title, body: row.body, publishedAt: row.publishedAt.toISOString() };
    });
  }),
});
