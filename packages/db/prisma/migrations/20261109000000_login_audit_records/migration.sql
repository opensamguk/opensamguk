CREATE TABLE "LoginRecord" (
  id BIGSERIAL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success BOOLEAN NOT NULL,
  "ipHash" VARCHAR(64) NOT NULL,
  "deviceHash" VARCHAR(64),
  "hashKeyVersion" INTEGER NOT NULL,
  CONSTRAINT "LoginRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LoginRecord_ipHash_check" CHECK ("ipHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "LoginRecord_deviceHash_check" CHECK ("deviceHash" IS NULL OR "deviceHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "LoginRecord_hashKeyVersion_check" CHECK ("hashKeyVersion" > 0)
);
CREATE INDEX "LoginRecord_userId_at_idx" ON "LoginRecord"("userId",at);
CREATE INDEX "LoginRecord_hashKeyVersion_ipHash_at_idx" ON "LoginRecord"("hashKeyVersion","ipHash",at);
CREATE INDEX "LoginRecord_hashKeyVersion_deviceHash_at_idx" ON "LoginRecord"("hashKeyVersion","deviceHash",at);
