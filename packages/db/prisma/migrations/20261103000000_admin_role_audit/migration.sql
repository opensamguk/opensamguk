CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "AuditActorKind" AS ENUM ('ADMIN', 'CLI', 'ENGINE');

ALTER TABLE "User" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';

CREATE TABLE "AuditLog" (
  "id" BIGSERIAL PRIMARY KEY,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorKind" "AuditActorKind" NOT NULL,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "worldId" TEXT,
  "reason" TEXT,
  "payload" JSONB NOT NULL,
  "inputEventId" BIGINT
);

CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
CREATE INDEX "AuditLog_actorUserId_at_idx" ON "AuditLog"("actorUserId", "at");
CREATE INDEX "AuditLog_worldId_at_idx" ON "AuditLog"("worldId", "at");

CREATE FUNCTION "audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AuditLog_reject_changes"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();
CREATE TRIGGER "AuditLog_reject_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();
