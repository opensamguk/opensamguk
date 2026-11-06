-- AC-P2-08·09: 국가 변천은 새 기능을 선택한 형식3 월드에만 저장한다.
ALTER TABLE "World" ADD COLUMN "nationLifecycleState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_nationLifecycleState_feature_check" CHECK (
  ("nationLifecycleState" IS NULL AND NOT ('nation-lifecycle-v1' = ANY("ruleFeatures"))) OR
  (
    "nationLifecycleState" IS NOT NULL AND "replayFormat" = 3 AND
    'nation-lifecycle-v1' = ANY("ruleFeatures") AND
    COALESCE(
      jsonb_typeof("nationLifecycleState") = 'object' AND
      "nationLifecycleState"->'version' = '1'::jsonb AND
      jsonb_typeof("nationLifecycleState"->'nations') = 'object',
      FALSE
    )
  )
);
