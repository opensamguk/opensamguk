import { describe, expect, it } from 'vitest';
import { featureProfileSchema } from '@opensamguk/rules';
import { loadFeatureProfile } from './resources';

describe('AC-P2-30·31·32·33 확장 생성 설정', () => {
  it('AC-INT-28 기능 선택 없이 설정을 읽고 잘못된 설정과 추가 속성을 거부한다', async () => {
    const { value } = await loadFeatureProfile('expanded-191-v1');
    expect(featureProfileSchema.safeParse(value).success).toBe(true);
    expect(featureProfileSchema.safeParse({ ...value, featureData: null }).success).toBe(false);
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
