ALTER TABLE "User"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "retentionPurgedAt" TIMESTAMP(3);

-- Existing tombstones have no reliable withdrawal time. Start their minimum retention here.
UPDATE "User"
SET "withdrawnAt" = statement_timestamp() AT TIME ZONE 'UTC'
WHERE "status" = 'WITHDRAWN';

-- The previous release may still perform withdrawals during an additive rollback.
CREATE FUNCTION "stamp_account_withdrawal"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."status" = 'WITHDRAWN' AND OLD."status" <> 'WITHDRAWN' AND NEW."withdrawnAt" IS NULL THEN
    NEW."withdrawnAt" := statement_timestamp() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "User_stamp_withdrawal"
  BEFORE UPDATE OF "status" ON "User"
  FOR EACH ROW EXECUTE FUNCTION "stamp_account_withdrawal"();

CREATE INDEX "User_status_retentionPurgedAt_withdrawnAt_id_idx"
  ON "User"("status", "retentionPurgedAt", "withdrawnAt", "id");
CREATE INDEX "AdminSanctionRequest_sanctionId_idx" ON "AdminSanctionRequest"("sanctionId");
CREATE INDEX "AuditLog_sanction_retention_target_idx" ON "AuditLog"("targetId")
  WHERE "targetType" = 'User' AND "action" IN ('sanction.create', 'sanction.lift') AND "targetId" IS NOT NULL;

CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."targetType" = 'User'
      AND OLD."action" IN ('sanction.create', 'sanction.lift')
      AND OLD."targetId" IS NOT NULL
      AND ROW(NEW."id", NEW."at", NEW."actorKind", NEW."actorUserId", NEW."action", NEW."targetType", NEW."inputEventId")
        IS NOT DISTINCT FROM
        ROW(OLD."id", OLD."at", OLD."actorKind", OLD."actorUserId", OLD."action", OLD."targetType", OLD."inputEventId")
      AND NEW."targetId" IS NULL AND NEW."worldId" IS NULL AND NEW."reason" IS NULL
      AND NEW."payload" = '{"retentionRedacted":true}'::jsonb
      AND EXISTS (
        SELECT FROM public."User" account
        WHERE account."id" = OLD."targetId" AND account."status" = 'WITHDRAWN'
          AND account."retentionPurgedAt" IS NULL
          AND account."withdrawnAt" + interval '1 year' <= statement_timestamp() AT TIME ZONE 'UTC'
      )
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION "purge_expired_account_records"() RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  purge_time timestamp := statement_timestamp() AT TIME ZONE 'UTC';
  targets text[];
BEGIN
  SELECT array_agg(candidate."id") INTO targets
  FROM (
    SELECT account."id"
    FROM public."User" account
    WHERE account."status" = 'WITHDRAWN' AND account."retentionPurgedAt" IS NULL
      AND account."withdrawnAt" + interval '1 year' <= purge_time
    ORDER BY account."withdrawnAt", account."id"
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  ) candidate;

  IF targets IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public."ConsentRecord" WHERE "userId" = ANY(targets);
  DELETE FROM public."AdminSanctionRequest" request USING public."Sanction" sanction
  WHERE request."sanctionId" = sanction."id" AND sanction."userId" = ANY(targets);
  DELETE FROM public."Sanction" WHERE "userId" = ANY(targets);

  UPDATE public."AuditLog"
  SET "targetId" = NULL, "worldId" = NULL, "reason" = NULL, "payload" = '{"retentionRedacted":true}'::jsonb
  WHERE "targetType" = 'User' AND "action" IN ('sanction.create', 'sanction.lift') AND "targetId" = ANY(targets);

  UPDATE public."User" SET "retentionPurgedAt" = purge_time WHERE "id" = ANY(targets);
  RETURN cardinality(targets);
END;
$$;
