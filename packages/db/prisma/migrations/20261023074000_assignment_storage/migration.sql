BEGIN;

CREATE TYPE "AssignmentOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'CANCELLED');
CREATE TYPE "AssignmentOfferResolvedBy" AS ENUM ('RESPONSE', 'EXPIRY');
CREATE TYPE "AssignmentOfferCancelReason" AS ENUM ('CITY_LOST', 'TARGET_LEFT', 'ISSUER_LOST_OFFICE');

CREATE TABLE "AssignmentOffer" (
  "worldId" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "nationId" INTEGER NOT NULL,
  "issuerGeneralId" INTEGER NOT NULL,
  "targetGeneralId" INTEGER NOT NULL,
  "cityKey" INTEGER NOT NULL,
  "status" "AssignmentOfferStatus" NOT NULL,
  "resolvedBy" "AssignmentOfferResolvedBy",
  "cancelReason" "AssignmentOfferCancelReason",
  "createdTick" INTEGER NOT NULL,
  "expiresTick" INTEGER NOT NULL,
  "resolvedTick" INTEGER,
  CONSTRAINT "AssignmentOffer_pkey" PRIMARY KEY ("worldId", "id"),
  CONSTRAINT "AssignmentOffer_worldId_fkey" FOREIGN KEY ("worldId")
    REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AssignmentOffer_worldId_targetGeneralId_pending_key"
  ON "AssignmentOffer"("worldId", "targetGeneralId") WHERE "status" = 'PENDING';

ALTER TABLE "GeneralLog"
  ADD COLUMN "sequence" INTEGER,
  ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "GeneralLog_sequence_check" CHECK ("sequence" IS NULL OR "sequence" > 0),
  ADD CONSTRAINT "GeneralLog_ordinal_check" CHECK ("ordinal" >= 0);

DROP INDEX "GeneralLog_worldId_generalId_tick_key";
CREATE UNIQUE INDEX "GeneralLog_worldId_generalId_tick_turn_key"
  ON "GeneralLog"("worldId", "generalId", "tick") WHERE "sequence" IS NULL;
CREATE UNIQUE INDEX "GeneralLog_worldId_generalId_sequence_ordinal_key"
  ON "GeneralLog"("worldId", "generalId", "sequence", "ordinal") WHERE "sequence" IS NOT NULL;

COMMIT;
