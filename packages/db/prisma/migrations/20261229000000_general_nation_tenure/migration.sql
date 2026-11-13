ALTER TABLE "General" ADD COLUMN "nationJoinedTick" INTEGER;
ALTER TABLE "General" ADD CONSTRAINT "General_nationJoinedTick_check"
    CHECK ("nationJoinedTick" >= 0);
