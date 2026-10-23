import { describe, expect, it } from 'vitest';
import { RESOURCE_LIMITS as L, scanLimits } from './limits';
import { validateMap } from './map';
import { validateScenario } from './scenario';
import { validateUnitSet } from './unitSet';
import { validatePortraitMap } from './portraitMap';
import { codes, mapFixture, scenarioFixture, v2Fixture } from './testFixtures';
import type { ResourceKind } from './issues';
import type { ScenarioResource } from '../resources';

type LimitCase = {
  label: string;
  kind: ResourceKind;
  max: number;
  make: (count: number) => unknown;
  path: (string | number)[];
};
const cases: LimitCase[] = [
  { label: '도시', kind: 'MAP', max: L.cities, make: (n) => ({ cities: Array(n).fill(null) }), path: ['cities'] },
  {
    label: '연결',
    kind: 'MAP',
    max: L.connections,
    make: (n) => ({ cities: [{ connections: Array(n).fill(1) }] }),
    path: ['cities', 0, 'connections'],
  },
  ...(['coast', 'lakes', 'mountains', 'rivers'] as const).map((layer): LimitCase => ({
    label: `지형 ${layer}`,
    kind: 'MAP',
    max: L.linesPerLayer,
    make: (n) => ({ terrain: { [layer]: Array(n).fill(null) } }),
    path: ['terrain', layer],
  })),
  {
    label: '선의 점',
    kind: 'MAP',
    max: L.pointsPerLine,
    make: (n) => ({ terrain: { rivers: [{ points: Array(n).fill([0, 0]) }] } }),
    path: ['terrain', 'rivers', 0, 'points'],
  },
  { label: '국가', kind: 'SCENARIO', max: L.nations, make: (n) => ({ nation: Array(n).fill(null) }), path: ['nation'] },
  {
    label: '국가 도시',
    kind: 'SCENARIO',
    max: L.citiesPerNation,
    make: (n) => ({ nation: [[null, null, null, null, null, null, null, null, Array(n).fill('도시')]] }),
    path: ['nation', 0, 8],
  },
  {
    label: '장수',
    kind: 'SCENARIO',
    max: L.generals,
    make: (n) => ({ general: Array(n).fill(null) }),
    path: ['general'],
  },
  {
    label: '외교',
    kind: 'SCENARIO',
    max: L.diplomacies,
    make: (n) => ({ diplomacy: Array(n).fill(null) }),
    path: ['diplomacy'],
  },
  {
    label: '병종',
    kind: 'UNIT_SET',
    max: L.crewTypes,
    make: (n) => ({ crewTypes: Array(n).fill(null) }),
    path: ['crewTypes'],
  },
  {
    label: '계통',
    kind: 'UNIT_SET',
    max: L.armTypes,
    make: (n) => ({ armTypes: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, '계통'])) }),
    path: ['armTypes'],
  },
  ...(['attackCoef', 'defenceCoef'] as const).map((field): LimitCase => ({
    label: field,
    kind: 'UNIT_SET',
    max: L.coefficientKeys,
    make: (n) => ({ crewTypes: [{ [field]: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, 1])) }] }),
    path: ['crewTypes', 0, field],
  })),
  {
    label: '초상',
    kind: 'PORTRAIT_MAP',
    max: L.portraits,
    make: (n) => ({ portraits: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, 10001])) }),
    path: ['portraits'],
  },
];
describe('T4-76 한도 선행 검사', () => {
  it.each(cases)('$label 경계를 받고 초과 경로를 형식 검사 전에 찾는다', ({ kind, max, make, path }) => {
    expect(scanLimits(kind, make(max)).issues).toEqual([]);
    expect(scanLimits(kind, make(max + 1)).issues).toMatchObject([
      { code: 'resource-too-large', target: { kind: 'path', path }, params: { max } },
    ]);
  });
  it('지형 점 합계를 층과 선 순서로 세며 초과한 선을 가리킨다', () => {
    const points = Array(L.pointsPerLine).fill([0, 0]);
    const raw = { terrain: { coast: Array(20).fill(points), rivers: [] as { points: unknown[] }[] } };
    expect(scanLimits('MAP', raw).issues).toEqual([]);
    raw.terrain.rivers.push({ points: [[0, 0]] });
    expect(scanLimits('MAP', raw).issues).toMatchObject([
      { target: { path: ['terrain', 'rivers', 0] }, params: { max: L.terrainPoints } },
    ]);
  });
  it('개별 한도 곱인 소유 참조·계수 합계의 경계를 세되 관계 통과로 오인하지 않는다', () => {
    const row = scenarioFixture().nation[0]!;
    const nation = Array.from({ length: 500 }, () => [...row.slice(0, 8), Array(1000).fill('도시1')]);
    expect(scanLimits('SCENARIO', { nation }).counts.ownedCities).toBe(500000);
    expect(scanLimits('SCENARIO', { nation }).issues).toEqual([]);
    const coefficients = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [i, 1]));
    const crewTypes = Array(500).fill({ attackCoef: coefficients, defenceCoef: coefficients });
    expect(scanLimits('UNIT_SET', { crewTypes }).issues).toEqual([]);
    expect(scanLimits('UNIT_SET', { crewTypes: [{ attackCoef: [], defenceCoef: [] }] }).issues).toEqual([]);
  });
  it('큰 입력의 구조 오류와 관계 검사를 실제로 건너뛴다', () => {
    const map = validateMap({ cities: Array(1001).fill(null) });
    expect(codes(map)).toEqual(['resource-too-large']);
    expect(map.ran).toEqual(['limits']);
    const scenario = validateScenario({
      nation: [
        Array(8)
          .fill(null)
          .concat([Array(1001).fill(null)]),
      ],
    });
    expect(codes(scenario)).toEqual(['resource-too-large']);
    expect(scenario.ran).toEqual(['limits']);
    expect(
      validateUnitSet({ armTypes: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [i, null])) }).ran,
    ).toEqual(['limits']);
    expect(
      validatePortraitMap({ portraits: Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [i, null])) }).ran,
    ).toEqual(['limits']);
  });
});

