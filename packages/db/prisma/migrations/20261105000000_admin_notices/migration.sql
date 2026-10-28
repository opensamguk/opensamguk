ALTER TABLE "Notice" ADD COLUMN "hiddenAt" TIMESTAMPTZ(3),
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Notice_revision_check" CHECK ("revision" >= 0);

CREATE TABLE "AdminNoticeRequest" (
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "noticeId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "hidden" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminNoticeRequest_pkey" PRIMARY KEY ("actorUserId", "idempotencyKey"),
  CONSTRAINT "AdminNoticeRequest_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "AdminNoticeRequest_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$')
);
