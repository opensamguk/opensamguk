import { z } from 'zod';
import { logisticsConfigSchema } from '../logistics/state';
import { governanceConfigSchema } from '../governance/config';
import { lineageConfigSchema } from '../lineage/config';
import { heritageFeatureDataSchema } from '../heritage/feature';
import { checkRuleFeatures } from '../ruleRegistry';
import { equipmentConfigSchema } from '../equipment/config';
import { resourceKeySchema } from '../world/resourceKey';
import { readStratagemCardsConfig, stratagemCardsFeatureDataSchema } from '../stratagemCards/feature';

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
  ruleFeatures: z.array(z.string()),
  featureData: z.strictObject({
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
export const featureProfileSchema = z
  .discriminatedUnion('version', [
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
  ])
  .superRefine((profile, context) => {
    if (profile.key === 'expanded-191-v8' && profile.featureData['logistics-v1'].npc?.treasuryBudgetBp !== 1000)
      context.addIssue({
        code: 'custom',
        path: ['featureData', 'logistics-v1', 'npc', 'treasuryBudgetBp'],
        message: '첩보 확장판의 NPC 국고 예산 상한은 10%입니다.',
      });
    try {
      checkRuleFeatures(profile.ruleFeatures);
      if (FEATURE_PROFILE_DATA_KEYS.some((feature) => !profile.ruleFeatures.includes(feature))) throw new Error();
      if (profile.ruleFeatures.includes('equipment-v1') !== profile.version >= 2) throw new Error();
      if (profile.version === 3) {
        if (!profile.ruleFeatures.includes('stratagem-cards-v1')) throw new Error();
        readStratagemCardsConfig(profile.featureData['stratagem-cards-v1'], profile.ruleFeatures);
      }
    } catch {
      context.addIssue({ code: 'custom', path: ['ruleFeatures'], message: '확장 설정의 규칙 기능을 확인하세요.' });
    }
  });
export type FeatureProfile = z.infer<typeof featureProfileSchema>;
