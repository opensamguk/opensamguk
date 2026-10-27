-- AC-INT-02: 새 운영 지도 원장은 생성 시 고정한다. 기존 월드에는 NULL을 유지한다.
ALTER TABLE "World" ADD COLUMN "operationalMap" JSONB;
ALTER TABLE "City" ADD COLUMN "kind" TEXT;
ALTER TABLE "City" ADD CONSTRAINT "City_kind_check" CHECK ("kind" IS NULL OR "kind" IN ('CITY', 'PASS'));
ALTER TABLE "World" ADD CONSTRAINT "World_operationalMap_feature_check" CHECK (
  ("operationalMap" IS NULL AND NOT ('operational-map' = ANY("ruleFeatures"))) OR
  ("operationalMap" IS NOT NULL AND "replayFormat" = 3 AND 'operational-map' = ANY("ruleFeatures") AND 'five-stats' = ANY("ruleFeatures"))
);
