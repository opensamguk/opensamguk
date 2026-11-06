ALTER TABLE "World" ADD COLUMN "runtimeOptions" JSONB;
ALTER TABLE "World" ADD CONSTRAINT "World_runtimeOptions_object_check"
  CHECK ("runtimeOptions" IS NULL OR jsonb_typeof("runtimeOptions") = 'object');
