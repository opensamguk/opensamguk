import { describe, expect, it } from 'vitest';
import { validateScenario } from './scenario';
import { codes, mapFixture, scenarioFixture } from './testFixtures';

describe('T4-76 시나리오 검증', () => {
  it('맥락 실패를 통과로 세지 않고 정상 null 위치를 보존한다', () => {
    const scenario = scenarioFixture();
    expect(validateScenario(scenario).status).toBe('incomplete');
    expect(validateScenario(scenario, { map: null })).toMatchObject({
      status: 'incomplete',
      skipped: [{ group: 'map-refs', reason: 'context-invalid' }],
    });
    expect(validateScenario(scenario, { map: mapFixture() }).status).toBe('pass');
  });
  it('이름·소유·국가·생몰년·외교 오류를 튜플 행으로 낸다', () => {
    const scenario = scenarioFixture();
    scenario.nation.push(structuredClone(scenario.nation[0]!));
    scenario.general[0]![3] = 3;
    scenario.general[0]![9] = 201;
    scenario.general.push(structuredClone(scenario.general[0]!));
    scenario.diplomacy = [
      [1, 3, 0, 1],
      [3, 1, 7, 1],
    ];
    expect(codes(validateScenario(scenario, { map: mapFixture() }))).toEqual([
      'scenario-nation-name-duplicate',
      'scenario-city-owner-duplicate',
      'scenario-general-nation-missing',
      'scenario-general-years',
      'scenario-general-nation-missing',
      'scenario-general-years',
      'scenario-general-name-duplicate',
      'scenario-diplomacy-invalid',
      'scenario-diplomacy-invalid',
      'scenario-diplomacy-duplicate',
    ]);
    expect(validateScenario(scenario, { map: mapFixture() }).issues[0]).toMatchObject({
      code: 'scenario-nation-name-duplicate',
      severity: 'error',
      target: { kind: 'nation', index: 1 },
    });
  });
  it('장수 이름 중복은 같은 초상 이름을 쓰는 경고만 낸다', () => {
    const scenario = scenarioFixture();
    scenario.general.push(structuredClone(scenario.general[0]!));
    expect(validateScenario(scenario, { map: mapFixture() })).toMatchObject({
      status: 'pass',
      issues: [{ code: 'scenario-general-name-duplicate', severity: 'warning', target: { kind: 'general', index: 1 } }],
    });
  });
  it('외교 중복은 마지막 적용을 알리는 경고이며 참조 오류와 구분한다', () => {
    const scenario = scenarioFixture();
    scenario.nation.push(['다른국가', '#000000', 0, 0, '', 0, '', 0, ['도시2']]);
    scenario.diplomacy = [
      [1, 2, 0, 1],
      [2, 1, 7, 2],
    ];
    const report = validateScenario(scenario, { map: mapFixture() });
    expect(report.status).toBe('pass');
    expect(codes(report)).toEqual(['scenario-diplomacy-duplicate']);
    scenario.nation[0]![8] = ['없음'];
    scenario.general[0]![4] = '없음';
    expect(codes(validateScenario(scenario, { map: mapFixture() })).slice(-2)).toEqual([
      'scenario-nation-city-missing',
      'scenario-general-city-missing',
    ]);
  });
});
