CREATE TYPE "WorldCreateStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');
CREATE TABLE "WorldCreateRequest" (
  "id" TEXT PRIMARY KEY,
  "requestedBy" TEXT NOT NULL REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  "idempotencyKey" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" = 1),
  "intentHash" TEXT NOT NULL CHECK ("intentHash" ~ '^[a-f0-9]{64}$'),
  "intent" JSONB NOT NULL CHECK (jsonb_typeof("intent") = 'object'),
  "effectiveSeed" TEXT NOT NULL CHECK (length("effectiveSeed") > 0),
  "plannedWorldId" TEXT NOT NULL,
  "resolution" JSONB CHECK ("resolution" IS NULL OR jsonb_typeof("resolution") = 'object'),
  "status" "WorldCreateStatus" NOT NULL DEFAULT 'PENDING',
  "worldId" TEXT REFERENCES "World"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "WorldCreateRequest_status_check" CHECK (
    ("status" = 'PENDING' AND "worldId" IS NULL AND "errorCode" IS NULL AND "processedAt" IS NULL) OR
    ("status" = 'DONE' AND "worldId" = "plannedWorldId" AND "worldId" IS NOT NULL AND "resolution" IS NOT NULL AND "errorCode" IS NULL AND "processedAt" IS NOT NULL) OR
    ("status" = 'FAILED' AND "worldId" IS NULL AND "errorCode" IN ('ACTOR_INACTIVE','ADMIN_REQUIRED','ACTOR_SANCTIONED','RESOURCE_INVALID','INPUT_INVALID') AND "errorCode" IS NOT NULL AND "processedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "WorldCreateRequest_requestedBy_idempotencyKey_key" ON "WorldCreateRequest"("requestedBy", "idempotencyKey");
CREATE UNIQUE INDEX "WorldCreateRequest_plannedWorldId_key" ON "WorldCreateRequest"("plannedWorldId");
CREATE UNIQUE INDEX "WorldCreateRequest_worldId_key" ON "WorldCreateRequest"("worldId");
CREATE INDEX "WorldCreateRequest_status_createdAt_id_idx" ON "WorldCreateRequest"("status", "createdAt", "id");
CREATE FUNCTION world_create_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy" OR
     NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."version" IS DISTINCT FROM OLD."version" OR
     NEW."intentHash" IS DISTINCT FROM OLD."intentHash" OR NEW."intent" IS DISTINCT FROM OLD."intent" OR
     NEW."effectiveSeed" IS DISTINCT FROM OLD."effectiveSeed" OR NEW."plannedWorldId" IS DISTINCT FROM OLD."plannedWorldId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."resolution" IS NOT NULL AND NEW."resolution" IS DISTINCT FROM OLD."resolution") OR
     (OLD."status" <> 'PENDING' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'World create request is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorldCreateRequest_immutable" BEFORE UPDATE ON "WorldCreateRequest"
FOR EACH ROW EXECUTE FUNCTION world_create_request_immutable();
