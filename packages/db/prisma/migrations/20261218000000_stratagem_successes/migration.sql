ALTER TABLE "General" ADD COLUMN "stratagemSuccesses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SeasonGeneral" ADD COLUMN "stratagemSuccesses" INTEGER NOT NULL DEFAULT 0;

WITH successes AS (
  SELECT "worldId", "generalId", COUNT(*)::integer AS total
  FROM "GeneralLog"
  WHERE "kind" = 'success' AND (
    ("commandKey" = 'fire_attack' AND "text" LIKE '화계 성공: %') OR
    ("commandKey" = 'sabotage' AND "text" LIKE '파괴 성공: %') OR
    ("commandKey" = 'incite' AND "text" LIKE '선동 성공: %') OR
    ("commandKey" = 'plunder' AND "text" LIKE '탈취 성공: %')
  )
  GROUP BY "worldId", "generalId"
)
UPDATE "General" AS g SET "stratagemSuccesses" = s.total
FROM successes AS s WHERE g."worldId" = s."worldId" AND g.id = s."generalId";

UPDATE "SeasonGeneral" AS s SET "stratagemSuccesses" = g."stratagemSuccesses"
FROM "General" AS g WHERE g."worldId" = s."worldId" AND g.id = s."generalId";
