ALTER TABLE "World" ADD COLUMN "logisticsState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_logisticsState_feature_check" CHECK (
    ("logisticsState" IS NULL AND NOT ('logistics-v1' = ANY("ruleFeatures"))) OR
    ("logisticsState" IS NOT NULL AND "replayFormat" = 3 AND
     'logistics-v1' = ANY("ruleFeatures") AND 'city-resources-v1' = ANY("ruleFeatures") AND
     COALESCE(jsonb_typeof("logisticsState") = 'object' AND
        "logisticsState"->'version' = '1'::jsonb AND
        jsonb_typeof("logisticsState"->'config') = 'object' AND
        jsonb_typeof("logisticsState"->'cities') = 'object' AND
        jsonb_typeof("logisticsState"->'convoys') = 'array', FALSE))
);

CREATE TABLE "LogisticsMovement" (
    "worldId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "tick" INTEGER NOT NULL,
    "holder" TEXT NOT NULL,
    "holderId" INTEGER NOT NULL,
    "good" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    CONSTRAINT "LogisticsMovement_pkey" PRIMARY KEY ("worldId", "sequence", "ordinal"),
    CONSTRAINT "LogisticsMovement_holder_check" CHECK ("holder" IN ('city', 'convoy')),
    CONSTRAINT "LogisticsMovement_good_check" CHECK ("good" IN ('iron', 'wood', 'horses')),
    CONSTRAINT "LogisticsMovement_delta_check" CHECK ("delta" <> 0),
    CONSTRAINT "LogisticsMovement_ids_check" CHECK ("holderId" > 0 AND "sequence" > 0 AND "ordinal" >= 0 AND "tick" >= 0),
    CONSTRAINT "LogisticsMovement_reason_check" CHECK ("reason" IN ('PRODUCE', 'CONSUME', 'DEPART', 'ARRIVE', 'RETURN', 'CAPTURE', 'LOSS_TRANSIT', 'LOSS_OVERFLOW', 'TRADE', 'UPGRADE')),
    CONSTRAINT "LogisticsMovement_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LogisticsMovement_worldId_tick_idx" ON "LogisticsMovement"("worldId", "tick");
