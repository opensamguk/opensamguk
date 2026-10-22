CREATE TYPE "WorldClockMode" AS ENUM ('REALTIME', 'ACCELERATED');
CREATE TYPE "WorldEndReason" AS ENUM ('UNIFIED', 'END_YEAR');
ALTER TABLE "World"
  ADD COLUMN "endYear" INTEGER,
  ADD COLUMN "clockMode" "WorldClockMode" NOT NULL DEFAULT 'REALTIME',
  ADD COLUMN "outcomeFromSequence" INTEGER NOT NULL DEFAULT 0;
UPDATE "World" SET "outcomeFromSequence" = "actionSequence";
CREATE TABLE "WorldResult" (
  "worldId" TEXT NOT NULL PRIMARY KEY REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "reason" "WorldEndReason" NOT NULL,
  "winnerNationId" INTEGER,
  "winnerName" TEXT,
  "winnerColor" TEXT,
  "endedYear" INTEGER NOT NULL,
  "endedMonth" INTEGER NOT NULL,
  "endedTick" INTEGER NOT NULL,
  "endedSequence" INTEGER NOT NULL,
  "remainingNations" INTEGER NOT NULL,
  "finalStateHash" TEXT NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL
);
