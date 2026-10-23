import { readFile } from 'node:fs/promises';
import { TRPCError } from '@trpc/server';
import { creationBlock, nowTick, scenarioSchema, toGameDate } from '@opensamguk/rules';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

const scenarioRoot = new URL('../../../../resources/scenario/', import.meta.url);
const titleSchema = scenarioSchema.pick({ id: true, title: true });
const titles = new Map<string, string>();

export async function scenarioTitle(key: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(key) || key === 'default') throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
  const cached = titles.get(key);
  if (cached !== undefined) return cached;
  try {
    const value = titleSchema.parse(JSON.parse(await readFile(new URL(`${key}.json`, scenarioRoot), 'utf8')));
    if (value.id !== key) throw new Error();
    titles.set(key, value.title);
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
              scenarioKey: true,
              startYear: true,
              clockMode: true,
              clockTick: true,
              clockAnchorAt: true,
              turnTermMinutes: true,
              startedAt: true,
              createdAt: true,
              result: { select: { endedYear: true, endedMonth: true } },
              _count: { select: { generals: { where: { userId: { not: null } } } } },
            },
          });
          const ids = worlds.map((world) => world.id);
          const mine = ctx.user
            ? await tx.general.findMany({
                where: { worldId: { in: ids }, userId: ctx.user.id },
                select: { worldId: true, id: true, name: true, nation: { select: { name: true } } },
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
                async (key) => [key, await scenarioTitle(key)] as const,
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
                  : toGameDate(
                      world.startYear,
                      nowTick({ ...world, clockAnchorAt: world.clockAnchorAt?.getTime() ?? null }, ctx.now),
                    ),
              turnTermMinutes: world.turnTermMinutes,
              startedAt: world.startedAt?.toISOString() ?? null,
              humanGenerals: world._count.generals,
              myGeneral: general
                ? { id: general.id, name: general.name, nationName: general.nation?.name ?? null }
                : null,
              createBlockedReason:
                creationBlock({
                  status: world.status,
                  hasGeneral: general !== undefined,
                  hasPending: pendingWorlds.has(world.id),
                })?.reason ?? null,
            };
          });
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ),
  notices: publicProcedure.input(z.undefined()).query(async ({ ctx }) => {
    const rows = await ctx.db.notice.findMany({
      where: { scope: 'LOBBY', worldId: null },
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
