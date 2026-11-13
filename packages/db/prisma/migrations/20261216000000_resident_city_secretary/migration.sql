ALTER TABLE "General" DROP CONSTRAINT "General_officerCityKey_level_check";
ALTER TABLE "General" ADD CONSTRAINT "General_officerCityKey_level_check"
  CHECK ("officerCityKey" IS NULL OR ("officerCityKey" > 0 AND "officerLevel" IN (2, 3, 4)));
