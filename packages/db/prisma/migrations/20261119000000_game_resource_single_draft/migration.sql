BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX "GameResource_one_draft_per_name_key"
    ON "GameResource" ("kind", "name") WHERE "status" = 'DRAFT';

COMMIT;
