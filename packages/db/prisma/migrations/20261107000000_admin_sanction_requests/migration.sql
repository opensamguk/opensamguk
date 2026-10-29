CREATE TABLE "AdminSanctionRequest" (
    "actorUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "sanctionId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminSanctionRequest_pkey" PRIMARY KEY ("actorUserId", "idempotencyKey"),
    CONSTRAINT "AdminSanctionRequest_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$')
);
