ALTER TABLE "General" ADD COLUMN "turnRevision" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "General_worldId_nextTurnTick_id_idx" ON "General"("worldId", "nextTurnTick", "id");

CREATE TABLE "EngineLease" (
  "worldId" TEXT NOT NULL PRIMARY KEY REFERENCES "World"("id") ON DELETE CASCADE,
  "ownerId" TEXT NOT NULL,
  "fencingToken" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "GeneralTurn" (
  "worldId" TEXT NOT NULL,
  "generalId" INTEGER NOT NULL,
  "slot" INTEGER NOT NULL CHECK ("slot" BETWEEN 0 AND 29),
  "commandKey" TEXT NOT NULL DEFAULT 'rest',
  "args" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "GeneralTurn_pkey" PRIMARY KEY ("worldId", "generalId", "slot"),
  CONSTRAINT "GeneralTurn_worldId_generalId_fkey" FOREIGN KEY ("worldId", "generalId")
    REFERENCES "General"("worldId", "id") ON DELETE CASCADE
);

CREATE TABLE "GeneralLog" (
  "id" BIGSERIAL NOT NULL PRIMARY KEY,
  "worldId" TEXT NOT NULL,
  "generalId" INTEGER NOT NULL,
  "tick" INTEGER NOT NULL,
  "commandKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneralLog_worldId_generalId_fkey" FOREIGN KEY ("worldId", "generalId")
    REFERENCES "General"("worldId", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "GeneralLog_worldId_generalId_tick_key" ON "GeneralLog"("worldId", "generalId", "tick");
