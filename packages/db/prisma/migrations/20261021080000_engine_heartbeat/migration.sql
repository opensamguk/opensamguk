CREATE TABLE "EngineHeartbeat" (
    "worldId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "lastTick" INTEGER NOT NULL,
    "lagMs" INTEGER NOT NULL,
    "lastError" TEXT,
    CONSTRAINT "EngineHeartbeat_pkey" PRIMARY KEY ("worldId"),
    CONSTRAINT "EngineHeartbeat_lagMs_check" CHECK ("lagMs" >= 0),
    CONSTRAINT "EngineHeartbeat_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
