BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "GameResourceKind" AS ENUM ('MAP', 'SCENARIO', 'UNIT_SET', 'STAT_RULES', 'PORTRAIT_MAP');

-- CreateEnum
CREATE TYPE "GameResourceStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "GameResource" (
    "id" TEXT NOT NULL,
    "kind" "GameResourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "GameResourceStatus" NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "GameResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameResource_kind_name_version_key" ON "GameResource"("kind", "name", "version");

ALTER TABLE "GameResource"
    ADD CONSTRAINT "GameResource_version_check" CHECK ("version" >= 1),
    ADD CONSTRAINT "GameResource_name_check" CHECK ("name" ~ '^[a-zA-Z0-9_-]+$'),
    ADD CONSTRAINT "GameResource_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "GameResource_publication_check" CHECK (("status" = 'PUBLISHED') = ("publishedAt" IS NOT NULL));

CREATE FUNCTION "reject_published_game_resource_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."status" = 'PUBLISHED' THEN
        RAISE EXCEPTION 'Published game resources cannot be updated or deleted';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "GameResource_published_immutable"
    BEFORE UPDATE OR DELETE ON "GameResource"
    FOR EACH ROW EXECUTE FUNCTION "reject_published_game_resource_mutation"();

COMMIT;
