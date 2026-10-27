-- AC-INT-06: 개인 관계와 부곡의 정본. 기존 월드/General 병력을 자동 변환하지 않는다.
ALTER TABLE "World" ADD COLUMN "campaignState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_campaignState_feature_check" CHECK (
  ("campaignState" IS NULL AND NOT ('campaign-v1' = ANY("ruleFeatures"))) OR
  (
    "campaignState" IS NOT NULL AND "replayFormat" = 3 AND
    'campaign-v1' = ANY("ruleFeatures") AND
    'five-stats' = ANY("ruleFeatures") AND
    'operational-map' = ANY("ruleFeatures") AND
    'personnel' = ANY("ruleFeatures") AND
    'policy' = ANY("ruleFeatures") AND
    COALESCE(
      jsonb_typeof("campaignState") = 'object' AND
      "campaignState"->'version' = '1'::jsonb AND
      jsonb_typeof("campaignState"->'revision') = 'number' AND
      "campaignState"->>'seed' = "seed",
      FALSE
    )
  )
);
