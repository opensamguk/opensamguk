import { describe, expect, it } from 'vitest';
import type { ScenarioResource } from '../resources';
import { mapFixture, scenarioFixture } from './fixtures';
import { validateScenario } from './scenario';
import type { IssueTarget, ResourceIssueCode } from './issues';

const cases: Array<[ResourceIssueCode, (s: ScenarioResource) => void, IssueTarget]> = [
  [
    'resource-id-mismatch',
    (s) => {
      s.id = 'other';
    },
    { kind: 'root' },
  ],
  [
    'scenario-nation-name-duplicate',
    (s) => {
      s.nation[1]![0] = ' 국가1 ';
    },
    { kind: 'nation', index: 1 },
  ],
  [
    'scenario-nation-city-missing',
    (s) => {
      s.nation[0]![8] = ['없음'];
    },
    { kind: 'nation', index: 0 },
  ],
  [
    'scenario-city-owner-duplicate',
    (s) => {
      s.nation[1]![8] = ['도시1'];
    },
    { kind: 'nation', index: 1 },
  ],
  [
    'scenario-general-name-duplicate',
    (s) => {
      s.general[1]![1] = '장수1';
    },
    { kind: 'general', index: 1 },
  ],
  [
    'scenario-general-nation-missing',
    (s) => {
      s.general[0]![3] = 3;
    },
    { kind: 'general', index: 0 },
  ],
  [
    'scenario-general-city-missing',
    (s) => {
      s.general[0]![4] = '없음';
    },
    { kind: 'general', index: 0 },
  ],
  [
    'scenario-general-years',
    (s) => {
      s.general[0]![9] = 221;
    },
    { kind: 'general', index: 0 },
  ],
  [
    'scenario-diplomacy-invalid',
    (s) => {
      s.diplomacy = [[1, 1, 0, 0]];
    },
    { kind: 'diplomacy', index: 0 },
  ],
  [
    'scenario-diplomacy-duplicate',
    (s) => {
      s.diplomacy.push([2, 1, 7, 1]);
    },
    { kind: 'diplomacy', index: 1 },
  ],
];
describe('시나리오 검증', () => {
  it.each(cases)('%s 실패와 고친 통과', (code, change, target) => {
    const ctx = { map: mapFixture(), expectedId: 'scenario' };
    const value = scenarioFixture();
    expect(validateScenario(value, ctx).issues).toEqual([]);
    change(value);
    const result = validateScenario(value, ctx);
    expect(result.issues.map((i) => i.code)).toEqual([code]);
    expect(result.issues[0]).toMatchObject({
      target,
      severity: code === 'scenario-diplomacy-duplicate' ? 'warning' : 'error',
    });
    expect(result.ok).toBe(code === 'scenario-diplomacy-duplicate');
  });
  it('짝 지도 형식 실패와 지도 없이 판정할 오류를 함께 냅니다.', () => {
    const scenario = scenarioFixture();
    scenario.general[0]![3] = 999;
    expect(validateScenario(scenario, { map: {} }).issues.map((i) => i.code)).toEqual([
      'scenario-map-invalid',
      'scenario-general-nation-missing',
    ]);
    const invalid = validateScenario({ ...scenario, startYear: -1 }, { map: {} });
    expect(invalid.value).toBeNull();
    expect(invalid.issues).toEqual([
      expect.objectContaining({ code: 'shape-invalid', target: { kind: 'path', path: ['startYear'] } }),
    ]);
    expect(validateScenario(scenarioFixture(), { map: mapFixture() }).ok).toBe(true);
  });
  it('짝 지도 형식 오류여도 ID·이름·소유·생몰년·외교 검사를 계속합니다.', () => {
    const scenario = scenarioFixture();
    scenario.nation[1]![0] = scenario.nation[0]![0];
    scenario.nation[1]![8] = ['도시1', '없는도시'];
    scenario.general[1]![1] = scenario.general[0]![1];
    scenario.general[1]![3] = 999;
    scenario.general[1]![4] = '없는도시';
    scenario.general[1]![9] = 221;
    scenario.diplomacy.push([2, 1, 0, 0], [1, 3, 0, 0]);
    const ctx = { map: {}, expectedId: 'other' };
    const result = validateScenario(scenario, ctx);
    expect(result).toEqual(validateScenario(scenario, ctx));
    expect(result.issues.map((i) => i.code)).toEqual([
      'resource-id-mismatch',
      'scenario-map-invalid',
      'scenario-nation-name-duplicate',
      'scenario-city-owner-duplicate',
      'scenario-general-name-duplicate',
      'scenario-general-nation-missing',
      'scenario-general-years',
      'scenario-diplomacy-invalid',
      'scenario-diplomacy-duplicate',
    ]);
    expect(result.value).toEqual(scenario);
    const withMap = validateScenario(scenario, { ...ctx, map: mapFixture() });
    expect(withMap.issues.map((i) => i.code)).toContain('scenario-nation-city-missing');
    expect(withMap.issues.map((i) => i.code)).toContain('scenario-general-city-missing');
  });
  it('없는 외교 국가·같은 국가·도시 목록 안의 중복 소유를 거부한다', () => {
    for (const pair of [
      [1, 3],
      [3, 1],
      [2, 2],
    ]) {
      const scenario = scenarioFixture();
      scenario.diplomacy = [[pair[0]!, pair[1]!, 0, 0]];
      expect(validateScenario(scenario, { map: mapFixture() }).issues.map((i) => i.code)).toEqual([
        'scenario-diplomacy-invalid',
      ]);
    }
    const scenario = scenarioFixture();
    scenario.nation[0]![8].push('도시1');
    expect(validateScenario(scenario, { map: mapFixture() }).issues.map((i) => i.code)).toEqual([
      'scenario-city-owner-duplicate',
    ]);
  });
});
