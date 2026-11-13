import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import {
  courtOfficeTitle,
  nationRank,
  rankGenerals,
  reputationEventSchema,
  TICKS_PER_MONTH,
  toGameDate,
} from '@opensamguk/rules';
import { protectedProcedure, publicProcedure, router, worldVerifiedProcedure } from '../trpc';
import {
  beforeCursor,
  entityKey,
  page,
  readWorld,
  recordsInput,
  requireGeneral,
  seasonResultInfo,
  worldInput,
} from '../queries';
import { logInfo, logSelect, nationRecordInfo, worldRecordInfo } from '../visibility';
import { z } from 'zod';
import { decodeRecordCursor, encodeRecordCursor, generalLogCursor, recordId, recordTick } from '../recordCursor';
import { monthlyReviewSelect, readMonthlyReview } from '../review';
import { readWorldTraffic } from '../game/worldTraffic';

const generalInput = worldInput.extend({ cursor: z.string().min(1).max(256).optional() }).strict();
const activityInput = generalInput
  .extend({
    scope: z.enum(['all', 'world', 'biography']).default('all'),
    nationId: entityKey.optional(),
    period: z
      .strictObject({ year: z.number().int().min(0).max(9999), month: z.number().int().min(1).max(12) })
      .optional(),
  })
  .refine(({ nationId, scope }) => nationId === undefined || scope === 'world', {
    message: '국가별 기수 기록은 중원 정세에서 조회합니다.',
  });
const activityCursor = z.tuple([recordTick, z.enum(['reputation', 'nation', 'milestone']), recordId]);
const nationEventKind = z.enum(['found', 'fall', 'declare', 'capture', 'promotion', 'enlist', 'capital', 'transfer']);
const battleCursor = z.tuple([recordTick, entityKey]);

async function recordPortraits(tx: Prisma.TransactionClient, worldId: string, ids: number[]) {
  if (!ids.length) return new Map<number, number | null>();
  const generals = await tx.general.findMany({
    where: { worldId, id: { in: ids } },
    select: { id: true, portraitId: true },
  });
  return new Map(generals.map(({ id, portraitId }) => [id, portraitId]));
}

const seasonInput = worldInput.extend({ by: z.enum(['dedication', 'experience', 'merit']).default('dedication') });
const winnerSummarySchema = z.strictObject({
  level: z.number().int(),
  philosophy: z.string(),
  cities: z.number().int().nonnegative(),
  generals: z.number().int().nonnegative(),
  power: z.number().int().nonnegative(),
  population: z.number().int().nonnegative(),
  populationMax: z.number().int().nonnegative(),
  gold: z.number().int().nonnegative(),
  rice: z.number().int().nonnegative(),
});
const finalNationSchema = z.object({
  nationId: entityKey,
  name: z.string(),
  color: z.string(),
  philosophy: z.string(),
  level: z.number().int(),
  tech: z.number().nonnegative(),
  troops: z.number().int().nonnegative(),
  roster: z.array(z.object({ generalId: entityKey, name: z.string(), portraitId: z.number().int().nullable() })),
});
const traitCounts = z.array(z.strictObject({ name: z.string().min(1), count: z.number().int().positive() }));
const traitDistributionSchema = z.strictObject({
  philosophies: traitCounts,
  personalities: traitCounts,
  specialties: traitCounts,
});
const battlePhases = z.array(
  z.object({
    kind: z.enum(['volley', 'hold', 'exchange']),
    opponent: z.string().optional(),
    attackerLoss: z.number().int().nonnegative(),
    defenderLoss: z.number().int().nonnegative(),
    attackerEvaded: z.boolean().optional(),
    defenderEvaded: z.boolean().optional(),
    attackerCritical: z.boolean().optional(),
    defenderCritical: z.boolean().optional(),
    attackerTactic: z.object({ name: z.string(), success: z.boolean() }).optional(),
    defenderTactic: z.object({ name: z.string(), success: z.boolean() }).optional(),
  }),
);

