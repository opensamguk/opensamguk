ALTER TABLE "World" ADD COLUMN "stratagemCardsState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_stratagemCardsState_feature_check" CHECK (
    ("stratagemCardsState" IS NULL AND NOT ('stratagem-cards-v1' = ANY("ruleFeatures"))) OR
    ("stratagemCardsState" IS NOT NULL AND "replayFormat" = 3 AND
     'stratagem-cards-v1' = ANY("ruleFeatures") AND 'personnel' = ANY("ruleFeatures") AND
     'stratagem-basic' = ANY("ruleFeatures") AND 'five-stats' = ANY("ruleFeatures") AND
     COALESCE(jsonb_typeof("stratagemCardsState") = 'object' AND
        "stratagemCardsState"->'version' = '1'::jsonb AND
        jsonb_typeof("stratagemCardsState"->'config') = 'object' AND
        jsonb_typeof("stratagemCardsState"->'nations') = 'object', FALSE))
);
