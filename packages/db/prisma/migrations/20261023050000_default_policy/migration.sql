BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE "World", "General", "GeneralTurn", "InputEvent" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "World" ADD COLUMN "policyFromSequence" INTEGER;
ALTER TABLE "General"
  ADD COLUMN "defaultPolicy" TEXT,
  ADD COLUMN "lastActiveTick" INTEGER,
  ADD COLUMN "lastActiveAt" TIMESTAMP(3),
  ADD CONSTRAINT "General_defaultPolicy_check" CHECK ("defaultPolicy" IS NULL OR "defaultPolicy" IN ('none','farm','commerce','security','defend','drill')),
  ADD CONSTRAINT "General_lastActiveTick_check" CHECK ("lastActiveTick" IS NULL OR "lastActiveTick" >= 0);
ALTER TABLE "GeneralTurn" ADD COLUMN explicit BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GeneralTurn" ALTER COLUMN explicit DROP DEFAULT;
ALTER TABLE "GeneralTurn" ADD CONSTRAINT "GeneralTurn_empty_check" CHECK (explicit OR ("commandKey" = 'rest' AND args = '{}'::jsonb));

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "General" g JOIN "World" w ON w.id=g."worldId"
    LEFT JOIN "GeneralTurn" t ON t."worldId"=g."worldId" AND t."generalId"=g.id
    WHERE w.status <> 'ENDED'
    GROUP BY g."worldId",g.id
    HAVING count(t.slot) NOT IN (0,30) OR (count(t.slot)=30 AND (min(t.slot)<>0 OR max(t.slot)<>29))
  ) THEN RAISE EXCEPTION 'Invalid legacy turn slot set'; END IF;
  IF EXISTS (SELECT 1 FROM "InputEvent" WHERE kind='system.policy.enable') THEN
    RAISE EXCEPTION 'Policy transition already exists';
  END IF;
END $$;

CREATE TEMP TABLE "PolicyEmptyGeneral" ON COMMIT DROP AS
  SELECT g."worldId", g.id FROM "General" g JOIN "World" w ON w.id=g."worldId"
  WHERE w.status <> 'ENDED' AND NOT EXISTS (
    SELECT 1 FROM "GeneralTurn" t WHERE t."worldId"=g."worldId" AND t."generalId"=g.id
  );
INSERT INTO "GeneralTurn" ("worldId","generalId",slot,"commandKey",args,explicit)
  SELECT e."worldId",e.id,s,'rest','{}'::jsonb,false
  FROM "PolicyEmptyGeneral" e CROSS JOIN generate_series(0,29) s;

CREATE UNIQUE INDEX "InputEvent_pending_active_unique" ON "InputEvent" ("worldId","generalId")
  WHERE status='PENDING' AND kind='general.active';
CREATE UNIQUE INDEX "InputEvent_pending_policy_unique" ON "InputEvent" ("worldId","generalId")
  WHERE status='PENDING' AND kind='general.setPolicy';
CREATE UNIQUE INDEX "InputEvent_policy_transition_unique" ON "InputEvent" ("worldId")
  WHERE kind='system.policy.enable';

INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
  SELECT w.id,'system:policy',NULL,'system.policy.enable','system.policy.enable:5',
    jsonb_build_object('version',5,'emptySlots',COALESCE(
      (SELECT jsonb_agg(e.id ORDER BY e.id) FROM "PolicyEmptyGeneral" e WHERE e."worldId"=w.id),'[]'::jsonb
    )),'PENDING'
  FROM "World" w WHERE w.status <> 'ENDED';
COMMIT;
