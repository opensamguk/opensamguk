ALTER TABLE "PublicNationEvent" ADD COLUMN "nations" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "City" DROP CONSTRAINT "City_kind_check";
ALTER TABLE "City" ADD CONSTRAINT "City_kind_check"
  CHECK ("kind" IS NULL OR "kind" IN ('CITY', 'PASS', 'FIELD'));
ALTER TABLE "World" ADD CONSTRAINT "World_capturableFields_feature_check" CHECK (
  COALESCE("operationalMap" ->> 'capturableFields' = 'true', false)
  = ('capturable-field-v1' = ANY("ruleFeatures"))
);
