ALTER TABLE "User" ADD COLUMN "notificationGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD CONSTRAINT "User_notificationGeneration_check" CHECK ("notificationGeneration" >= 0);

CREATE TYPE "NotificationTargetStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TABLE "NotificationTarget" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'DISCORD',
  "endpoint" TEXT NOT NULL,
  "last4" TEXT NOT NULL,
  "events" TEXT[] NOT NULL,
  "status" "NotificationTargetStatus" NOT NULL DEFAULT 'ACTIVE',
  "disabledReason" TEXT,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationTarget_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationTarget_kind_check" CHECK ("kind" = 'DISCORD'),
  CONSTRAINT "NotificationTarget_last4_check" CHECK (char_length("last4") = 4),
  CONSTRAINT "NotificationTarget_reason_check" CHECK (
    ("status" = 'ACTIVE' AND "disabledReason" IS NULL) OR
    ("status" = 'DISABLED' AND "disabledReason" IS NOT NULL AND "disabledReason" = 'DISCORD_GONE')
  )
);
CREATE UNIQUE INDEX "NotificationTarget_userId_key" ON "NotificationTarget"("userId");
