BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "World" ADD COLUMN "treatyFormat" INTEGER;

CREATE TYPE "TreatyStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED');

CREATE TABLE "Treaty" (
  "worldId" TEXT NOT NULL,
  "id" INTEGER NOT NULL,
  "fromNationId" INTEGER NOT NULL,
  "toNationId" INTEGER NOT NULL,
  "clauses" JSONB NOT NULL,
  "status" "TreatyStatus" NOT NULL,
  "proposedTick" INTEGER NOT NULL,
  "respondByTick" INTEGER NOT NULL,
  "startTick" INTEGER,
  "endTick" INTEGER,
  "closedSequence" INTEGER,
  "costFrom" INTEGER,
  "costTo" INTEGER,
  CONSTRAINT "Treaty_pkey" PRIMARY KEY ("worldId", "id")
);

CREATE INDEX "Treaty_worldId_status_id_idx" ON "Treaty" ("worldId", "status", "id");
CREATE INDEX "Treaty_worldId_fromNationId_id_idx" ON "Treaty" ("worldId", "fromNationId", "id");
CREATE INDEX "Treaty_worldId_toNationId_id_idx" ON "Treaty" ("worldId", "toNationId", "id");

ALTER TABLE "Treaty" ADD CONSTRAINT "Treaty_worldId_fkey"
  FOREIGN KEY ("worldId") REFERENCES "World" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
