import { z } from 'zod';
import { logisticsConfigSchema } from '../logistics/state';
import { governanceConfigSchema } from '../governance/config';
import { lineageConfigSchema } from '../lineage/config';
import { heritageFeatureDataSchema } from '../heritage/feature';
import { checkRuleFeatures } from '../ruleRegistry';

const key = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const FEATURE_PROFILE_DATA_KEYS = ['governance-v1', 'heritage-v1', 'lineage-v1', 'logistics-v1'] as const;
export const featureProfileReferenceSchema = z.strictObject({
  key,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const featureProfileSchema = z
  .strictObject({
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
  })
  .superRefine((profile, context) => {
    try {
      checkRuleFeatures(profile.ruleFeatures);
      if (FEATURE_PROFILE_DATA_KEYS.some((feature) => !profile.ruleFeatures.includes(feature))) throw new Error();
    } catch {
      context.addIssue({ code: 'custom', path: ['ruleFeatures'], message: '확장 설정의 규칙 기능을 확인하세요.' });
    }
  });
export type FeatureProfile = z.infer<typeof featureProfileSchema>;
