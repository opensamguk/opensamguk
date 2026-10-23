-- CreateEnum
CREATE TYPE "MessageScope" AS ENUM ('PRIVATE', 'NATION', 'DIPLOMACY', 'WORLD');

-- CreateEnum
CREATE TYPE "NoticeScope" AS ENUM ('LOBBY', 'WORLD');

-- AlterTable
ALTER TABLE "Nation" ADD COLUMN     "notice" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "noticeRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "noticeUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "noticeUpdatedBy" TEXT;

-- AlterTable
ALTER TABLE "General" ADD COLUMN     "noticeSeen" JSONB;

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "scope" "MessageScope" NOT NULL,
    "senderId" INTEGER,
    "senderNationId" INTEGER,
    "recipientId" INTEGER,
    "recipientNationId" INTEGER,
    "fromParty" JSONB NOT NULL,
    "toParty" JSONB,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageRead" (
    "worldId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "generalId" INTEGER NOT NULL,

    CONSTRAINT "MessageRead_pkey" PRIMARY KEY ("messageId","generalId")
);

-- CreateTable
CREATE TABLE "Notice" (
    "id" TEXT NOT NULL,
    "scope" "NoticeScope" NOT NULL,
    "worldId" TEXT,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_worldId_scope_sentAt_id_idx" ON "Message"("worldId", "scope", "sentAt", "id");

-- CreateIndex
CREATE INDEX "Message_worldId_senderId_sentAt_idx" ON "Message"("worldId", "senderId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_worldId_id_key" ON "Message"("worldId", "id");

-- CreateIndex
CREATE INDEX "Notice_scope_worldId_publishedAt_id_idx" ON "Notice"("scope", "worldId", "publishedAt", "id");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRead" ADD CONSTRAINT "MessageRead_worldId_messageId_fkey" FOREIGN KEY ("worldId", "messageId") REFERENCES "Message"("worldId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRead" ADD CONSTRAINT "MessageRead_worldId_generalId_fkey" FOREIGN KEY ("worldId", "generalId") REFERENCES "General"("worldId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

