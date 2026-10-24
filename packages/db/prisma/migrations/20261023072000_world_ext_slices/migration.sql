BEGIN;

CREATE TABLE "WorldExtSlice" (
  "worldId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  CONSTRAINT "WorldExtSlice_pkey" PRIMARY KEY ("worldId", "key"),
  CONSTRAINT "WorldExtSlice_worldId_fkey" FOREIGN KEY ("worldId")
    REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

COMMIT;
