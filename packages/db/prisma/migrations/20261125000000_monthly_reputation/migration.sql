CREATE TABLE "ReputationEvent" (
    "id" BIGSERIAL NOT NULL,
    "worldId" TEXT NOT NULL,
    "generalId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "tick" INTEGER NOT NULL,
    "generalName" TEXT NOT NULL,
    "nationId" INTEGER,
    "nationName" TEXT,
    "nationColor" TEXT,
    "cityKey" INTEGER,
    "cityName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReputationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MonthlyReview" (
    "worldId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "tick" INTEGER NOT NULL,
    "entries" JSONB NOT NULL,
    "headline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MonthlyReview_pkey" PRIMARY KEY ("worldId", "year", "month")
);

CREATE UNIQUE INDEX "ReputationEvent_worldId_generalId_year_month_kind_key" ON "ReputationEvent"("worldId", "generalId", "year", "month", "kind");
CREATE INDEX "ReputationEvent_worldId_year_month_idx" ON "ReputationEvent"("worldId", "year", "month");
CREATE UNIQUE INDEX "MonthlyReview_worldId_tick_key" ON "MonthlyReview"("worldId", "tick");
ALTER TABLE "ReputationEvent" ADD CONSTRAINT "ReputationEvent_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlyReview" ADD CONSTRAINT "MonthlyReview_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
