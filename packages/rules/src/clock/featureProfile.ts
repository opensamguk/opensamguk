import { cityUpgradeConfigSchema } from '../cityUpgrade/state';
import { z } from 'zod';
import { logisticsConfigSchema } from '../logistics/state';
import { governanceConfigSchema } from '../governance/config';
import { lineageConfigSchema } from '../lineage/config';
import { heritageFeatureDataSchema } from '../heritage/feature';
import { equipmentConfigSchema } from '../equipment/config';
import { resourceKeySchema } from '../world/resourceKey';
import { stratagemCardsFeatureDataSchema } from '../stratagemCards/feature';

const key = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const FEATURE_PROFILE_DATA_KEYS = ['governance-v1', 'heritage-v1', 'lineage-v1', 'logistics-v1'] as const;
export const featureProfileReferenceSchema = z.strictObject({
  key,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const legacyFeatureProfileSchema = z.strictObject({
  version: z.literal(1),
  key,
  scenarioKey: key,
  mapKey: key,

  featureData: z.strictObject({
    'city-upgrade-v1': cityUpgradeConfigSchema.optional(),
    'logistics-v1': logisticsConfigSchema,
    'governance-v1': governanceConfigSchema,
    'lineage-v1': lineageConfigSchema,
    'heritage-v1': heritageFeatureDataSchema,
  }),
});
const equipmentFeatureProfileSchema = legacyFeatureProfileSchema.extend({
  version: z.literal(2),
  featureData: legacyFeatureProfileSchema.shape.featureData.extend({ 'equipment-v1': equipmentConfigSchema }),
});
export const featureProfileSchema = z.discriminatedUnion('version', [
  legacyFeatureProfileSchema,
  equipmentFeatureProfileSchema,
  equipmentFeatureProfileSchema.extend({
    version: z.literal(3),
    scenarioKey: resourceKeySchema,
    mapKey: resourceKeySchema,
    unitSetKey: resourceKeySchema,
    statRulesKey: resourceKeySchema,
    portraitMapKey: resourceKeySchema,
    featureData: equipmentFeatureProfileSchema.shape.featureData.extend({
      'stratagem-cards-v1': stratagemCardsFeatureDataSchema,
    }),
  }),
]);
export type FeatureProfile = z.infer<typeof featureProfileSchema>;
