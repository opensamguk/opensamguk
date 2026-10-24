BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "InputEvent" ADD COLUMN "stepTick" INTEGER;
ALTER TABLE "InputEvent" ADD CONSTRAINT "InputEvent_stepTick_check"
  CHECK ("stepTick" IS NULL OR ("status" = 'APPLIED' AND "stepTick" >= 0)) NOT VALID;
ALTER TABLE "InputEvent" VALIDATE CONSTRAINT "InputEvent_stepTick_check";
COMMIT;