export const recordsRouter = router({
  traffic: publicProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      readWorld(ctx.db, input.worldId, (tx, world) => readWorldTraffic(tx, world.id, world.startYear)),
    ),
  battles: protectedProcedure.input(generalInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, battleCursor);
      const rows = await tx.battleLog.findMany({
        where: {
          worldId: input.worldId,
          generalId: general.id,
          ...(cursor ? { OR: [{ tick: { lt: cursor[0] } }, { tick: cursor[0], attackerId: { lt: cursor[1] } }] } : {}),
        },
        orderBy: [{ tick: 'desc' }, { attackerId: 'desc' }],
        take: 31,
        select: { tick: true, attackerId: true, text: true, phases: true },
      });
      const page = rows.slice(0, 30);
      const portraits = await recordPortraits(
        tx,
        input.worldId,
        page.map(({ attackerId }) => attackerId),
      );
      const items = page.map((row) => ({
        tick: row.tick,
        attackerId: row.attackerId,
        portraitId: portraits.get(row.attackerId) ?? null,
        text: row.text,
        ...(row.phases === null ? {} : { phases: battlePhases.parse(row.phases) }),
        gameDate: toGameDate(world.startYear, row.tick),
      }));
      const last = items.at(-1);
      return { items, nextCursor: rows.length > 30 && last ? encodeRecordCursor([last.tick, last.attackerId]) : null };
    }),
  ),
  activity: protectedProcedure.input(activityInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, activityCursor);
      if (input.nationId !== undefined && !seasonResultInfo(world))
        throw new TRPCError({ code: 'NOT_FOUND', message: '기수 결과가 없습니다.' });
      const biography = input.scope === 'biography' ? await requireGeneral(tx, input.worldId, ctx.user.id) : null;
      const start = input.period
        ? ((input.period.year - world.startYear) * 12 + input.period.month - 1) * TICKS_PER_MONTH
        : null;
      if (start !== null && (start < 0 || start > 2_147_483_647 - TICKS_PER_MONTH))
        return { items: [], nextCursor: null };
      const period = start === null ? {} : { AND: [{ tick: { gte: start, lt: start + TICKS_PER_MONTH } }] };
      const sourceOrder = { reputation: 0, nation: 1, milestone: 2 };
      const before = (source: keyof typeof sourceOrder) => {
        if (!cursor) return {};
        const [tick, cursorSource, id] = cursor;
        if (source !== cursorSource)
          return { tick: sourceOrder[source] > sourceOrder[cursorSource] ? { lte: tick } : { lt: tick } };
        return { OR: [{ tick: { lt: tick } }, { tick, id: { lt: BigInt(id) } }] };
      };
      const rows =
        input.scope === 'world'
          ? []
          : await tx.reputationEvent.findMany({
              where: {
                worldId: input.worldId,
                ...period,
                ...before('reputation'),
                ...(biography ? { generalId: biography.id, kind: { in: ['conquest', 'victory'] } } : {}),
              },
              orderBy: [{ tick: 'desc' }, { id: 'desc' }],
              take: 31,
              select: {
                id: true,
                generalId: true,
                year: true,
                month: true,
                kind: true,
                score: true,
                tick: true,
                generalName: true,
                nationId: true,
                nationName: true,
                nationColor: true,
                cityKey: true,
                cityName: true,
              },
            });
      const news = biography
        ? []
        : await tx.publicNationEvent.findMany({
            where: {
              worldId: input.worldId,
              ...period,
              ...before('nation'),
              ...(input.nationId !== undefined
                ? { nationIds: { has: input.nationId } }
                : input.scope === 'world'
                  ? { kind: { not: 'enlist' } }
                  : {}),
            },
            orderBy: [{ tick: 'desc' }, { id: 'desc' }],
            take: 31,
            select: { id: true, tick: true, kind: true, text: true },
          });
      const milestones = biography
        ? await tx.generalLog.findMany({
            where: {
              worldId: input.worldId,
              generalId: biography.id,
              kind: 'success',
              commandKey: { in: ['join', 'accept_invite', 'found', 'uprising', 'personnel.appoint'] },
              ...period,
              ...before('milestone'),
            },
            orderBy: [{ tick: 'desc' }, { id: 'desc' }],
            take: 31,
            select: { id: true, tick: true, commandKey: true, text: true },
          })
        : [];
      const reputation = rows.map((row) => {
        const { id, generalName, nationId, nationName, nationColor, cityKey, cityName, ...event } = row;
        return {
          id: id.toString(),
          source: 'reputation' as const,
          ...reputationEventSchema.parse({
            ...event,
            data: {
              name: generalName,
              nation: nationId === null ? null : { id: nationId, name: nationName, color: nationColor },
              city: cityKey === null ? null : { cityKey, name: cityName },
            },
          }),
        };
      });
      const nation = news.map(({ id, tick, kind, text }) => ({
        source: 'nation' as const,
        id: id.toString(),
        tick,
        ...toGameDate(world.startYear, tick),
        kind: nationEventKind.parse(kind),
        text,
      }));
      // 각 원장은 이미 같은 tick에서 id 내림차순이다. 같은 tick은 평판 원장을 먼저 읽는다.
      const history = milestones.map(({ id, tick, commandKey, text }) => ({
        source: 'milestone' as const,
        id: id.toString(),
        tick,
        ...toGameDate(world.startYear, tick),
        kind: commandKey,
        text,
      }));
      const sorted = [...reputation, ...nation, ...history].sort((a, b) => b.tick - a.tick);
      const page = sorted.slice(0, 30);
      const portraits = await recordPortraits(
        tx,
        input.worldId,
        page.flatMap((item) => (item.source === 'reputation' ? [item.generalId] : [])),
      );
      const items = page.map((item) => ({
        ...item,
        portraitId: item.source === 'reputation' ? (portraits.get(item.generalId) ?? null) : null,
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor: sorted.length > 30 && last ? encodeRecordCursor([last.tick, last.source, last.id]) : null,
      };
    }),
  ),
  season: worldVerifiedProcedure.input(seasonInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const result = seasonResultInfo(world);
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: '기수 결과가 없습니다.' });
      const rows = await tx.seasonGeneral.findMany({
        where: { worldId: input.worldId },
        select: {
          generalId: true,
          name: true,
          nationId: true,
          nationName: true,
          nationColor: true,
          officerLevel: true,
          stratagemSuccesses: true,
          dedication: true,
          experience: true,
          wins: true,
          captures: true,
        },
      });
      const archived = new Map(
        rows.map(({ generalId, officerLevel, stratagemSuccesses }) => [
          generalId,
          { officerLevel, stratagemSuccesses },
        ]),
      );
      const generals = rankGenerals(
        rows.map(({ generalId, name, nationId, nationName, nationColor, dedication, experience, wins, captures }) => ({
          id: generalId,
          name,
          dedication,
          experience,
          wins,
          captures,
          nation: nationId === null ? null : { id: nationId, name: nationName!, color: nationColor! },
        })),
        input.by,
      ).map(({ id, ...row }) => ({ generalId: id, ...row, ...archived.get(id)! }));
      const stats = winnerSummarySchema.safeParse(world.result?.winnerSummary).data;
      const winner = result.winner;
      const topStratagem = winner
        ? rows
            .filter((row) => row.nationId === winner.nationId && row.stratagemSuccesses > 0)
            .sort((a, b) => b.stratagemSuccesses - a.stratagemSuccesses || a.generalId - b.generalId)
            .slice(0, 7)
            .map(({ generalId, name, stratagemSuccesses }) => ({ generalId, name, successes: stratagemSuccesses }))
        : [];
      const winnerSummary =
        winner && stats
          ? {
              ...stats,
              officers: rows
                .filter((row) => row.nationId === winner.nationId && row.officerLevel >= 5)
                .sort((a, b) => b.officerLevel - a.officerLevel || a.generalId - b.generalId)
                .map(({ name, officerLevel }) => ({
                  name,
                  officerLevel,
                  title: courtOfficeTitle(stats.level, officerLevel),
                })),
            }
          : null;
      const history = await tx.yearbookSnapshot.findMany({
        where: { worldId: input.worldId },
        orderBy: { tick: 'asc' },
        select: {
          nations: {
            orderBy: { nationId: 'asc' },
            select: { nationId: true, name: true, color: true, power: true, troops: true },
          },
          tick: true,
          data: true,
          activeGenerals: true,
        },
      });
      const removed = await tx.removedNation.findMany({
        where: { worldId: input.worldId },
        orderBy: { nationId: 'asc' },
        select: { nationId: true, name: true, color: true, removedTick: true, finalSummary: true },
      });
      const finalNations = z.array(finalNationSchema).safeParse(world.result?.finalNations).data ?? [];
      const nationNames = new Map(removed.map(({ nationId, name }) => [nationId, name]));
      for (const month of history) for (const nation of month.nations) nationNames.set(nation.nationId, nation.name);
      for (const row of rows)
        if (row.nationId !== null && row.nationName) nationNames.set(row.nationId, row.nationName);
      for (const { nationId, name } of finalNations) nationNames.set(nationId, name);
      const cityNames = new Map(
        (
          await tx.city.findMany({
            where: { worldId: input.worldId, OR: [{ kind: null }, { kind: { not: 'PASS' } }] },
            select: { cityKey: true, name: true },
          })
        ).map(({ cityKey, name }) => [cityKey, name]),
      );
      type NationArchive = {
        nationId: number;
        name: string;
        color: string | null;
        removedTick: number | null;
        peakCities: number | null;
        peakPower: number | null;
        peakTroops: number | null;
        final: (z.infer<typeof finalNationSchema> & { title: string | null }) | null;
        recordedAtTick: number | null;
        recordedAt: { year: number; month: number } | null;
        cities: { cityKey: number; name: string }[];
        finalGenerals: number;
      };
      const nationArchive = new Map<number, NationArchive>();
      for (const [nationId, name] of nationNames)
        nationArchive.set(nationId, {
          nationId,
          name,
          color: null,
          removedTick: null,
          peakCities: null,
          peakPower: null,
          peakTroops: null,
          final: null,
          recordedAtTick: null,
          recordedAt: null,
          cities: [],
          finalGenerals: 0,
        });
      const applyFinal = (summary: z.infer<typeof finalNationSchema>, tick: number) => {
        const nation = nationArchive.get(summary.nationId)!;
        nation.color = summary.color;
        nation.recordedAtTick = tick;
        nation.final = { ...summary, title: nationRank(summary.level)?.title ?? null };
        nation.finalGenerals = summary.roster.length;
        nation.peakTroops = Math.max(nation.peakTroops ?? 0, summary.troops);
      };
      for (const row of removed) {
        const nation = nationArchive.get(row.nationId)!;
        nation.color = row.color;
        nation.removedTick = row.removedTick;
        const summary = finalNationSchema.safeParse(row.finalSummary).data;
        if (summary?.nationId === row.nationId) applyFinal(summary, row.removedTick);
      }
      for (const row of rows) {
        if (row.nationId === null || !row.nationName) continue;
        const nation = nationArchive.get(row.nationId)!;
        nation.color = row.nationColor;
        if (nation.final === null) nation.finalGenerals++;
      }
      const final = { nations: result.remainingNations, generals: rows.length };
      const peak = { nations: final.nations, affiliatedGenerals: rows.filter((row) => row.nationId !== null).length };
      let peakGenerals: number | undefined;
      for (const month of history) {
        if (month.activeGenerals !== null)
          peakGenerals = Math.max(peakGenerals ?? final.generals, month.activeGenerals);
        for (const row of month.nations) {
          const nation = nationArchive.get(row.nationId)!;
          nation.color ??= row.color;
          if (nation.final === null) nation.recordedAtTick = month.tick;
          if (row.power !== null) nation.peakPower = Math.max(nation.peakPower ?? 0, row.power);
          if (row.troops !== null) nation.peakTroops = Math.max(nation.peakTroops ?? 0, row.troops);
        }
        if (typeof month.data !== 'object' || month.data === null || !('nations' in month.data)) continue;
        const { nations, cities } = worldRecordInfo(month.data);
        const citiesByNation = new Map<number, number[]>();
        for (const { nationId, cityKey } of cities) {
          if (nationId === null || !cityNames.has(cityKey)) continue;
          const keys = citiesByNation.get(nationId) ?? [];
          keys.push(cityKey);
          citiesByNation.set(nationId, keys);
        }
        for (const row of nations) {
          const nation = nationArchive.get(row.nationId);
          if (!nation || (nation.peakCities !== null && row.cities <= nation.peakCities)) continue;
          nation.peakCities = row.cities;
          nation.cities = (citiesByNation.get(row.nationId) ?? [])
            .sort((a, b) => a - b)
            .map((cityKey) => ({ cityKey, name: cityNames.get(cityKey)! }));
        }
        peak.nations = Math.max(peak.nations, nations.filter(({ cities }) => cities > 0).length);
        peak.affiliatedGenerals = Math.max(
          peak.affiliatedGenerals,
          nations.reduce((total, nation) => total + nation.generals, 0),
        );
      }
      for (const summary of finalNations) {
        applyFinal(summary, world.result!.endedTick);
        nationArchive.get(summary.nationId)!.recordedAt = { year: result.year, month: result.month };
      }
      for (const nation of nationArchive.values()) {
        if (!nation.recordedAt && nation.recordedAtTick !== null) {
          const tick = nation.final ? nation.recordedAtTick : Math.max(0, nation.recordedAtTick - 1);
          nation.recordedAt = toGameDate(world.startYear, tick);
        }
      }
      const traits = traitDistributionSchema.safeParse(world.result?.traitDistribution).data;
      if (traits && history.length === 0) peakGenerals = final.generals;
      return {
        result,
        generals,
        winnerSummary,
        topStratagem,
        nations: [...nationArchive.values()].sort((a, b) => a.nationId - b.nationId),
        statistics: {
          final,
          peak: {
            ...peak,
            ...(peakGenerals === undefined ? {} : { generals: peakGenerals }),
          },
          nationNames: [...nationNames.values()],
          ...(traits ? { traits } : {}),
        },
      };
    }),
  ),
  general: protectedProcedure.input(generalInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      // 기존 숫자 커서도 받고 새 응답은 같은 tick의 행까지 이어 읽는다.
      const legacy = recordsInput.shape.cursor.safeParse(input.cursor);
      const cursor =
        input.cursor === undefined || legacy.success ? null : decodeRecordCursor(input.cursor, generalLogCursor);
      const logs = await tx.generalLog.findMany({
        where: {
          worldId: input.worldId,
          generalId: general.id,
          ...(cursor
            ? { OR: [{ tick: { lt: cursor[0] } }, { tick: cursor[0], id: { lt: BigInt(cursor[1]) } }] }
            : beforeCursor(input.cursor)),
        },
        orderBy: [{ tick: 'desc' }, { id: 'desc' }],
        take: 31,
        select: logSelect,
      });
      const items = logs.slice(0, 30).map(logInfo);
      return {
        items,
        nextCursor: logs.length > 30 ? encodeRecordCursor([items.at(-1)!.tick, items.at(-1)!.id]) : null,
      };
    }),
  ),
  nation: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      if (general.nationId === null) return { items: [], nextCursor: null };
      const history = await tx.nationHistory.findMany({
        where: {
          worldId: input.worldId,
          nationId: general.nationId,
          // 사건 전용 JSON은 LIMIT 적용 전에 제외한다. 월간 요약의 nationId만 조회한다.
          data: { path: ['nationId'], equals: general.nationId },
          ...beforeCursor(input.cursor),
        },
        orderBy: { tick: 'desc' },
        take: 31,
        select: { tick: true, data: true },
      });
      return page(history.map((row) => ({ tick: row.tick, ...nationRecordInfo(row.data) })));
    }),
  ),
  nationEvents: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      if (general.nationId === null || general.removedAt !== null) return { items: [], nextCursor: null };
      const events = await tx.nationHistory.findMany({
        where: {
          worldId: input.worldId,
          nationId: general.nationId,
          AND: [
            { data: { path: ['events'], array_contains: [] } },
            { NOT: { data: { path: ['events'], equals: [] } } },
          ],
          ...beforeCursor(input.cursor),
        },
        orderBy: { tick: 'desc' },
        take: 31,
        select: { tick: true, data: true },
      });
      return page(
        events.map(({ tick, data }) => ({
          tick,
          events: z.object({ events: z.array(z.string()) }).parse(data).events,
        })),
      );
    }),
  ),
  world: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const history = await tx.yearbookSnapshot.findMany({
        where: { worldId: input.worldId, ...beforeCursor(input.cursor) },
        orderBy: { tick: 'desc' },
        take: 31,
        select: {
          tick: true,
          year: true,
          month: true,
          data: true,
          nations: { select: { nationId: true, power: true } },
        },
      });
      const reviews =
        world.ruleFeatures.includes('reputation-v1') && history.length
          ? await tx.monthlyReview.findMany({
              where: { worldId: input.worldId, tick: { in: history.map((row) => row.tick) } },
              select: monthlyReviewSelect,
            })
          : [];
      const headlines = new Map(
        reviews.map((row) => {
          const review = readMonthlyReview(row, world.startYear);
          return [review.tick, review.headline];
        }),
      );
      return page(
        history.map((row) => ({
          tick: row.tick,
          year: row.year,
          month: row.month,
          ...worldRecordInfo(row.data, row.nations),
          ...(headlines.get(row.tick) ? { review: { headline: headlines.get(row.tick)! } } : {}),
        })),
      );
    }),
  ),
});
