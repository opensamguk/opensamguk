import type { Prisma } from '@opensamguk/db';

export async function persistSeasonArchive(tx: Prisma.TransactionClient, worldId: string, endedYear: number) {
  await tx.$executeRaw`
    INSERT INTO "SeasonGeneral" ("worldId", "generalId", "userId", "name", "nationId", "nationName", "nationColor", "officerLevel", "dedication", "experience", "wins", "captures", "stratagemSuccesses")
    SELECT g."worldId", g."id", g."userId", g."name", n."id", n."name", n."color",
           g."officerLevel", g."dedication", g."experience", g."battleWins", g."captures", g."stratagemSuccesses"
    FROM "General" AS g
    LEFT JOIN "Nation" AS n ON n."worldId" = g."worldId" AND n."id" = g."nationId"
    WHERE g."worldId" = ${worldId} AND g."removedAt" IS NULL AND g."activeFromYear" <= ${endedYear}
  `;
}
