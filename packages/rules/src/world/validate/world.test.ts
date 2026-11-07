import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildInitialWorld } from '../bootstrap';
import { validateWorldResources } from './world';
import { codes, freezeDeep, mapFixture, scenarioFixture, unitFixture } from './testFixtures';

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

  it('T4-46 AC-P2-24 원작 그림 경로의 null은 생성 초상과 상태를 바꾸지 않는다', () => {
    const scenario = scenarioFixture();
    scenario.general[0]![2] = '장수/장수.jpg';
    const input = {
      map: mapFixture(),
      unitSet: unitFixture(),
      statRules: { stat: { total: 165, min: 15, max: 80 } },
      portraitMap: { portraits: { 장수: 10001 } },
      seed: 't4-46-null-portrait',
    };
    const original = buildInitialWorld({ ...input, scenario });
    const missing = structuredClone(scenario);
    missing.general[0]![2] = null;
    expect(validateWorldResources({ ...input, scenario: missing }).status).toBe('pass');
    expect(original.generals[0]!.portraitId).toBe(10001);
    expect(buildInitialWorld({ ...input, scenario: missing })).toEqual(original);

    const invalid = {
      ...scenario,
      general: scenario.general.map(([affinity, name, , ...fields]) => [affinity, name, 42, ...fields]),
    };
    expect(codes(validateWorldResources({ ...input, scenario: invalid }).scenario)).toContain('shape-invalid');
  });
});
