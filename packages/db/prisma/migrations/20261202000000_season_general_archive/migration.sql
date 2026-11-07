-- T4-44 AC-P2-22 / FR-REC-03
BEGIN;

CREATE TABLE "SeasonGeneral" (
    "worldId" TEXT NOT NULL,
    "generalId" INTEGER NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "nationId" INTEGER,
    "nationName" TEXT,
    "nationColor" TEXT,
    "officerLevel" INTEGER NOT NULL,
    "dedication" INTEGER NOT NULL,
    "experience" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "captures" INTEGER NOT NULL,
    CONSTRAINT "SeasonGeneral_pkey" PRIMARY KEY ("worldId", "generalId"),
    CONSTRAINT "SeasonGeneral_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeasonGeneral_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "SeasonGeneral_userId_idx" ON "SeasonGeneral"("userId");

INSERT INTO "SeasonGeneral" ("worldId", "generalId", "userId", "name", "nationId", "nationName", "nationColor", "officerLevel", "dedication", "experience", "wins", "captures")
SELECT g."worldId", g."id", g."userId", g."name", n."id", n."name", n."color",
       g."officerLevel", g."dedication", g."experience", g."battleWins", g."captures"
FROM "WorldResult" AS r
JOIN "World" AS w ON w."id" = r."worldId" AND w."status" = 'ENDED'
JOIN "General" AS g ON g."worldId" = r."worldId"
LEFT JOIN "Nation" AS n ON n."worldId" = g."worldId" AND n."id" = g."nationId"
WHERE g."removedAt" IS NULL AND g."activeFromYear" <= r."endedYear";

COMMIT;
