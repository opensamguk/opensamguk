ALTER TABLE "Nation" ADD COLUMN "diplomaticAidUntilMonth" INTEGER;
ALTER TABLE "Nation" ADD CONSTRAINT "Nation_diplomaticAidUntilMonth_nonnegative"
  CHECK ("diplomaticAidUntilMonth" >= 0);
