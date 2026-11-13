CREATE TYPE "DiplomaticDelegateRole" AS ENUM ('AMBASSADOR', 'ADVISER');

CREATE TABLE "DiplomaticDelegate" (
    "worldId" TEXT NOT NULL,
    "nationId" INTEGER NOT NULL,
    "generalId" INTEGER NOT NULL,
    "role" "DiplomaticDelegateRole" NOT NULL,
    CONSTRAINT "DiplomaticDelegate_pkey" PRIMARY KEY ("worldId", "generalId"),
    CONSTRAINT "DiplomaticDelegate_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiplomaticDelegate_nation_fkey" FOREIGN KEY ("worldId", "nationId") REFERENCES "Nation"("worldId", "id") ON DELETE CASCADE,
    CONSTRAINT "DiplomaticDelegate_general_fkey" FOREIGN KEY ("worldId", "generalId") REFERENCES "General"("worldId", "id") ON DELETE CASCADE
);
CREATE INDEX "DiplomaticDelegate_worldId_nationId_role_idx" ON "DiplomaticDelegate"("worldId", "nationId", "role");

CREATE FUNCTION "revokeDiplomaticDelegate"() RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM "DiplomaticDelegate" WHERE "worldId" = OLD."worldId" AND "generalId" = OLD.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "revokeDiplomaticDelegateAfterTransfer"
AFTER UPDATE OF "nationId", "userId", "removedAt" ON "General"
FOR EACH ROW WHEN (
    OLD."nationId" IS DISTINCT FROM NEW."nationId" OR
    OLD."userId" IS DISTINCT FROM NEW."userId" OR
    OLD."removedAt" IS DISTINCT FROM NEW."removedAt"
)
EXECUTE FUNCTION "revokeDiplomaticDelegate"();
