import { describe, expect, expectTypeOf, it } from 'vitest';
import { operationalInput } from '../../../test/operationalMapFixture';
import { buildInitialWorld } from '../bootstrap';
import { checkReplayOrigin } from '../../ruleRegistry';
import { checkOperationalProfile } from '../map/profile';
import { validateMap } from './map';
import { validateWorldResources } from './world';
import { codes, freezeDeep, mapFixture, scenarioFixture, unitFixture } from './testFixtures';

describe('T4-76 자원 묶음 판정', () => {
  it.each([
    ['2090', 103],
    ['2121', 108],
    ['2140', 102],
    ['2150', 105],
    ['2210', 140],
    ['2200', 115],
    ['2300', 120],
    ['2702', 156],
  ] as const)('T4-46 AC-P2-24 %s 시작 NPC 능력치 원본의 상한 %s를 적용한다', (id, limit) => {
    const scenario = { ...scenarioFixture(), id };
    for (const stat of [5, 6, 7]) scenario.general[0]![stat] = limit;
    const input = {
      map: mapFixture(),
      scenario,
      unitSet: unitFixture(),
      statRules: { stat: { total: 165, min: 15, max: 80 } },
      seed: 't4-46-original-npc-stats',
    };
    expect(validateWorldResources(input).status).toBe('pass');
    const initial = buildInitialWorld(input);
    expect(initial.generals[0]).toMatchObject({ userId: null, leadership: limit, strength: limit, intel: limit });
    const current = { version: 3, initial, initialStateHash: '', resourceHash: '' };
    expect(() => checkReplayOrigin(current)).not.toThrow();
    const legacy = () => checkReplayOrigin({ version: 1, initial });
    if (['2121', '2200', '2210', '2300'].includes(id)) expect(legacy).not.toThrow();
    else expect(legacy).toThrow('시작 장수의 기본 능력치');

    const human = structuredClone(initial);
    human.generals[0]!.userId = 'account';
    expect(() => checkReplayOrigin({ ...current, initial: human })).toThrow('시작 장수의 기본 능력치');
    expect(validateWorldResources({ ...input, scenario: { ...scenario, id: 'other' } }).scenario.status).toBe('fail');
    scenario.general[0]![7] = limit + 1;
    expect(validateWorldResources(input).scenario.status).toBe('fail');
  });

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

  it('T4-46 AC-P2-24 병종판과 지도의 지역 기준을 생성과 같은 방식으로 검증한다', () => {
    const input = operationalInput();
    const regionScheme = 'province-191';
    const unitSet = { ...input.unitSet, regionScheme };
    const incompatible = { ...input, unitSet };

    expect(validateWorldResources(incompatible)).toMatchObject({
      status: 'fail',
      unitSet: {
        status: 'fail',
        issues: [{ code: 'shape-invalid', target: { kind: 'path', path: ['regionScheme'] } }],
      },
    });
    expect(() => buildInitialWorld(incompatible)).toThrow('지도와 병종 판의 지역 기준이 다릅니다.');

    const compatible = { ...incompatible, map: { ...input.map, regionScheme } };
    expect(validateWorldResources(compatible).status).toBe('pass');
    expect(buildInitialWorld(compatible).operationalMap?.regionScheme).toBe(regionScheme);
  });

  it('T4-46 AC-P2-24 시나리오가 지정한 장수 생성 능력치 판만 받는다', () => {
    const requiredStatRules = { total: 220, min: 40, max: 95 };
    const input = freezeDeep({
      map: mapFixture(),
      scenario: { ...scenarioFixture(), requiredStatRules },
      unitSet: unitFixture(),
      seed: 't4-46-stat-rules',
    });
    const correct = { ...input, statRules: { stat: requiredStatRules } };
    expect(validateWorldResources(correct).status).toBe('pass');
    expect(buildInitialWorld(correct).statRules).toEqual(requiredStatRules);

    for (const stat of [
      { total: 165, min: 15, max: 80 },
      { ...requiredStatRules, count: 5 },
    ]) {
      const wrong = { ...input, statRules: { stat } };
      expect(validateWorldResources(wrong)).toMatchObject({
        status: 'fail',
        statRules: {
          status: 'fail',
          issues: [{ code: 'scenario-stat-rules-mismatch', target: { kind: 'path', path: ['stat'] } }],
        },
      });
      expect(() => buildInitialWorld(wrong)).toThrow('시나리오와 장수 생성 능력치 판이 맞지 않습니다.');
    }
  });

  it('T4-46 AC-P2-24 원작 초기 도시 보정은 공백지와 점령지의 최대치를 기준으로 적용한다', () => {
    const map = mapFixture();
    for (const city of map.cities) {
      city.max = { population: 105, agriculture: 109, commerce: 101, security: 125, defence: 111, wall: 115 };
      city.initial = { population: 11, agriculture: 12, commerce: 13, security: 14, defence: 15, wall: 16 };
    }
    const scenario = scenarioFixture();
    const input = freezeDeep({
      map,
      unitSet: unitFixture(),
      statRules: { stat: { total: 165, min: 15, max: 80 } },
      seed: 't4-46-opening-city',
    });
    const legacy = buildInitialWorld({ ...input, scenario });
    const withOpening = { ...scenario, openingCityProfile: 'legacy-research-70' };
    expect(validateWorldResources({ ...input, scenario: withOpening }).status).toBe('pass');
    const ready = buildInitialWorld({ ...input, scenario: withOpening });
    const common = { population: 74, agriculture: 76, commerce: 71, security: 88, trust: 80 };
    expect(ready.cities[0]).toMatchObject({ ...common, nationId: 1, defence: 78, wall: 81 });
    expect(ready.cities[1]).toMatchObject({ ...common, nationId: null, defence: 15, wall: 16 });
    expect(legacy.cities[0]).toMatchObject({ ...map.cities[0]!.initial, trust: 50 });
    expect(ready).toEqual(buildInitialWorld({ ...input, scenario: withOpening }));
    expect(ready.generals).toEqual(legacy.generals);
  });

  it('T4-46 AC-P2-24 운영 지도는 개막 도시 보정과 기존 관문 방어를 재생 원장에 고정한다', () => {
    const input = operationalInput();
    input.map.defaults.trust = 60;
    const source = input.map.sites.find((site) => site.kind === 'CITY')!;
    input.map.sites.push({
      ...source,
      id: 'city:3',
      name: '도시3',
      anchorKey: 3,
      legacyCityId: 3,
      position: { x: 400, y: 400 },
    });
    input.map.routes.push({
      id: 'route:3',
      from: 'pass:99',
      to: 'city:3',
      mode: 'LAND',
      direction: 'BOTH',
      enabled: true,
    });
    const scenario = { ...input.scenario, openingCityProfile: 'legacy-research-70' };
    expect(validateWorldResources({ ...input, scenario }).status).toBe('pass');
    const base = buildInitialWorld(input);
    const initial = buildInitialWorld({ ...input, scenario });
    expect(initial.openingCityProfile).toBe('legacy-research-70');
    expect(initial.operationalMap).toEqual(base.operationalMap);
    expect(initial.cities[0]).toMatchObject({ nationId: 1, population: 1400, defence: 70, wall: 70, trust: 80 });
    expect(initial.cities[2]).toMatchObject({ nationId: null, population: 1400, defence: 100, wall: 100, trust: 80 });
    expect(initial.cities[3]).toEqual(base.cities[3]);
    expect(() =>
      checkReplayOrigin({
        version: 3,
        initial,
        initialStateHash: 'b'.repeat(64),
        resourceHash: 'a'.repeat(64),
      }),
    ).not.toThrow();
    const { openingCityProfile, ...withoutProfile } = initial;
    expect(openingCityProfile).toBe(scenario.openingCityProfile);
    expect(() => checkOperationalProfile(withoutProfile)).toThrow();
    initial.cities[0]!.trust = 60;
    expect(() => checkOperationalProfile(initial)).toThrow('개막 민심');
  });

  it('T4-46 AC-P2-24 운영 지도의 개막 보정은 무 규모와 폐허의 초기값을 보존한다', () => {
    const input = operationalInput();
    const scenario = {
      ...input.scenario,
      cityScale: {
        cities: [
          { city: '도시1', level: 0 },
          { city: '도시2', ruin: true },
        ],
      },
    };
    const base = buildInitialWorld({ ...input, scenario });
    const opened = buildInitialWorld({ ...input, scenario: { ...scenario, openingCityProfile: 'legacy-research-70' } });
    expect(opened.cities).toEqual(base.cities);
    expect(() => checkOperationalProfile(opened)).not.toThrow();
  });

  it('T4-46 AC-P2-24 도시가 같아도 시나리오가 지정한 지도 ID를 대조한다', () => {
    const map = mapFixture();
    const otherMap = { ...map, id: 'other' };
    const scenario = { ...scenarioFixture(), requiredMap: map.id };
    const input = {
      map,
      scenario,
      unitSet: unitFixture(),
      statRules: { stat: { total: 165, min: 15, max: 80 } },
      seed: 't4-46-required-map',
    };
    expect(validateWorldResources(input).status).toBe('pass');
    expect(buildInitialWorld(input)).toEqual(buildInitialWorld({ ...input, scenario: scenarioFixture() }));
    expect(validateWorldResources({ ...input, map: otherMap }).scenario.issues).toMatchObject([
      { code: 'scenario-map-mismatch', target: { kind: 'path', path: ['requiredMap'] }, params: { expected: map.id } },
    ]);
    expect(validateMap(otherMap, { scenarios: [scenario] }).issues).toMatchObject([
      { code: 'scenario-map-mismatch', target: { kind: 'path', path: ['id'] }, source: { kind: 'SCENARIO', index: 0 } },
    ]);
    expect(() => buildInitialWorld({ ...input, map: otherMap })).toThrow('test 지도가 필요합니다.');
    expect(validateWorldResources({ ...input, map: otherMap, scenario: scenarioFixture() }).status).toBe('pass');
  });

  it('T4-46 AC-P2-24 선택한 시나리오의 상성 0만 시드로 정한다', () => {
    const scenario = scenarioFixture();
    scenario.general[0]![3] = 0;
    scenario.general.push([123, '다른장수', '', 0, null, 50, 50, 50, 0, 100, 200, null, null]);
    const affinities = new Set<number>();
    for (let index = 0; index < 12; index++) {
      const input = {
        map: mapFixture(),
        scenario,
        unitSet: unitFixture(),
        statRules: { stat: { total: 165, min: 15, max: 80 } },
        seed: `t4-46-random-affinity:${index}`,
      };
      const before = buildInitialWorld(input);
      const selected = { ...input, scenario: { ...scenario, randomizeZeroAffinity: true } };
      const after = buildInitialWorld(selected);
      const { affinity } = after.generals[0]!;
      expect(affinity).toBeGreaterThanOrEqual(1);
      expect(affinity).toBeLessThanOrEqual(150);
      affinities.add(affinity);
      expect(after).toEqual(buildInitialWorld(selected));
      expect(before.generals[0]!.affinity).toBe(0);
      expect(after.generals).toEqual([{ ...before.generals[0]!, affinity }, before.generals[1]]);
    }
    expect(affinities.size).toBeGreaterThan(1);
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
