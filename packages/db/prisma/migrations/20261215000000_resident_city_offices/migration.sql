ALTER TABLE "World" ADD COLUMN "officeEffects" JSONB;
ALTER TABLE "General" ADD COLUMN "officerCityKey" INTEGER;
ALTER TABLE "General" ADD CONSTRAINT "General_officerCityKey_level_check"
  CHECK ("officerCityKey" IS NULL OR ("officerCityKey" > 0 AND "officerLevel" IN (3, 4)));
ALTER TABLE "General" ADD CONSTRAINT "General_officerCityKey_fkey"
  FOREIGN KEY ("worldId", "officerCityKey") REFERENCES "City" ("worldId", "cityKey") ON DELETE NO ACTION;
CREATE UNIQUE INDEX "General_resident_office_slot_unique"
  ON "General" ("worldId", "officerCityKey", "officerLevel") WHERE "officerCityKey" IS NOT NULL;
ALTER TABLE "WorldCreateRequest" ADD COLUMN "officeEffects" JSONB;
