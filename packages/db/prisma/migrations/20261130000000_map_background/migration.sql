CREATE TABLE "MapBackground" (
    "resourceId" TEXT NOT NULL,
    "mapContentHash" TEXT NOT NULL CHECK ("mapContentHash" ~ '^[a-f0-9]{64}$'),
    "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
    "bytes" INTEGER NOT NULL CHECK ("bytes" > 0),
    "width" INTEGER NOT NULL CHECK ("width" > 0),
    "height" INTEGER NOT NULL CHECK ("height" > 0),
    "imageCommit" TEXT NOT NULL CHECK ("imageCommit" ~ '^[a-f0-9]{40}$'),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MapBackground_pkey" PRIMARY KEY ("resourceId"),
    CONSTRAINT "MapBackground_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "GameResource"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
