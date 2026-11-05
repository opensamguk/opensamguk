ALTER TABLE "World" ADD COLUMN "equipmentState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_equipmentState_feature_check" CHECK (
    ("equipmentState" IS NULL AND NOT ('equipment-v1' = ANY("ruleFeatures"))) OR
    ("equipmentState" IS NOT NULL AND "replayFormat" = 3 AND
     'equipment-v1' = ANY("ruleFeatures") AND 'five-stats' = ANY("ruleFeatures") AND
     'campaign-v1' = ANY("ruleFeatures") AND 'logistics-v1' = ANY("ruleFeatures") AND
     COALESCE(jsonb_typeof("equipmentState") = 'object' AND
        "equipmentState"->'version' = '1'::jsonb AND
        jsonb_typeof("equipmentState"->'config') = 'object' AND
        jsonb_typeof("equipmentState"->'generals') = 'object', FALSE))
);
