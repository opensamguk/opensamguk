ALTER TABLE "World" ADD COLUMN "replayFormat" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "ruleFeatures" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "InputEvent" ADD COLUMN "tick" INTEGER;
ALTER TABLE "InputEvent" ADD CONSTRAINT "InputEvent_pending_tick_check" CHECK ("status" <> 'PENDING' OR "tick" IS NULL);
