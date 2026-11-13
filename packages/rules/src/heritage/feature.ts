import { z } from 'zod';
import type { RuleFeatureDefinition } from '../ruleRegistry';
import { validateGeneralCreation } from '../general/create';
import { assertHeritageCreationResult } from './creation';
import { GENERAL_PERSONALITY_FEATURE } from '../general/personality';

export const heritageFeatureDataSchema = z.strictObject({ version: z.literal(1) });
export const heritageFeature: RuleFeatureDefinition = {
  key: 'heritage-v1',
  requires: ['policy'],
  conflicts: [],
  checkOrigin({ data }) {
    heritageFeatureDataSchema.parse(data);
  },
  checkArchive({ origin, inputs }) {
    const five = origin.initial.ruleFeatures?.includes('five-stats') ?? false;
    for (const input of inputs) {
      if (input.kind !== 'general.create' || input.status !== 'APPLIED') continue;
      const checked = validateGeneralCreation(
        input.payload,
        origin.initial.statRules,
        origin.initial.ruleFeatures?.includes('lineage-v1'),
        true,
        origin.initial.ruleFeatures?.includes(GENERAL_PERSONALITY_FEATURE),
      );
      if (!checked.ok) throw new Error('유산 생성 입력의 능력치·배분을 확인하세요.');
      assertHeritageCreationResult(checked.value, input.result, true, five);
    }
  },
};
