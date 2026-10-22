ALTER TABLE "World" ADD COLUMN "commandMeta" JSONB;

CREATE TABLE "NationTurn" (
  "worldId" TEXT NOT NULL,
  "nationId" INTEGER NOT NULL,
  "slot" INTEGER NOT NULL,
  "commandKey" TEXT NOT NULL DEFAULT 'nation_rest',
  "args" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "NationTurn_pkey" PRIMARY KEY ("worldId", "nationId", "slot"),
  CONSTRAINT "NationTurn_slot_check" CHECK ("slot" >= 0 AND "slot" < 30),
  CONSTRAINT "NationTurn_worldId_nationId_fkey" FOREIGN KEY ("worldId", "nationId") REFERENCES "Nation"("worldId", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE "BattleLog" (
  "worldId" TEXT NOT NULL,
  "tick" INTEGER NOT NULL,
  "attackerId" INTEGER NOT NULL,
  "generalId" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  CONSTRAINT "BattleLog_pkey" PRIMARY KEY ("worldId", "tick", "attackerId", "generalId"),
  CONSTRAINT "BattleLog_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BattleLog_worldId_generalId_fkey" FOREIGN KEY ("worldId", "generalId") REFERENCES "General"("worldId", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);
