CREATE TABLE "PublicMapSnapshot" (
    "worldId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "tick" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    CONSTRAINT "PublicMapSnapshot_pkey" PRIMARY KEY ("worldId", "takenAt")
);

ALTER TABLE "PublicMapSnapshot" ADD CONSTRAINT "PublicMapSnapshot_worldId_fkey"
    FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
