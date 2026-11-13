import type { Prisma, PrismaClient } from '@opensamguk/db';
import { TICKS_PER_MONTH, toGameDate } from '@opensamguk/rules';

export async function recordWorldTraffic(
  db: PrismaClient,
  worldId: string,
  generalId: number,
  tick: number,
  now: number,
  turnTermMinutes: number,
) {
  const monthTick = Math.floor(tick / TICKS_PER_MONTH) * TICKS_PER_MONTH;
  const at = new Date(now);
  // One row per visiting general and game month. Upsert makes concurrent refreshes count once each.
  await db.$executeRaw`
    INSERT INTO "WorldTrafficMonthly" ("worldId", "monthTick", "generalId", "firstAt", "lastAt")
    VALUES (${worldId}, ${monthTick}, ${generalId}, ${at}, ${at})
    ON CONFLICT ("worldId", "monthTick", "generalId") DO UPDATE SET
      "refresh" = "WorldTrafficMonthly"."refresh" + 1,
      "firstAt" = LEAST("WorldTrafficMonthly"."firstAt", EXCLUDED."firstAt"),
      "lastAt" = GREATEST("WorldTrafficMonthly"."lastAt", EXCLUDED."lastAt")
  `;
  const [score = { current: 0, total: 0 }] = await db.$queryRaw<{ total: number; current: number }[]>`
    SELECT COALESCE(SUM("refresh"), 0)::double precision AS total,
           COALESCE(SUM("refresh") FILTER (WHERE "monthTick" = ${monthTick}), 0)::double precision AS current
    FROM "WorldTrafficMonthly"
    WHERE "worldId" = ${worldId} AND "generalId" = ${generalId}
  `;
  const limit = Math.round(turnTermMinutes ** 0.6 * 3) * 10;
  const labels = ['안함', '무관심', '보통', '가끔', '자주', '열심', '중독', '폐인', '경고'];
  const grade =
    labels[[50, 100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800].findIndex((cutoff) => score.total < cutoff)] ??
    '매우 잦음';
  const level = score.current > limit ? 2 : score.current > limit * 0.9 ? 1 : 0;
  return { ...score, grade, level, limit };
}

export async function readWorldTraffic(tx: Prisma.TransactionClient, worldId: string, startYear: number) {
  const rows = await tx.$queryRaw<
    {
      monthTick: number;
      firstAt: Date;
      lastAt: Date;
      refresh: number;
      visitors: number;
      maxRefresh: number;
      maxVisitors: number;
    }[]
  >`
    WITH months AS (
      SELECT "monthTick", MIN("firstAt") AS "firstAt", MAX("lastAt") AS "lastAt",
             SUM("refresh")::double precision AS refresh, COUNT(*)::double precision AS visitors
      FROM "WorldTrafficMonthly"
      WHERE "worldId" = ${worldId}
      GROUP BY "monthTick"
    )
    SELECT months.*, MAX(refresh) OVER () AS "maxRefresh", MAX(visitors) OVER () AS "maxVisitors"
    FROM months
    ORDER BY "monthTick" DESC
    LIMIT 6
  `;
  return {
    periods: rows.map(({ monthTick, firstAt, lastAt, refresh, visitors }) => ({
      ...toGameDate(startYear, monthTick),
      firstAt: firstAt.toISOString(),
      lastAt: lastAt.toISOString(),
      refresh,
      visitors,
    })),
    maxRefresh: rows[0]?.maxRefresh ?? 0,
    maxVisitors: rows[0]?.maxVisitors ?? 0,
  };
}
