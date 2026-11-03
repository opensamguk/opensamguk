ALTER TABLE "World" ADD CONSTRAINT "World_heritage_feature_check" CHECK (
    NOT ('heritage-v1' = ANY("ruleFeatures")) OR
    ("replayFormat" = 3 AND 'policy' = ANY("ruleFeatures"))
);

CREATE TABLE "HeritageAccount" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "balance" INTEGER NOT NULL DEFAULT 0 CHECK ("balance" >= 0),
    CONSTRAINT "HeritageAccount_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE TABLE "HeritageEntry" (
    "id" BIGSERIAL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "worldId" TEXT,
    "delta" INTEGER NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HeritageEntry_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "HeritageEntry_delta_check" CHECK (
        ("kind" = 'SEASON_CREDIT' AND "delta" BETWEEN 1 AND 5) OR
        ("kind" = 'CREATION_SPEND' AND "delta" BETWEEN -6 AND -1) OR
        ("kind" = 'CREATION_REFUND' AND "delta" BETWEEN 1 AND 6) OR
        ("kind" = 'FORFEIT' AND "delta" < 0)
    ),
    CONSTRAINT "HeritageEntry_world_check" CHECK ("kind" = 'FORFEIT' OR "worldId" IS NOT NULL),
    CONSTRAINT "HeritageEntry_detail_check" CHECK (jsonb_typeof("detail") = 'object')
);
CREATE UNIQUE INDEX "HeritageEntry_userId_key_key" ON "HeritageEntry"("userId", "key");
CREATE INDEX "HeritageEntry_userId_id_idx" ON "HeritageEntry"("userId", "id");
CREATE INDEX "HeritageEntry_worldId_kind_idx" ON "HeritageEntry"("worldId", "kind");

CREATE FUNCTION "guard_heritage_entry_immutable"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'HeritageEntry_immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HeritageEntry_immutable"
BEFORE UPDATE OR DELETE ON "HeritageEntry"
FOR EACH ROW EXECUTE FUNCTION "guard_heritage_entry_immutable"();
