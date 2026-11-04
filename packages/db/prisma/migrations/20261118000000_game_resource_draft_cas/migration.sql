BEGIN;

ALTER TABLE "GameResource"
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "updatedBy" TEXT,
    ADD COLUMN "updatedAt" TIMESTAMP(3),
    ADD COLUMN "publishedBy" TEXT,
    ADD CONSTRAINT "GameResource_revision_check" CHECK ("revision" >= 0);

CREATE OR REPLACE FUNCTION "reject_published_game_resource_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."status" = 'PUBLISHED' THEN
        RAISE EXCEPTION 'Published game resources cannot be updated or deleted';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Draft game resources cannot be deleted';
    END IF;
    IF ROW(NEW."id", NEW."kind", NEW."name", NEW."version", NEW."createdBy", NEW."createdAt", NEW."source")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."kind", OLD."name", OLD."version", OLD."createdBy", OLD."createdAt", OLD."source") THEN
        RAISE EXCEPTION 'Draft game resource identity cannot change';
    END IF;
    IF NEW."status" = 'DRAFT' THEN
        IF NEW."revision"::bigint <> OLD."revision"::bigint + 1 THEN
            RAISE EXCEPTION 'Draft game resource revision must increase by one';
        END IF;
    ELSIF NEW."revision" IS DISTINCT FROM OLD."revision"
       OR NEW."content" IS DISTINCT FROM OLD."content"
       OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" THEN
        RAISE EXCEPTION 'Publishing must preserve the saved revision, content and hash';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
