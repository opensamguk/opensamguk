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
} from '@opensamguk/rules';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { worldClock } from '../queries';

export async function scenarioTitle(key: string, db: Pick<Prisma.TransactionClient, 'gameResource'>): Promise<string> {
  try {
    const ref = parseResourceKey(key);
    const [resource] = await readPublishedResources(db, [{ kind: 'SCENARIO', ...ref }]);
    const value = scenarioIdentitySchema.parse(resource!.content);
    if (value.id !== ref.name) throw new Error();
    return value.title;
  } catch {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
  }
}

const presetNameSchema = z.object({ name: z.string().min(1) });
const statusOrder = { RUNNING: 0, PREOPEN: 1, PAUSED: 2, ENDED: 3 } as const;

export const lobbyRouter = router({
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
              ruleFeatures: true,
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
                async (key) => [key, await scenarioTitle(key, tx)] as const,
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
            const preset = world.preset === null ? null : presetNameSchema.safeParse(world.preset);
            if (preset && !preset.success) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
            return {
              id: world.id,
              name: world.name,
              status: world.status,
              presetName: preset?.success ? preset.data.name : null,
              scenarioTitle: scenarioTitles.get(world.scenarioKey)!,
              startYear: world.startYear,
              gameDate:
                world.status === 'ENDED' && world.result
                  ? { year: world.result.endedYear, month: world.result.endedMonth }
                  : toGameDate(world.startYear, nowTick(worldClock(world), ctx.now)),
              turnTermMinutes: world.turnTermMinutes,
              startedAt: world.startedAt?.toISOString() ?? null,
              humanGenerals: world._count.generals,
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
                    officerTitle:
                      world.ruleFeatures.includes('office-effects') && isLocalOffice(general.officerLevel)
                        ? localOfficeTitle(general.officerLevel)
                        : (officerTitle(general.officerLevel) ?? (general.nation ? '장수' : '재야')),
                    courtTitle: general.nation
                      ? (nationRank(general.nation.level)?.offices.find(
                          (office) => office.officerLevel === general.officerLevel,
                        )?.title ?? null)
                      : null,
                    cityName: general.city.name,
                    stats: {
                      leadership: general.leadership,
                      strength: general.strength,
                      intel: general.intel,
                      ...(world.ruleFeatures.includes('five-stats')
                        ? { politics: general.politics ?? 0, charm: general.charm ?? 0 }
                        : {}),
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
  hallOfFame: publicProcedure
    .input(
      z.strictObject({
        by: z.enum(['dedication', 'experience', 'merit']).default('merit'),
        worldId: z.string().min(1).max(64).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.$queryRaw<
        {
          generalId: number;
          name: string;
          nationName: string | null;
          value: bigint;
          worldId: string;
          worldName: string;
          scenarioKey: string;
          startedAt: Date | null;
          endedAt: Date;
          winnerName: string | null;
        }[]
      >`
        SELECT g."generalId", g.name, g."nationName", w.id AS "worldId", w.name AS "worldName", w."scenarioKey",
               w."startedAt", r."endedAt", r."winnerName",
               CASE ${input.by}
                 WHEN 'dedication' THEN g.dedication::bigint
                 WHEN 'experience' THEN g.experience::bigint
                 ELSE g.wins::bigint + g.captures::bigint
               END AS value
        FROM "SeasonGeneral" g
        JOIN "World" w ON w.id = g."worldId" AND w.status = 'ENDED'
        JOIN "WorldResult" r ON r."worldId" = w.id
        WHERE (${input.worldId ?? null}::text IS NULL OR w.id = ${input.worldId ?? null})
        ORDER BY value DESC, r."endedAt" DESC, w.id ASC, g."generalId" ASC
        LIMIT 20
      `;
      const titles = new Map(
        await Promise.all(
          [...new Set(rows.map((row) => row.scenarioKey))].map(
            async (key) => [key, await scenarioTitle(key, ctx.db)] as const,
          ),
        ),
      );
      return rows.map(({ scenarioKey, startedAt, endedAt, value, ...row }, index) => ({
        ...row,
        rank: index + 1,
        value: Number(value),
        scenarioTitle: titles.get(scenarioKey)!,
        startedAt: startedAt?.toISOString() ?? null,
        endedAt: endedAt.toISOString(),
      }));
    }),
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
