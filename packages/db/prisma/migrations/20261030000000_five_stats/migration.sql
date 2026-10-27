-- INT-14 / AC-INT-14. 기존 행은 NULL을 유지하고 새 판만 두 값을 함께 저장한다.
ALTER TABLE "General" ADD COLUMN "politics" INTEGER, ADD COLUMN "charm" INTEGER;
ALTER TABLE "General" ADD CONSTRAINT "General_five_stats_pair_range" CHECK (
  ("politics" IS NULL AND "charm" IS NULL) OR
  ("politics" IS NOT NULL AND "charm" IS NOT NULL AND
   "leadership" BETWEEN 0 AND 100 AND "strength" BETWEEN 0 AND 100 AND "intel" BETWEEN 0 AND 100 AND
   "politics" BETWEEN 0 AND 100 AND "charm" BETWEEN 0 AND 100)
);
