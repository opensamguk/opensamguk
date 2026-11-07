import { describe, expect, it } from 'vitest';
import { featureProfileSchema } from '@opensamguk/rules';
import { loadFeatureProfile } from './resources';

describe('AC-P2-30·31·32·33 확장 생성 설정', () => {
  it('빠진 기능·의존성·설정과 추가 속성을 거부한다', async () => {
    const { value } = await loadFeatureProfile('expanded-191-v1');
    expect(
      featureProfileSchema.safeParse({ ...value, ruleFeatures: value.ruleFeatures.filter((v) => v !== 'lineage-v1') })
        .success,
    ).toBe(false);
    expect(
      featureProfileSchema.safeParse({ ...value, ruleFeatures: [...value.ruleFeatures, 'lineage-v1'] }).success,
    ).toBe(false);
    expect(
      featureProfileSchema.safeParse({ ...value, featureData: { ...value.featureData, 'heritage-v1': null } }).success,
    ).toBe(false);
    expect(featureProfileSchema.safeParse({ ...value, actor: 'ADMIN' }).success).toBe(false);
  });
  it('미지 파일과 경로 입력을 거부한다', async () => {
    await expect(loadFeatureProfile('missing-expanded-profile')).rejects.toThrow();
    await expect(loadFeatureProfile('../expanded-191-v1')).rejects.toThrow();
  });
});
