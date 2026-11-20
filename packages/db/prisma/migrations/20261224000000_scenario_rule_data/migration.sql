-- AC-INT-28 / D-104: maps without an operational ledger use their city connections.
ALTER TABLE "World" DROP CONSTRAINT "World_operationalMap_rules_check";
ALTER TABLE "World" ADD CONSTRAINT "World_operationalMap_rules_check" CHECK (
  "replayFormat" = 3 AND (
    "operationalMap" IS NULL OR COALESCE("statRules"->>'count' = '5', FALSE)
  )
);
