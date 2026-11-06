-- AC-P2-04: 전략 대기는 새 기능 월드에만 저장한다.
ALTER TABLE "World" ADD COLUMN "nationStrategyState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_nationStrategyState_feature_check" CHECK (
  ("nationStrategyState" IS NULL AND NOT ('nation-strategy-v1' = ANY("ruleFeatures"))) OR
  (
    "nationStrategyState" IS NOT NULL AND "replayFormat" = 3 AND
    'nation-strategy-v1' = ANY("ruleFeatures") AND
    COALESCE(
      jsonb_typeof("nationStrategyState") = 'object' AND
      "nationStrategyState"->'version' = '1'::jsonb AND
      jsonb_typeof("nationStrategyState"->'nations') = 'object',
      FALSE
    )
  )
);
