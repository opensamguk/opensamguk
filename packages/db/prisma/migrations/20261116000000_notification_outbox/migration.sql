-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'SENDING', 'RETRY', 'SENT', 'UNKNOWN', 'GAVE_UP');

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimId" TEXT,
    "claimedAt" TIMESTAMPTZ(3),
    "targetId" TEXT,
    "generation" INTEGER,
    "resultCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDispatchGate" (
    "id" TEXT NOT NULL,
    "blockedUntil" TIMESTAMPTZ(3),

    CONSTRAINT "NotificationDispatchGate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_key" ON "NotificationOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_nextAttemptAt_createdAt_id_idx" ON "NotificationOutbox"("status", "nextAttemptAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "NotificationOutbox_userId_idx" ON "NotificationOutbox"("userId");

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationOutbox"
  ADD CONSTRAINT "NotificationOutbox_event_check" CHECK ("event" IN ('turn.failed','attacked','diplomacy.offer','turns.low')),
  ADD CONSTRAINT "NotificationOutbox_attempts_check" CHECK ("attempts" BETWEEN 0 AND 4),
  ADD CONSTRAINT "NotificationOutbox_dedupe_check" CHECK (length("dedupeKey") BETWEEN 1 AND 255),
  ADD CONSTRAINT "NotificationOutbox_generation_check" CHECK ("generation" IS NULL OR "generation" >= 0),
  ADD CONSTRAINT "NotificationOutbox_payload_check" CHECK (jsonb_typeof("payload")='object' AND ("payload"->>'worldId') IS NOT NULL AND "payload"->>'worldId'="worldId"),
  ADD CONSTRAINT "NotificationOutbox_sending_check" CHECK ("status" <> 'SENDING' OR ("attempts">0 AND "claimId" IS NOT NULL AND "claimedAt" IS NOT NULL AND "targetId" IS NOT NULL AND "generation" IS NOT NULL)),
  ADD CONSTRAINT "NotificationOutbox_result_check" CHECK ("resultCode" IS NULL OR "resultCode" ~ '^[A-Z0-9_]{1,32}$');
ALTER TABLE "NotificationDispatchGate" ADD CONSTRAINT "NotificationDispatchGate_singleton_check" CHECK (id='discord');
INSERT INTO "NotificationDispatchGate" (id,"blockedUntil") VALUES ('discord',NULL);
