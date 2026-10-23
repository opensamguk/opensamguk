import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import map from '../resources/map/che.json';
import scenario from '../resources/scenario/1030.json';
import unitSet from '../resources/unitset/basic.json';
import statRules from '../resources/scenario/default.json';
import portraitMap from '../resources/portraits/rtk14-map.json';
import { buildInitialWorld, type WorldInit } from '../packages/rules/src/world/bootstrap';
import { hashState } from '../packages/shared/src/node/hashState';
import {
  normalizeMapToV2,
  validateMap,
  validateScenario,
  validateWorldResources,
} from '../packages/rules/src/world/validate/index';
import { mapFixture, scenarioFixture, unitFixture } from '../packages/rules/src/world/validate/testFixtures';

// 바꾸지 않는 engine 모듈을 실제로 호출한다. 도구 타입 검사의 범위는 새 파일과 rules다.
const replayModule = '../apps/engine/src/replay';
const { resourceHash } = (await import(replayModule)) as { resourceHash: (initial: WorldInit) => string };

const input = { map, scenario, unitSet, statRules, portraitMap, seed: 't4-76-che' };
describe('T4-76 실제 내장 자원과 기존 생성 함수', () => {
  it('다섯 내장 파일과 기존 외교 중복을 실제로 검사한다', () => {
    const result = validateWorldResources(input);
    expect(result.status).toBe('pass');
    expect(result.map.issues).toEqual([]);
    expect(result.scenario.issues.map((item) => [item.code, item.target])).toEqual([
      ['scenario-diplomacy-duplicate', { kind: 'diplomacy', index: 3 }],
    ]);
    expect(result.unitSet.issues).toEqual([]);
    expect(result.statRules.issues).toEqual([]);
    expect(result.portraitMap.issues).toEqual([]);
    expect(validateMap(map).status).toBe('incomplete');
    expect(validateMap(map, { scenarios: [scenario] }).status).toBe('pass');
    expect(validateScenario(scenario, { map }).status).toBe('pass');
  });
  it('v1·빈 지형 v2·지형 있는 v2의 초기 상태와 실제 5키 resourceHash가 같다', () => {
    const normalized = normalizeMapToV2(map);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.map.cities).toHaveLength(94);
    expect(normalized.map.defaults).toMatchObject({ trade: 100, frontState: 0 });
    expect(normalized.map.$comment).toBe(map.$comment);
    expect(normalized.dropped).toContain('meta');
    const v1 = buildInitialWorld(input);
    const v2 = buildInitialWorld({ ...input, map: normalized.map });
    const terrain = structuredClone(normalized.map);
    terrain.terrain.coast.push([
      [0, 0],
      [700, 0],
      [700, 500],
      [0, 0],
    ]);
    const displayed = buildInitialWorld({ ...input, map: terrain });
    expect(v2).toEqual(v1);
    expect(displayed).toEqual(v1);
    expect(hashState(v2)).toBe(hashState(v1));
    expect(hashState(displayed)).toBe(hashState(v1));
    expect(resourceHash(v2)).toBe(resourceHash(v1));
    expect(resourceHash(displayed)).toBe(resourceHash(v1));
    expect(resourceHash(v1)).toBe(
      hashState({
        scenarioKey: v1.scenarioKey,
        mapKey: v1.mapKey,
        unitSetKey: v1.unitSetKey,
        statRules: v1.statRules,
        unitSet: v1.unitSet,
      }),
    );
  });
  it('Node가 공개 subpath를 이 feature의 파일로 해석한다', () => {
    const require = createRequire(new URL('../packages/rules/package.json', import.meta.url));
    const resolved = require.resolve('@opensamguk/rules/resource-validation');
    expect(resolved.replaceAll('\\', '/')).toBe(
      new URL('../packages/rules/src/world/validate/index.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    );
    expect(() => require.resolve('@opensamguk/rules/resource-validation/limits')).toThrow();
  });
});

const fixture = () => ({
  map: mapFixture(),
  scenario: scenarioFixture(),
  unitSet: unitFixture(),
  statRules: { stat: { total: 165, min: 15, max: 80 } },
  seed: 'refusal',
});
type Bundle = ReturnType<typeof fixture>;
const refusals: { label: string; code: string; mutate: (bundle: Bundle) => void }[] = [
  {
    label: '도시 ID',
    code: 'city-id-duplicate',
    mutate: (b) => {
      b.map.cities[1]!.id = 1;
    },
  },
  {
    label: '도시 이름',
    code: 'city-name-duplicate',
    mutate: (b) => {
      b.map.cities[1]!.name = '도시1';
    },
  },
  {
    label: '중복 연결',
    code: 'link-duplicate',
    mutate: (b) => {
      b.map.cities[0]!.connections.push(2);
    },
  },
  {
    label: '자기 연결',
    code: 'link-self',
    mutate: (b) => {
      b.map.cities[0]!.connections.push(1);
    },
  },
  {
    label: '없는 연결',
    code: 'link-missing-city',
    mutate: (b) => {
      b.map.cities[0]!.connections.push(99);
    },
  },
  {
    label: '한쪽 연결',
    code: 'link-one-way',
    mutate: (b) => {
      b.map.cities[1]!.connections = [];
    },
  },
  {
    label: '초기 최대치',
    code: 'city-initial-over-max',
    mutate: (b) => {
      b.map.cities[0]!.initial.wall = 101;
    },
  },
  {
    label: '병종 ID',
    code: 'unitset-crew-id-duplicate',
    mutate: (b) => {
      b.unitSet.crewTypes.push(structuredClone(b.unitSet.crewTypes[1]!));
    },
  },
  {
    label: '기본 병종',
    code: 'unitset-default-missing',
    mutate: (b) => {
      b.unitSet.defaultCrewTypeId = 999;
    },
  },
  {
    label: '국가 도시',
    code: 'scenario-nation-city-missing',
    mutate: (b) => {
      b.scenario.nation[0]![8] = ['없음'];
    },
  },
  {
    label: '도시 소유',
    code: 'scenario-city-owner-duplicate',
    mutate: (b) => {
      b.scenario.nation[0]![8].push('도시1');
    },
  },
  {
    label: '장수 국가',
    code: 'scenario-general-nation-missing',
    mutate: (b) => {
      b.scenario.general[0]![3] = 99;
    },
  },
  {
    label: '생몰년',
    code: 'scenario-general-years',
    mutate: (b) => {
      b.scenario.general[0]![9] = 201;
    },
  },
  {
    label: '장수 도시',
    code: 'scenario-general-city-missing',
    mutate: (b) => {
      b.scenario.general[0]![4] = '없음';
    },
  },
  {
    label: '외교 같은 국가',
    code: 'scenario-diplomacy-invalid',
    mutate: (b) => {
      b.scenario.diplomacy.push([1, 1, 0, 1]);
    },
  },
  {
    label: '외교 없는 국가',
    code: 'scenario-diplomacy-invalid',
    mutate: (b) => {
      b.scenario.diplomacy.push([1, 99, 0, 1]);
    },
  },
];
describe('T4-76 기존 생성 거부 대조', () => {
  it.each(refusals)('$label 거부를 같은 검사 코드로 설명한다', ({ mutate, code }) => {
    const bundle = fixture();
    mutate(bundle);
    expect(() => buildInitialWorld(bundle)).toThrow();
    const report = validateWorldResources(bundle);
    expect(report.status).toBe('fail');
    expect(
      Object.values(report)
        .filter((item) => typeof item === 'object')
        .flatMap((item) => item.issues.map((entry) => entry.code)),
    ).toContain(code);
  });
});
