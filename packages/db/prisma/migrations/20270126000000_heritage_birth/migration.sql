ALTER TABLE "HeritageEntry" DROP CONSTRAINT "HeritageEntry_delta_check";
ALTER TABLE "HeritageEntry" ADD CONSTRAINT "HeritageEntry_delta_check" CHECK (
    ("kind" = 'SEASON_CREDIT' AND "delta" BETWEEN 1 AND 5) OR
    ("kind" = 'CREATION_SPEND' AND (
        ("delta" BETWEEN -6 AND -1 AND NOT ("detail" ? 'birth')) OR
        ("delta" BETWEEN -9506 AND -1000 AND "detail"->'version' = '2'::jsonb AND jsonb_typeof("detail"->'birth') = 'object') IS TRUE
    )) OR
    ("kind" = 'CREATION_REFUND' AND (
        ("delta" BETWEEN 1 AND 6 AND NOT ("detail" ? 'birth')) OR
        ("delta" BETWEEN 1000 AND 9506 AND "detail"->'version' = '2'::jsonb AND "detail"->'birth' = 'true'::jsonb) IS TRUE
    )) OR
    ("kind" = 'BENEFIT_SPEND' AND (
        ("delta" BETWEEN -15 AND -1) OR
        ("detail" ? 'stats' AND "delta" = -1000) OR
        (("detail" ? 'heritageSpecialty' OR "detail" ? 'heritageTurnTime') AND "delta" BETWEEN -2147483647 AND -1000)
    )) OR
    ("kind" = 'SPECIALTY_REFUND' AND "delta" = 4000) OR
    ("kind" = 'FORFEIT' AND "delta" < 0)
);
