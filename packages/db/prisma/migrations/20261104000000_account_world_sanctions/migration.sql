CREATE TABLE "Sanction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "worldId" TEXT,
  "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "liftedAt" TIMESTAMP(3),
  "liftedBy" TEXT,
  "liftReason" TEXT,
  CONSTRAINT "Sanction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Sanction_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 200),
  CONSTRAINT "Sanction_lift_check" CHECK (
    ("liftedAt" IS NULL AND "liftedBy" IS NULL AND "liftReason" IS NULL) OR
    ("liftedAt" IS NOT NULL AND "liftedBy" IS NOT NULL AND "liftReason" IS NOT NULL AND length(btrim("liftReason")) BETWEEN 1 AND 200)
  )
);
CREATE INDEX "Sanction_userId_liftedAt_idx" ON "Sanction"("userId", "liftedAt");
CREATE INDEX "Sanction_worldId_idx" ON "Sanction"("worldId");
ALTER TABLE "Sanction" ADD CONSTRAINT "Sanction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Sanction" ADD CONSTRAINT "Sanction_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
