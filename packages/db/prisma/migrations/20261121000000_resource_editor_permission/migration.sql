CREATE TABLE "ResourceEditorGrant" (
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResourceEditorGrant_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "ResourceEditorGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
