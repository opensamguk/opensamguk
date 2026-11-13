CREATE TABLE "NpcEntryDraft" (
  "worldId" TEXT NOT NULL REFERENCES "World"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "nonce" TEXT NOT NULL,
  "validUntil" TIMESTAMP(3) NOT NULL,
  "redrawAt" TIMESTAMP(3) NOT NULL,
  "cards" JSONB NOT NULL,
  PRIMARY KEY ("worldId", "userId")
);
CREATE INDEX "NpcEntryDraft_worldId_validUntil_idx" ON "NpcEntryDraft"("worldId", "validUntil");
