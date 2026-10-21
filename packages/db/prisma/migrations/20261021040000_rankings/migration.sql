ALTER TABLE "General"
  ADD COLUMN "battleWins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "captures" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "General_battleWins_nonnegative" CHECK ("battleWins" >= 0),
  ADD CONSTRAINT "General_captures_nonnegative" CHECK ("captures" >= 0);

CREATE TABLE "RankingSnapshot" (
  "worldId" TEXT NOT NULL,
  "tick" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "generals" JSONB NOT NULL,
  "nations" JSONB NOT NULL,
  CONSTRAINT "RankingSnapshot_pkey" PRIMARY KEY ("worldId"),
  CONSTRAINT "RankingSnapshot_tick_nonnegative" CHECK ("tick" >= 0),
  CONSTRAINT "RankingSnapshot_month_range" CHECK ("month" BETWEEN 1 AND 12),
  CONSTRAINT "RankingSnapshot_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
