CREATE TABLE "WorldTrafficMonthly" (
  "worldId" TEXT NOT NULL REFERENCES "World"("id") ON DELETE CASCADE,
  "monthTick" INTEGER NOT NULL CHECK ("monthTick" >= 0 AND "monthTick" % 10000 = 0),
  "generalId" INTEGER NOT NULL CHECK ("generalId" > 0),
  "firstAt" TIMESTAMP(3) NOT NULL,
  "lastAt" TIMESTAMP(3) NOT NULL,
  "refresh" BIGINT NOT NULL DEFAULT 1 CHECK ("refresh" > 0),
  PRIMARY KEY ("worldId", "monthTick", "generalId")
);
