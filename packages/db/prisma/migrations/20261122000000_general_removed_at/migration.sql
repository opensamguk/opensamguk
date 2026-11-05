ALTER TABLE "General" ADD COLUMN "removedAt" INTEGER;
ALTER TABLE "General" ADD CONSTRAINT "General_removedAt_nonnegative" CHECK ("removedAt" IS NULL OR "removedAt" >= 0);
