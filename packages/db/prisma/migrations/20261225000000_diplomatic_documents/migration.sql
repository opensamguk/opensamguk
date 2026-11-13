CREATE TYPE "DiplomaticDocumentStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'CANCELLED', 'REPLACED');

CREATE TABLE "DiplomaticDocument" (
    "worldId" TEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "requestId" UUID NOT NULL,
    "fromNationId" INTEGER NOT NULL,
    "toNationId" INTEGER NOT NULL,
    "fromNationName" TEXT NOT NULL,
    "toNationName" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "senderName" TEXT NOT NULL,
    "responderName" TEXT,
    "previousId" INTEGER,
    "status" "DiplomaticDocumentStatus" NOT NULL DEFAULT 'PROPOSED',
    "brief" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "responseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiplomaticDocument_pkey" PRIMARY KEY ("worldId", "id"),
    CONSTRAINT "DiplomaticDocument_distinct_parties" CHECK ("fromNationId" <> "toNationId"),
    CONSTRAINT "DiplomaticDocument_preceding_id" CHECK ("previousId" < "id")
);

CREATE UNIQUE INDEX "DiplomaticDocument_worldId_requestId_key" ON "DiplomaticDocument"("worldId", "requestId");
CREATE INDEX "DiplomaticDocument_worldId_fromNationId_id_idx" ON "DiplomaticDocument"("worldId", "fromNationId", "id");
CREATE INDEX "DiplomaticDocument_worldId_toNationId_id_idx" ON "DiplomaticDocument"("worldId", "toNationId", "id");
CREATE INDEX "DiplomaticDocument_worldId_previousId_idx" ON "DiplomaticDocument"("worldId", "previousId");

ALTER TABLE "DiplomaticDocument" ADD CONSTRAINT "DiplomaticDocument_worldId_fkey"
    FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiplomaticDocument" ADD CONSTRAINT "DiplomaticDocument_worldId_previousId_fkey"
    FOREIGN KEY ("worldId", "previousId") REFERENCES "DiplomaticDocument"("worldId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
