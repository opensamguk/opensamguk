import { describe, expect, it } from 'vitest';
import { validateMap } from './map';
import { codes, freezeDeep, makeCity, mapFixture, scenarioFixture, v2Fixture } from './testFixtures';

const complete = (map: unknown) => validateMap(map, { scenarios: [] });
describe('T4-76 지도 검증', () => {
  it('맥락 생략과 확인할 시나리오가 없는 경우를 구분한다', () => {
    expect(validateMap(mapFixture()).status).toBe('incomplete');
    expect(complete(mapFixture()).status).toBe('pass');
    const map = freezeDeep(v2Fixture());
    expect(complete(map)).toEqual(complete(structuredClone(map)));
  });
  it.each([
    { raw: null, count: 1 },
    { raw: 1, count: 1 },
    { raw: 'map', count: 1 },
    { raw: [], count: 1 },
    { raw: { cities: {} }, count: 4 },
  ])('깨진 입력 $raw에서 관계 검사를 하지 않는다', ({ raw, count }) => {
    const report = complete(raw);
    expect(codes(report)).toEqual(Array(count).fill('shape-invalid'));
    expect(report.status).toBe('fail');
    expect(report.ran).toEqual(['limits', 'shape']);
    expect(report.skipped.every((item) => item.reason === 'blocked')).toBe(true);
  });
  it('모르는 판의 코드·심각도·위치와 차단 그룹을 확인한다', () => {
    const report = complete({ ...mapFixture(), version: 4 });
    expect(report).toMatchObject({
      status: 'fail',
      ran: ['limits', 'shape'],
      issues: [{ code: 'map-version-unknown', severity: 'error', target: { kind: 'path', path: ['version'] } }],
      skipped: ['cities', 'links', 'network', 'terrain', 'scenario-refs'].map((group) => ({
        group,
        reason: 'blocked',
      })),
    });
  });
  it.each([
    { label: '글자 위치', input: { ...mapFixture(), cities: [{ ...makeCity(), position: '잘못된 위치' }] } },
    { label: 'v2 추가 칸', input: { ...v2Fixture(), extra: true } },
    { label: '좌표 NaN', input: { ...v2Fixture(), cities: [{ ...makeCity(), position: { x: NaN, y: 0 } }] } },
    { label: '캔버스 NaN', input: { ...v2Fixture(), canvas: { width: NaN, height: 500 } } },
  ])('$label 형식 오류 뒤 관계 검사를 막는다', ({ input }) => {
    const report = complete(input);
    expect(report.status).toBe('fail');
    expect(report.ran).toEqual(['limits', 'shape']);
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.issues.every((item) => item.code === 'shape-invalid' && item.severity === 'error')).toBe(true);
    expect(report.skipped).toEqual(
      ['cities', 'links', 'network', 'terrain', 'scenario-refs'].map((group) => ({ group, reason: 'blocked' })),
    );
  });
  it.each([
    ['level', 0],
    ['level', 9],
    ['region', 0],
    ['region', 9],
  ] as const)('%s %i는 권장 범위 경고만 내고 게시를 막지 않는다', (field, value) => {
    const map = mapFixture();
    map.cities[0]![field] = value;
    expect(complete(map)).toMatchObject({
      status: 'pass',
      issues: [
        {
          code: `city-${field}-range`,
          severity: 'warning',
          target: { kind: 'city', index: 0 },
        },
      ],
    });
  });
  it('도시 오류의 대상과 순서를 보존하고 원본을 바꾸지 않는다', () => {
    const map = mapFixture();
    Object.assign(map.cities[1]!, { id: 1, name: '도시1', level: 0, region: 9, position: { x: -1, y: 10 } });
    map.cities[1]!.initial.wall = 101;
    const before = structuredClone(map);
    const report = complete(freezeDeep(map));
    expect(codes(report).slice(0, 6)).toEqual([
      'city-id-duplicate',
      'city-name-duplicate',
      'city-out-of-canvas',
      'city-level-range',
      'city-region-range',
      'city-initial-over-max',
    ]);
    expect(report.issues.slice(0, 6).every((item) => item.target.kind === 'city' && item.target.index === 1)).toBe(
      true,
    );
    expect(map).toEqual(before);
    expect(report.issues.find((item) => item.code === 'city-out-of-canvas')).toMatchObject({
      severity: 'error',
      target: { kind: 'city', index: 1 },
    });
  });
  it('빈 이름은 형식 오류이고 공백 이름은 게시를 막지 않는 경고다', () => {
    for (const name of ['   ', ' 도시 ']) {
      const map = mapFixture();
      map.cities[0]!.name = name;
      const result = complete(map);
      expect(result.status).toBe('pass');
      expect(codes(result)).toEqual(['city-name-blank']);
    }
    const map = mapFixture();
    map.cities[0]!.name = '';
    expect(codes(complete(map))).toEqual(['shape-invalid']);
    expect(complete(map).ran).not.toContain('cities');
  });
  it('중복·자기·없는·한쪽 연결과 연결망 분리를 함께 설명한다', () => {
    const map = mapFixture();
    map.cities[0]!.connections = [2, 2, 1, 99];
    map.cities[1]!.connections = [];
    expect(codes(complete(map))).toEqual([
      'link-duplicate',
      'link-self',
      'link-missing-city',
      'link-one-way',
      'network-split',
    ]);
    expect(complete(map)).toMatchObject({
      status: 'fail',
      issues: [
        ...['link-duplicate', 'link-self', 'link-missing-city', 'link-one-way'].map((code) => ({
          code,
          severity: 'error',
          target: { kind: 'city', index: 0 },
        })),
        { code: 'network-split', severity: 'error', target: { kind: 'city', index: 1 } },
      ],
    });
    expect(complete(mapFixture()).issues).toEqual([]);
  });
  it('좌표 튜플 형식과 고리 점 수·닫힘을 다른 단계에서 검사한다', () => {
    const map = v2Fixture();
    map.terrain.coast = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    ];
    map.terrain.rivers = [{ points: [[701, 0]] }];
    expect(codes(complete(map))).toEqual(['terrain-open', 'terrain-open', 'terrain-out-of-canvas']);
    expect(complete(map)).toMatchObject({
      status: 'fail',
      issues: [
        { code: 'terrain-open', severity: 'error', target: { kind: 'terrain', layer: 'coast', index: 0 } },
        { code: 'terrain-open', severity: 'error', target: { kind: 'terrain', layer: 'rivers', index: 0 } },
        { code: 'terrain-out-of-canvas', severity: 'error', target: { kind: 'terrain', layer: 'rivers', index: 0 } },
      ],
    });
    map.terrain.coast = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ],
    ];
    map.terrain.rivers = [];
    expect(complete(map).status).toBe('pass');
    expect(codes(complete({ ...map, terrain: { ...map.terrain, coast: [[[0, 0, 1]]] } }))).toEqual(['shape-invalid']);
  });
  it.each([
    [4097, 100, false],
    [4096, 1025, false],
    [4096, 1024, true],
    [1000, 800, true],
  ])('캔버스 %i×%i 상한을 검사한다', (width, height, pass) => {
    const map = v2Fixture();
    map.canvas = { width, height };
    expect(complete(map).status).toBe(pass ? 'pass' : 'fail');
    expect(codes(complete(map))).toEqual(pass ? [] : ['map-canvas-unsupported']);
  });
  it('시나리오의 없는 도시를 원래 시나리오와 행으로 가리킨다', () => {
    const scenario = scenarioFixture();
    scenario.nation[0]![8] = ['없음'];
    scenario.general[0]![4] = '없음';
    const report = validateMap(mapFixture(), { scenarios: [scenario] });
    expect(codes(report)).toEqual(['scenario-nation-city-missing', 'scenario-general-city-missing']);
    expect(report.issues.map((item) => item.source)).toEqual([
      { kind: 'SCENARIO', index: 0 },
      { kind: 'SCENARIO', index: 0 },
    ]);
    expect(report.issues.map((item) => item.target)).toEqual([
      { kind: 'nation', index: 0 },
      { kind: 'general', index: 0 },
    ]);
  });
  it('한도 이내의 많은 관계 오류를 잘라도 실패가 남는다', () => {
    const map = { ...mapFixture(), cities: Array.from({ length: 600 }, () => makeCity()) };
    const report = complete(map);
    expect(report).toMatchObject({ status: 'fail', truncated: true });
    expect(report.issues).toHaveLength(1000);
    const ring = {
      ...mapFixture(),
      cities: Array.from({ length: 1000 }, (_, i) => ({
        ...makeCity(i + 1),
        connections: [((i + 999) % 1000) + 1, ((i + 1) % 1000) + 1],
      })),
    };
    expect(complete(ring).status).toBe('pass');
  });
});
