CREATE TABLE "Battle" (
  "worldId" TEXT NOT NULL REFERENCES "World"("id") ON DELETE CASCADE,
  "id" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "phase" TEXT NOT NULL, "deadlineAt" TIMESTAMP(3) NOT NULL, "state" JSONB NOT NULL,
  PRIMARY KEY ("worldId", "id")
);
CREATE INDEX "Battle_worldId_phase_deadlineAt_idx" ON "Battle"("worldId", "phase", "deadlineAt");
CREATE TABLE "BattleTurn" (
  "worldId" TEXT NOT NULL, "battleId" TEXT NOT NULL, "turnNo" INTEGER NOT NULL CHECK ("turnNo" BETWEEN 1 AND 30),
  "beforeHash" TEXT NOT NULL, "afterHash" TEXT NOT NULL, "record" JSONB NOT NULL,
  "attackView" JSONB NOT NULL, "defendView" JSONB NOT NULL,
  PRIMARY KEY ("worldId", "battleId", "turnNo"),
  FOREIGN KEY ("worldId", "battleId") REFERENCES "Battle"("worldId", "id") ON DELETE CASCADE
);
CREATE TABLE "BattleEvent" (
  "worldId" TEXT NOT NULL, "battleId" TEXT NOT NULL, "turnNo" INTEGER NOT NULL, "ordinal" INTEGER NOT NULL, "data" JSONB NOT NULL,
  PRIMARY KEY ("worldId", "battleId", "turnNo", "ordinal"),
  FOREIGN KEY ("worldId", "battleId") REFERENCES "Battle"("worldId", "id") ON DELETE CASCADE
);
CREATE TABLE "BattleReservation" (
  "worldId" TEXT NOT NULL, "key" TEXT NOT NULL, "battleId" TEXT NOT NULL,
  "createdSequence" INTEGER NOT NULL, "releasedSequence" INTEGER,
  PRIMARY KEY ("worldId", "key", "battleId"),
  FOREIGN KEY ("worldId", "battleId") REFERENCES "Battle"("worldId", "id") ON DELETE CASCADE
);
CREATE INDEX "BattleReservation_worldId_battleId_idx" ON "BattleReservation"("worldId", "battleId");
CREATE UNIQUE INDEX "BattleReservation_active_key" ON "BattleReservation"("worldId", "key") WHERE "releasedSequence" IS NULL;
CREATE TABLE "BattlePresence" (
  "worldId" TEXT NOT NULL, "battleId" TEXT NOT NULL, "generalId" INTEGER NOT NULL,
  "sessionId" TEXT NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("worldId", "battleId", "generalId"),
  FOREIGN KEY ("worldId", "battleId") REFERENCES "Battle"("worldId", "id") ON DELETE CASCADE
);
