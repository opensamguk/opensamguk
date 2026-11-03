ALTER TABLE "World" ADD COLUMN "governanceState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_governanceState_feature_check" CHECK (
    ("governanceState" IS NULL AND NOT ('governance-v1' = ANY("ruleFeatures"))) OR
    ("governanceState" IS NOT NULL AND "replayFormat" = 3 AND
     'governance-v1' = ANY("ruleFeatures") AND 'city-resources-v1' = ANY("ruleFeatures") AND
     'personnel' = ANY("ruleFeatures") AND 'treaty' = ANY("ruleFeatures") AND
     COALESCE(jsonb_typeof("governanceState") = 'object' AND
        "governanceState"->'version' = '1'::jsonb AND
        jsonb_typeof("governanceState"->'config') = 'object' AND
        jsonb_typeof("governanceState"->'throne') = 'object' AND
        jsonb_typeof("governanceState"->'court') = 'object' AND
        jsonb_typeof("governanceState"->'vassals') = 'array' AND
        jsonb_typeof("governanceState"->'offers') = 'array', FALSE))
);

CREATE TABLE "GovernanceMovement" (
    "worldId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "tick" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" INTEGER NOT NULL,
    "holder" TEXT NOT NULL,
    "holderId" INTEGER NOT NULL,
    "resource" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "fromNationId" INTEGER NOT NULL,
    "toNationId" INTEGER NOT NULL,
    CONSTRAINT "GovernanceMovement_pkey" PRIMARY KEY ("worldId", "sequence", "ordinal"),
    CONSTRAINT "GovernanceMovement_kind_check" CHECK ("kind" IN ('TRIBUTE', 'STIPEND')),
    CONSTRAINT "GovernanceMovement_holder_check" CHECK ("holder" IN ('city', 'general')),
    CONSTRAINT "GovernanceMovement_resource_check" CHECK ("resource" IN ('gold', 'rice')),
    CONSTRAINT "GovernanceMovement_delta_check" CHECK ("delta" <> 0),
    CONSTRAINT "GovernanceMovement_ids_check" CHECK (
        "sequence" > 0 AND "ordinal" >= 0 AND "tick" >= 0 AND "refId" > 0 AND
        "holderId" > 0 AND "fromNationId" > 0 AND "toNationId" > 0
    ),
    CONSTRAINT "GovernanceMovement_direction_check" CHECK (
        ("kind" = 'TRIBUTE' AND "holder" = 'city') OR
        ("kind" = 'STIPEND' AND "resource" = 'gold' AND "refId" <= 3 AND
         (("delta" < 0 AND "holder" = 'city') OR ("delta" > 0 AND "holder" = 'general')))
    ),
    CONSTRAINT "GovernanceMovement_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "GovernanceMovement_worldId_tick_idx" ON "GovernanceMovement"("worldId", "tick");
CREATE INDEX "GovernanceMovement_worldId_fromNationId_tick_idx" ON "GovernanceMovement"("worldId", "fromNationId", "tick");
CREATE INDEX "GovernanceMovement_worldId_toNationId_tick_idx" ON "GovernanceMovement"("worldId", "toNationId", "tick");
CREATE INDEX "GovernanceMovement_worldId_holder_holderId_tick_idx" ON "GovernanceMovement"("worldId", "holder", "holderId", "tick");
