ALTER TABLE "World" ADD COLUMN "lineageState" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_lineageState_feature_check" CHECK (
    ("lineageState" IS NULL AND NOT ('lineage-v1' = ANY("ruleFeatures"))) OR
    ("lineageState" IS NOT NULL AND "replayFormat" = 3 AND
     'lineage-v1' = ANY("ruleFeatures") AND 'personnel' = ANY("ruleFeatures") AND
     COALESCE(jsonb_typeof("lineageState") = 'object' AND
        "lineageState"->'version' = '1'::jsonb AND
        jsonb_typeof("lineageState"->'config') = 'object' AND
        jsonb_typeof("lineageState"->'persons') = 'object' AND
        jsonb_typeof("lineageState"->'marriages') = 'array' AND
        jsonb_typeof("lineageState"->'offers') = 'array', FALSE))
);

ALTER TABLE "General" ADD COLUMN "sex" TEXT;
ALTER TABLE "General" ADD CONSTRAINT "General_sex_check" CHECK (
    "sex" IS NULL OR "sex" IN ('MALE', 'FEMALE', 'UNKNOWN')
);

CREATE FUNCTION "guard_general_sex_immutable"() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."sex" IS DISTINCT FROM OLD."sex" THEN
        RAISE EXCEPTION 'General_sex_immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "General_sex_immutable"
BEFORE UPDATE OF "sex" ON "General"
FOR EACH ROW EXECUTE FUNCTION "guard_general_sex_immutable"();