const emptyScenario = (): ScenarioResource => ({ ...scenarioFixture(), nation: [], general: [], diplomacy: [] });
describe('T4-76 맥락 한도와 미완 판정', () => {
  it('맥락 32개와 33개를 구분하고 33개는 원소를 읽지 않는다', () => {
    expect(validateMap(mapFixture(), { scenarios: Array.from({ length: 32 }, emptyScenario) }).status).toBe('pass');
    const report = validateMap(mapFixture(), { scenarios: Array(33).fill(null) });
    expect(report.status).toBe('fail');
    expect(codes(report)).toEqual(['resource-too-large']);
    expect(report.skipped).toContainEqual({ group: 'scenario-refs', reason: 'context-invalid' });
  });
  it.each(['nations', 'generals', 'diplomacies'] as const)('맥락 %s 누적 한도를 호출 전체에 공유한다', (field) => {
    const make = (n: number) => {
      const source = scenarioFixture();
      if (field === 'nations') {
        source.nation = Array.from({ length: n }, (_, i) => [`국가${i}`, '#000000', 0, 0, '', 0, '', 0, ['도시1']]);
        source.general = [];
      } else if (field === 'generals') source.general = Array(n).fill(source.general[0]!);
      else source.diplomacy = Array(n).fill([1, 1, 0, 1]);
      return source;
    };
    const max = L[field];
    const boundary = validateMap(mapFixture(), { scenarios: [make(max), make(0)] });
    expect(boundary.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'resource-too-large' })]),
    );
    const report = validateMap(mapFixture(), { scenarios: [make(max), make(1)] });
    expect(report.status).toBe('fail');
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'resource-too-large',
          params: { limit: field, max },
          source: { kind: 'SCENARIO', index: 1 },
        }),
      ]),
    );
  });
  it('누적 소유 참조도 국가 수와 함께 초과 진단에 남는다', () => {
    const first = emptyScenario();
    const row = scenarioFixture().nation[0]!;
    first.nation = Array.from({ length: 500 }, () => [...row.slice(0, 8), Array(1000).fill('도시1')] as typeof row);
    const second = scenarioFixture();
    second.nation[0]![8] = Array(1000).fill('도시1');
    const report = validateMap(mapFixture(), { scenarios: [first, second] });
    expect(report.status).toBe('fail');
    expect(report.issues.map((item) => item.params.limit)).toEqual(['nations', 'ownedCities']);
  });
  it('개별 한도·형식 실패 맥락을 빼도 남은 맥락만으로 통과하지 않는다', () => {
    const oversized = { ...scenarioFixture(), general: Array(10001).fill(null) };
    for (const bad of [oversized, null]) {
      const report = validateMap(mapFixture(), { scenarios: [scenarioFixture(), bad] });
      expect(report.status).toBe('incomplete');
      expect(report.skipped).toContainEqual({ group: 'scenario-refs', reason: 'context-invalid', contextIndex: 1 });
    }
    const hugeMap = { ...mapFixture(), cities: Array(1001).fill(null) };
    expect(validateScenario(scenarioFixture(), { map: hugeMap }).status).toBe('incomplete');
    const badTerrain = v2Fixture();
    const report = validateMap(badTerrain, { scenarios: [oversized] });
    expect(report.status).toBe('incomplete');
  });
});
