-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WorldStatus" AS ENUM ('PREOPEN', 'RUNNING', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "DiplomacyState" AS ENUM ('WAR', 'DECLARED', 'NON_AGGRESSION');

-- CreateTable
CREATE TABLE "World" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scenarioKey" TEXT NOT NULL,
    "mapKey" TEXT NOT NULL,
    "unitSetKey" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "startYear" INTEGER NOT NULL,
    "turnTermMinutes" INTEGER NOT NULL,
    "status" "WorldStatus" NOT NULL DEFAULT 'PREOPEN',
    "clockTick" INTEGER NOT NULL DEFAULT 0,
    "initialStateHash" TEXT NOT NULL,
    "statRules" JSONB NOT NULL,
    "unitSet" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "World_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nation" (
    "worldId" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "gold" INTEGER NOT NULL,
    "rice" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "tech" DOUBLE PRECISION NOT NULL,
    "philosophy" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "capitalCityKey" INTEGER,
    "isNpc" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Nation_pkey" PRIMARY KEY ("worldId","id")
);

-- CreateTable
CREATE TABLE "City" (
    "worldId" TEXT NOT NULL,
    "cityKey" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "region" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "connections" INTEGER[],
    "nationId" INTEGER,
    "population" INTEGER NOT NULL,
    "populationMax" INTEGER NOT NULL,
    "agriculture" INTEGER NOT NULL,
    "agricultureMax" INTEGER NOT NULL,
    "commerce" INTEGER NOT NULL,
    "commerceMax" INTEGER NOT NULL,
    "security" INTEGER NOT NULL,
    "securityMax" INTEGER NOT NULL,
    "defence" INTEGER NOT NULL,
    "defenceMax" INTEGER NOT NULL,
    "wall" INTEGER NOT NULL,
    "wallMax" INTEGER NOT NULL,
    "trust" DOUBLE PRECISION NOT NULL,
    "supplied" BOOLEAN NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("worldId","cityKey")
);

-- CreateTable
CREATE TABLE "General" (
    "worldId" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "userId" TEXT,
    "affinity" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "portraitId" INTEGER,
    "nationId" INTEGER,
    "cityKey" INTEGER NOT NULL,
    "leadership" INTEGER NOT NULL,
    "strength" INTEGER NOT NULL,
    "intel" INTEGER NOT NULL,
    "officerLevel" INTEGER NOT NULL,
    "birthYear" INTEGER NOT NULL,
    "deathYear" INTEGER NOT NULL,
    "activeFromYear" INTEGER NOT NULL,
    "personality" TEXT,
    "special" TEXT,
    "gold" INTEGER NOT NULL,
    "rice" INTEGER NOT NULL,
    "crew" INTEGER NOT NULL,
    "crewType" INTEGER NOT NULL,
    "train" INTEGER NOT NULL,
    "atmos" INTEGER NOT NULL,
    "experience" INTEGER NOT NULL,
    "dedication" INTEGER NOT NULL,
    "age" INTEGER NOT NULL,
    "injury" INTEGER NOT NULL,
    "nextTurnTick" INTEGER NOT NULL,

    CONSTRAINT "General_pkey" PRIMARY KEY ("worldId","id")
);

-- CreateTable
CREATE TABLE "Diplomacy" (
    "worldId" TEXT NOT NULL,
    "nationA" INTEGER NOT NULL,
    "nationB" INTEGER NOT NULL,
    "state" "DiplomacyState" NOT NULL,
    "untilTick" INTEGER NOT NULL,

    CONSTRAINT "Diplomacy_pkey" PRIMARY KEY ("worldId","nationA","nationB")
);

-- CreateIndex
CREATE INDEX "City_worldId_nationId_idx" ON "City"("worldId", "nationId");

-- CreateIndex
CREATE UNIQUE INDEX "City_worldId_name_key" ON "City"("worldId", "name");

-- CreateIndex
CREATE INDEX "General_worldId_nationId_idx" ON "General"("worldId", "nationId");

-- CreateIndex
CREATE INDEX "General_worldId_cityKey_idx" ON "General"("worldId", "cityKey");

-- CreateIndex
CREATE UNIQUE INDEX "General_worldId_userId_key" ON "General"("worldId", "userId");

-- AddForeignKey
ALTER TABLE "Nation" ADD CONSTRAINT "Nation_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nation" ADD CONSTRAINT "Nation_worldId_capitalCityKey_fkey" FOREIGN KEY ("worldId", "capitalCityKey") REFERENCES "City"("worldId", "cityKey") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_worldId_nationId_fkey" FOREIGN KEY ("worldId", "nationId") REFERENCES "Nation"("worldId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "General" ADD CONSTRAINT "General_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "General" ADD CONSTRAINT "General_worldId_nationId_fkey" FOREIGN KEY ("worldId", "nationId") REFERENCES "Nation"("worldId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "General" ADD CONSTRAINT "General_worldId_cityKey_fkey" FOREIGN KEY ("worldId", "cityKey") REFERENCES "City"("worldId", "cityKey") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diplomacy" ADD CONSTRAINT "Diplomacy_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diplomacy" ADD CONSTRAINT "Diplomacy_worldId_nationA_fkey" FOREIGN KEY ("worldId", "nationA") REFERENCES "Nation"("worldId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diplomacy" ADD CONSTRAINT "Diplomacy_worldId_nationB_fkey" FOREIGN KEY ("worldId", "nationB") REFERENCES "Nation"("worldId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
