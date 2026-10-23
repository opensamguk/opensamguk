import { describe, expect, expectTypeOf, it } from 'vitest';
import { validateWorldResources } from './world';
import { freezeDeep, mapFixture, scenarioFixture, unitFixture } from './testFixtures';

describe('T4-76 자원 묶음 판정', () => {
  it('모든 자원이 통과해야 통과하며 초상 생략은 빈 표와 같다', () => {
    const input = freezeDeep({
      map: mapFixture(),
      scenario: scenarioFixture(),
      unitSet: unitFixture(),
      statRules: { stat: { total: 165, min: 15, max: 80 } },
    });
    const result = validateWorldResources(input);
    expectTypeOf(result.status).toEqualTypeOf<'pass' | 'fail' | 'incomplete'>();
    expect(result.status).toBe('pass');
    expect(validateWorldResources({ ...input, portraitMap: { portraits: {} } })).toEqual(result);
    expect(validateWorldResources({ ...input, map: null })).toMatchObject({
      status: 'fail',
      map: { status: 'fail' },
      scenario: { status: 'incomplete' },
    });
  });
});
