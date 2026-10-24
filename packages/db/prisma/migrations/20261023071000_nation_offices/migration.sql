BEGIN;

CREATE TABLE "NationOffice" (
  "worldId" TEXT NOT NULL,
  "nationId" INTEGER NOT NULL,
  "officerLevel" INTEGER NOT NULL,
  "turnRevision" INTEGER NOT NULL DEFAULT 0,
  "tenure" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "NationOffice_pkey" PRIMARY KEY ("worldId", "nationId", "officerLevel"),
  CONSTRAINT "NationOffice_officerLevel_check" CHECK ("officerLevel" BETWEEN 5 AND 12),
  CONSTRAINT "NationOffice_turnRevision_check" CHECK ("turnRevision" >= 0),
  CONSTRAINT "NationOffice_tenure_check" CHECK ("tenure" >= 0),
  CONSTRAINT "NationOffice_worldId_nationId_fkey" FOREIGN KEY ("worldId", "nationId")
    REFERENCES "Nation"("worldId", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE "NationOfficeTurn" (
  "worldId" TEXT NOT NULL,
  "nationId" INTEGER NOT NULL,
  "officerLevel" INTEGER NOT NULL,
  "slot" INTEGER NOT NULL,
  "commandKey" TEXT NOT NULL DEFAULT 'nation_rest',
  "args" JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "NationOfficeTurn_pkey" PRIMARY KEY ("worldId", "nationId", "officerLevel", "slot"),
  CONSTRAINT "NationOfficeTurn_officerLevel_check" CHECK ("officerLevel" BETWEEN 5 AND 12),
  CONSTRAINT "NationOfficeTurn_slot_check" CHECK ("slot" BETWEEN 0 AND 11),
  CONSTRAINT "NationOfficeTurn_worldId_nationId_fkey" FOREIGN KEY ("worldId", "nationId")
    REFERENCES "Nation"("worldId", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);

COMMIT;
