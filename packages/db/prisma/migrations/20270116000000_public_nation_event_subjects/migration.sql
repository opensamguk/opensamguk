ALTER TABLE "PublicNationEvent" ADD COLUMN "nationIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
CREATE INDEX "PublicNationEvent_nationIds_idx" ON "PublicNationEvent" USING GIN ("nationIds");
