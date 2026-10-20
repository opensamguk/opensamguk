-- AlterTable
ALTER TABLE "World" ADD COLUMN     "clockAnchorAt" TIMESTAMP(3),
ADD COLUMN     "clockRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);
