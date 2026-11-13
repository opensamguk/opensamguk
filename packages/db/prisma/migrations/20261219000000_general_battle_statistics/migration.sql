CREATE TABLE "GeneralBattleStats" (
  "worldId" TEXT NOT NULL REFERENCES "World" ("id") ON DELETE CASCADE,
  "generalId" INTEGER NOT NULL,
  "engagements" INTEGER NOT NULL DEFAULT 0,
  "wins" INTEGER NOT NULL DEFAULT 0,
  "losses" INTEGER NOT NULL DEFAULT 0,
  "kills" BIGINT NOT NULL DEFAULT 0,
  "casualties" BIGINT NOT NULL DEFAULT 0,
  "lastTick" INTEGER NOT NULL,
  PRIMARY KEY ("worldId", "generalId")
);
