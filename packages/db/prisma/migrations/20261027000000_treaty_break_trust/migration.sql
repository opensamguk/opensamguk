BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TYPE "TreatyStatus" ADD VALUE 'BROKEN';

CREATE TABLE "NationTrust" (
  "worldId" TEXT NOT NULL,
  "nationId" INTEGER NOT NULL,
  "brokenTreaties" INTEGER NOT NULL,
  "lastBrokenTick" INTEGER NOT NULL,
  CONSTRAINT "NationTrust_pkey" PRIMARY KEY ("worldId", "nationId"),
  CONSTRAINT "NationTrust_nationId_check" CHECK ("nationId" >= 1),
  CONSTRAINT "NationTrust_brokenTreaties_check" CHECK ("brokenTreaties" >= 1),
  CONSTRAINT "NationTrust_lastBrokenTick_check" CHECK ("lastBrokenTick" >= 0)
);

ALTER TABLE "NationTrust" ADD CONSTRAINT "NationTrust_worldId_fkey"
  FOREIGN KEY ("worldId") REFERENCES "World" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
