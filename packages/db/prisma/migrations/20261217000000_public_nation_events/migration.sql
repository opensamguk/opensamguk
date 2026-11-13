CREATE TABLE "PublicNationEvent" (
  "id" BIGSERIAL NOT NULL,
  "worldId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "tick" INTEGER NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('found', 'fall', 'declare', 'capture')),
  "text" TEXT NOT NULL,
  CONSTRAINT "PublicNationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicNationEvent_worldId_fkey"
    FOREIGN KEY ("worldId") REFERENCES "World" ("id") ON DELETE CASCADE
);
CREATE INDEX "PublicNationEvent_worldId_tick_id_idx" ON "PublicNationEvent" ("worldId", "tick", "id");
