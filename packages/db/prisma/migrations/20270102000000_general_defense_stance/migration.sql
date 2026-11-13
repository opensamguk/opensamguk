ALTER TABLE "General" ADD COLUMN "defenseThreshold" INTEGER
  CHECK ("defenseThreshold" IN (40, 60, 80, 90, 999));
