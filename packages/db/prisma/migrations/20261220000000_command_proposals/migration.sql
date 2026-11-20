CREATE TABLE "CommandProposal" (
  "id" TEXT PRIMARY KEY,
  "worldId" TEXT NOT NULL REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "nationId" INTEGER NOT NULL,
  "proposerId" INTEGER NOT NULL,
  "proposerLevel" INTEGER NOT NULL,
  "commandKey" TEXT NOT NULL,
  "args" JSONB NOT NULL,
  "slot" INTEGER CHECK ("slot" BETWEEN 0 AND 11),
  "note" TEXT CHECK (length("note") <= 200),
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED')),
  "createdTick" INTEGER NOT NULL,
  "expiresTick" INTEGER NOT NULL,
  "responseBy" INTEGER,
  "responseTick" INTEGER,
  "reason" TEXT CHECK (length("reason") <= 200)
);
CREATE INDEX "CommandProposal_worldId_nationId_status_idx" ON "CommandProposal"("worldId", "nationId", "status");
CREATE INDEX "CommandProposal_worldId_proposerId_status_idx" ON "CommandProposal"("worldId", "proposerId", "status");
