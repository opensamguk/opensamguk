import { expect, it } from 'vitest';
import { requireRuleFeature } from './queries';
it('T2-26 서버는 꺼진 기능을 고정 오류로 거부한다', () => {
  expect(() => requireRuleFeature({ ruleFeatures: ['test-a'] }, 'test-a')).not.toThrow();
  expect(() => requireRuleFeature({ ruleFeatures: [] }, 'test-a')).toThrowError(
    expect.objectContaining({ code: 'PRECONDITION_FAILED', message: '이 월드에서 켜지 않은 기능입니다.' }),
  );
});
