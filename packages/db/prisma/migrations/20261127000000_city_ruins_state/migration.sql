-- AC-INT-21: 기존 월드의 NULL과 원래 도시 규모를 보존한다.
ALTER TABLE "World" ADD COLUMN "cityRuinsState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_cityRuinsState_feature_check" CHECK (
  ("cityRuinsState" IS NULL AND NOT ('city-scale-v1' = ANY("ruleFeatures"))) OR
  (
    "cityRuinsState" IS NOT NULL AND "replayFormat" = 3 AND
    'city-scale-v1' = ANY("ruleFeatures") AND
    COALESCE(
      jsonb_typeof("cityRuinsState") = 'object' AND
      "cityRuinsState"->'version' = '1'::jsonb AND
      jsonb_typeof("cityRuinsState"->'cities') = 'array',
      FALSE
    )
  )
);
