ALTER TABLE "World"
  ADD COLUMN "monthlyTick" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "actionSequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "replayOrigin" JSONB;

CREATE TYPE "InputEventStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');
CREATE TABLE "InputEvent" (
  "id" BIGSERIAL PRIMARY KEY,
  "worldId" TEXT NOT NULL REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL,
  "generalId" INTEGER,
  "kind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "InputEventStatus" NOT NULL DEFAULT 'PENDING',
  "sequence" INTEGER,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InputEvent_completion" CHECK (
    ("status" = 'PENDING' AND "sequence" IS NULL AND "result" IS NULL) OR
    ("status" <> 'PENDING' AND "sequence" IS NOT NULL AND "sequence" > 0 AND "result" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "InputEvent_worldId_userId_idempotencyKey_key" ON "InputEvent"("worldId", "userId", "idempotencyKey");
CREATE UNIQUE INDEX "InputEvent_worldId_sequence_key" ON "InputEvent"("worldId", "sequence");
CREATE INDEX "InputEvent_worldId_status_id_idx" ON "InputEvent"("worldId", "status", "id");

CREATE TABLE "NationHistory" (
  "worldId" TEXT NOT NULL REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tick" INTEGER NOT NULL,
  "nationId" INTEGER NOT NULL,
  "data" JSONB NOT NULL,
  PRIMARY KEY ("worldId", "tick", "nationId")
);
CREATE TABLE "YearbookSnapshot" (
  "worldId" TEXT NOT NULL REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tick" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "data" JSONB NOT NULL,
  "stateHash" TEXT NOT NULL,
  PRIMARY KEY ("worldId", "tick")
);
