BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "World" ADD COLUMN "personnelFormat" INTEGER;

COMMIT;
