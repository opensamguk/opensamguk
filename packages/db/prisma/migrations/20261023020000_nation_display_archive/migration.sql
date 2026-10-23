-- CreateTable
CREATE TABLE "RemovedNation" (
    "worldId" TEXT NOT NULL,
    "nationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "removedSequence" INTEGER NOT NULL,
    "removedTick" INTEGER NOT NULL,

    CONSTRAINT "RemovedNation_pkey" PRIMARY KEY ("worldId","nationId")
);

-- CreateTable
CREATE TABLE "YearbookNation" (
    "worldId" TEXT NOT NULL,
    "tick" INTEGER NOT NULL,
    "nationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,

    CONSTRAINT "YearbookNation_pkey" PRIMARY KEY ("worldId","tick","nationId")
);

-- AddForeignKey
ALTER TABLE "RemovedNation" ADD CONSTRAINT "RemovedNation_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YearbookNation" ADD CONSTRAINT "YearbookNation_worldId_tick_fkey" FOREIGN KEY ("worldId", "tick") REFERENCES "YearbookSnapshot"("worldId", "tick") ON DELETE CASCADE ON UPDATE CASCADE;
