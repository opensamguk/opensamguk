CREATE TABLE "NationBoardPost" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "nationId" INTEGER NOT NULL,
    "confidential" BOOLEAN NOT NULL,
    "authorName" TEXT NOT NULL,
    "portraitId" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NationBoardPost_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NationBoardPost_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "NationBoardReply" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "portraitId" INTEGER,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NationBoardReply_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NationBoardReply_postId_fkey" FOREIGN KEY ("postId") REFERENCES "NationBoardPost"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "NationBoardPost_worldId_nationId_confidential_sentAt_id_idx" ON "NationBoardPost"("worldId", "nationId", "confidential", "sentAt", "id");
CREATE INDEX "NationBoardReply_postId_sentAt_id_idx" ON "NationBoardReply"("postId", "sentAt", "id");
