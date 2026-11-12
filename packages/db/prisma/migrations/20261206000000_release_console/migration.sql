CREATE TYPE "ReleaseOperation" AS ENUM ('DEPLOY', 'ROLLBACK');
CREATE TYPE "ReleaseRequestStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NEEDS_OWNER');

CREATE TABLE "ReleaseControl" (
    "id" TEXT NOT NULL,
    "currentRevision" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReleaseControl_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReleaseRequest" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "operation" "ReleaseOperation" NOT NULL,
    "expectedRevision" TEXT NOT NULL,
    "targetRevision" TEXT NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "status" "ReleaseRequestStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "ReleaseRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReleaseRequest_status_requestedAt_idx" ON "ReleaseRequest"("status", "requestedAt");
