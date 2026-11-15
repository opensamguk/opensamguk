-- AC-INT-28 / D-097. Existing worlds are reset before adopting this schema.

ALTER TABLE "World" ADD COLUMN "fogOfWar" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "World" DROP COLUMN "ruleFeatures";

ALTER TABLE "World" ADD CONSTRAINT "World_operationalMap_rules_check" CHECK (

  ("operationalMap" IS NOT NULL AND "replayFormat" = 3)
);

ALTER TABLE "World" ADD CONSTRAINT "World_campaignState_rules_check" CHECK (

  (
    "campaignState" IS NOT NULL AND "replayFormat" = 3 AND
    COALESCE(
      jsonb_typeof("campaignState") = 'object' AND
      "campaignState"->'version' = '1'::jsonb AND
      jsonb_typeof("campaignState"->'revision') = 'number' AND
      "campaignState"->>'seed' = "seed",
      FALSE
    )
  )
);

ALTER TABLE "World" ADD CONSTRAINT "World_cityResourcesState_rules_check" CHECK (

  (
    "cityResourcesState" IS NOT NULL AND "replayFormat" = 3 AND
    COALESCE(
      jsonb_typeof("cityResourcesState") = 'object' AND
      "cityResourcesState"->'version' = '1'::jsonb AND
      jsonb_typeof("cityResourcesState"->'cities') = 'object',
      FALSE
    )
  )
);

ALTER TABLE "World" ADD CONSTRAINT "World_logisticsState_rules_check" CHECK (

    ("logisticsState" IS NOT NULL AND "replayFormat" = 3 AND
     COALESCE(jsonb_typeof("logisticsState") = 'object' AND
        "logisticsState"->'version' = '1'::jsonb AND
        jsonb_typeof("logisticsState"->'config') = 'object' AND
        jsonb_typeof("logisticsState"->'cities') = 'object' AND
        jsonb_typeof("logisticsState"->'convoys') = 'array', FALSE))
);

ALTER TABLE "World" ADD CONSTRAINT "World_governanceState_rules_check" CHECK (

    ("governanceState" IS NOT NULL AND "replayFormat" = 3 AND
     COALESCE(jsonb_typeof("governanceState") = 'object' AND
        "governanceState"->'version' = '1'::jsonb AND
        jsonb_typeof("governanceState"->'config') = 'object' AND
        jsonb_typeof("governanceState"->'throne') = 'object' AND
        jsonb_typeof("governanceState"->'court') = 'object' AND
        jsonb_typeof("governanceState"->'vassals') = 'array' AND
        jsonb_typeof("governanceState"->'offers') = 'array', FALSE))
);

ALTER TABLE "World" ADD CONSTRAINT "World_lineageState_rules_check" CHECK (

    ("lineageState" IS NOT NULL AND "replayFormat" = 3 AND
     COALESCE(jsonb_typeof("lineageState") = 'object' AND
        "lineageState"->'version' = '1'::jsonb AND
        jsonb_typeof("lineageState"->'config') = 'object' AND
        jsonb_typeof("lineageState"->'persons') = 'object' AND
        jsonb_typeof("lineageState"->'marriages') = 'array' AND
        jsonb_typeof("lineageState"->'offers') = 'array', FALSE))
);

ALTER TABLE "World" ADD CONSTRAINT "World_heritage_rules_check" CHECK (

    NOT (TRUE) OR
    ("replayFormat" = 3)
);

ALTER TABLE "World" ADD CONSTRAINT "World_stratagemCardsState_rules_check" CHECK (

    ("stratagemCardsState" IS NOT NULL AND "replayFormat" = 3 AND
     COALESCE(jsonb_typeof("stratagemCardsState") = 'object' AND
        "stratagemCardsState"->'version' = '1'::jsonb AND
        jsonb_typeof("stratagemCardsState"->'config') = 'object' AND
        jsonb_typeof("stratagemCardsState"->'nations') = 'object', FALSE))
);

ALTER TABLE "World" ADD CONSTRAINT "World_equipmentState_rules_check" CHECK (

    ("equipmentState" IS NOT NULL AND "replayFormat" = 3 AND
     COALESCE(jsonb_typeof("equipmentState") = 'object' AND
        "equipmentState"->'version' = '1'::jsonb AND
        jsonb_typeof("equipmentState"->'config') = 'object' AND
        jsonb_typeof("equipmentState"->'generals') = 'object', FALSE))
);

ALTER TABLE "World" ADD CONSTRAINT "World_cityRuinsState_rules_check" CHECK (

  (
    "cityRuinsState" IS NOT NULL AND "replayFormat" = 3 AND
    COALESCE(
      jsonb_typeof("cityRuinsState") = 'object' AND
      "cityRuinsState"->'version' = '1'::jsonb AND
      jsonb_typeof("cityRuinsState"->'cities') = 'array',
      FALSE
    )
  )
);

ALTER TABLE "World" ADD CONSTRAINT "World_nationStrategyState_rules_check" CHECK (

  (
    "nationStrategyState" IS NOT NULL AND "replayFormat" = 3 AND
    COALESCE(
      jsonb_typeof("nationStrategyState") = 'object' AND
      "nationStrategyState"->'version' = '1'::jsonb AND
      jsonb_typeof("nationStrategyState"->'nations') = 'object',
      FALSE
    )
  )
);

ALTER TABLE "World" ADD CONSTRAINT "World_nationLifecycleState_rules_check" CHECK (

  (
    "nationLifecycleState" IS NOT NULL AND "replayFormat" = 3 AND
    COALESCE(
      jsonb_typeof("nationLifecycleState") = 'object' AND
      "nationLifecycleState"->'version' = '1'::jsonb AND
      jsonb_typeof("nationLifecycleState"->'nations') = 'object',
      FALSE
    )
  )
);

ALTER TABLE "World" ADD CONSTRAINT "World_preparedTurnsState_rules_check" CHECK (

  (
    "preparedTurnsState" IS NOT NULL AND "replayFormat" = 3 AND
    COALESCE(
      jsonb_typeof("preparedTurnsState") = 'object' AND
      "preparedTurnsState"->'version' = '1'::jsonb AND
      jsonb_typeof("preparedTurnsState"->'nations') = 'object', FALSE
    )
  )
);

ALTER TABLE "World" ADD CONSTRAINT "World_nationResearchState_rules_check" CHECK (

  (
    "nationResearchState" IS NOT NULL AND "replayFormat" = 3 AND
    COALESCE(
      jsonb_typeof("nationResearchState") = 'object' AND
      "nationResearchState"->'version' = '1'::jsonb AND
      jsonb_typeof("nationResearchState"->'nations') = 'object', FALSE
    )
  )
);
