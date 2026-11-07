-- AC-P2-05·AC-P2-06: 기존 월드는 NULL을 보존한다.
ALTER TABLE "World" ADD COLUMN "preparedTurnsState" JSONB;
ALTER TABLE "World" ADD COLUMN "nationResearchState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_preparedTurnsState_feature_check" CHECK (
  ("preparedTurnsState" IS NULL AND NOT ('prepared-turns-v1' = ANY("ruleFeatures"))) OR
  (
    "preparedTurnsState" IS NOT NULL AND "replayFormat" = 3 AND
    'prepared-turns-v1' = ANY("ruleFeatures") AND 'personnel' = ANY("ruleFeatures") AND
    COALESCE(
      jsonb_typeof("preparedTurnsState") = 'object' AND
      "preparedTurnsState"->'version' = '1'::jsonb AND
      jsonb_typeof("preparedTurnsState"->'nations') = 'object', FALSE
    )
  )
);
ALTER TABLE "World" ADD CONSTRAINT "World_nationResearchState_feature_check" CHECK (
  ("nationResearchState" IS NULL AND NOT ('nation-research-v1' = ANY("ruleFeatures"))) OR
  (
    "nationResearchState" IS NOT NULL AND "replayFormat" = 3 AND
    'nation-research-v1' = ANY("ruleFeatures") AND 'personnel' = ANY("ruleFeatures") AND
    'prepared-turns-v1' = ANY("ruleFeatures") AND
    COALESCE(
      jsonb_typeof("nationResearchState") = 'object' AND
      "nationResearchState"->'version' = '1'::jsonb AND
      jsonb_typeof("nationResearchState"->'nations') = 'object', FALSE
    )
  )
);
