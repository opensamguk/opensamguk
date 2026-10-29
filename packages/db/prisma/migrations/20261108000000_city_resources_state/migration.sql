-- AC-INT-18B: 새 판 전용 도시 원장. 기존 판의 NULL과 자원을 보존한다.
ALTER TABLE "World" ADD COLUMN "cityResourcesState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_cityResourcesState_feature_check" CHECK (
  ("cityResourcesState" IS NULL AND NOT ('city-resources-v1' = ANY("ruleFeatures"))) OR
  (
    "cityResourcesState" IS NOT NULL AND "replayFormat" = 3 AND
    'city-resources-v1' = ANY("ruleFeatures") AND
    'campaign-assignment-v2' = ANY("ruleFeatures") AND
    'campaign-v1' = ANY("ruleFeatures") AND
    COALESCE(
      jsonb_typeof("cityResourcesState") = 'object' AND
      "cityResourcesState"->'version' = '1'::jsonb AND
      jsonb_typeof("cityResourcesState"->'cities') = 'object',
      FALSE
    )
  )
);
