CREATE TYPE "OperationStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE "Operation" (
  "id" TEXT NOT NULL,
  "worldId" TEXT NOT NULL,
  "nationId" INTEGER NOT NULL,
  "targetCityKey" INTEGER NOT NULL,
  "targetTick" BIGINT NOT NULL,
  "minCrew" INTEGER NOT NULL,
  "minTrain" INTEGER NOT NULL,
  "minAtmos" INTEGER NOT NULL,
  "status" "OperationStatus" NOT NULL DEFAULT 'OPEN',
  "createdById" INTEGER NOT NULL,
  CONSTRAINT "Operation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Operation_targetTick_check" CHECK ("targetTick" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "Operation_min_check" CHECK ("minCrew" >= 0 AND "minTrain" >= 0 AND "minAtmos" >= 0)
);

CREATE TABLE "OperationMember" (
  "worldId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "generalId" INTEGER NOT NULL,
  CONSTRAINT "OperationMember_pkey" PRIMARY KEY ("operationId", "generalId")
);

CREATE UNIQUE INDEX "Operation_worldId_id_key" ON "Operation"("worldId", "id");
CREATE INDEX "Operation_worldId_nationId_status_targetTick_id_idx" ON "Operation"("worldId", "nationId", "status", "targetTick", "id");
CREATE INDEX "OperationMember_worldId_generalId_idx" ON "OperationMember"("worldId", "generalId");

ALTER TABLE "Operation" ADD CONSTRAINT "Operation_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_worldId_nationId_fkey" FOREIGN KEY ("worldId", "nationId") REFERENCES "Nation"("worldId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_worldId_targetCityKey_fkey" FOREIGN KEY ("worldId", "targetCityKey") REFERENCES "City"("worldId", "cityKey") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_worldId_createdById_fkey" FOREIGN KEY ("worldId", "createdById") REFERENCES "General"("worldId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationMember" ADD CONSTRAINT "OperationMember_worldId_operationId_fkey" FOREIGN KEY ("worldId", "operationId") REFERENCES "Operation"("worldId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationMember" ADD CONSTRAINT "OperationMember_worldId_generalId_fkey" FOREIGN KEY ("worldId", "generalId") REFERENCES "General"("worldId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
