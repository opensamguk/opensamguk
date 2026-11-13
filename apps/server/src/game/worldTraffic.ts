import type { Prisma, PrismaClient } from '@opensamguk/db';
import { TICKS_PER_MONTH, toGameDate } from '@opensamguk/rules';

export async function recordWorldTraffic(
  db: PrismaClient,
  worldId: string,
  generalId: number,
  tick: number,
  now: number,
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
