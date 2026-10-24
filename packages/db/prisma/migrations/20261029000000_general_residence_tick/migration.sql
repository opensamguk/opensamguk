ALTER TABLE "General"
  ADD COLUMN "residenceTick" INTEGER,
  ADD CONSTRAINT "General_residenceTick_check" CHECK ("residenceTick" IS NULL OR "residenceTick" >= 0);
