-- AC-P2-21: 기능을 끈 월드는 사건 상태를 저장하지 않는다.
ALTER TABLE "World" ADD COLUMN "historicEventsState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_historicEventsState_feature_check" CHECK (
  ("historicEventsState" IS NULL AND NOT COALESCE('historic-events' = ANY("ruleFeatures"), FALSE)) OR
  (
    "historicEventsState" IS NOT NULL AND "replayFormat" = 3 AND
    CASE WHEN "scenarioKey" ~ '^1030(@[1-9][0-9]{0,9})?$'
      THEN COALESCE(NULLIF(split_part("scenarioKey", '@', 2), '')::bigint, 1) <= 2147483647
      ELSE FALSE
    END AND
    COALESCE('historic-events' = ANY("ruleFeatures"), FALSE) AND
    array_position("ruleFeatures", NULL) IS NULL AND
    COALESCE(
      jsonb_typeof("historicEventsState") = 'object' AND
      jsonb_typeof("historicEventsState"->'pending') = 'array' AND
      jsonb_typeof("historicEventsState"->'done') = 'array' AND
      jsonb_typeof("historicEventsState"->'skipped') = 'array', FALSE
    )
  )
);
