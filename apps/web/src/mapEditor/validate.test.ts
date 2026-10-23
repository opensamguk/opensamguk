import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMapJson, type MapV2 } from './contract';
import { testCity, testMap } from './fixtures';
import { validateMap, type IssueCode } from './validate';

// T4-80: C-M3 지도 항목마다 통과 1건, 실패 1건. che는 통과한다.
const codes = (map: MapV2) => validateMap(map).map((issue) => issue.code);

describe('che', () => {
  it('오류가 없다', () => {
    const result = parseMapJson(readFileSync(new URL('../../../../resources/map/che.json', import.meta.url), 'utf8'));
    if (!result.ok) throw new Error(result.error);
    expect(validateMap(result.map)).toEqual([]);
  });
});

const square: Array<[number, number]> = [
  [10, 10],
  [50, 10],
  [50, 50],
  [10, 10],
];

const cases: Array<{ code: IssueCode; pass: MapV2; fail: MapV2; target: unknown }> = [
  {
    code: 'city-id-duplicate',
    pass: testMap(),
    fail: testMap([testCity(1, [2]), testCity(2, [1]), testCity(2, [1], { name: '다른 도시' })]),
    target: { kind: 'city', index: 2 },
  },
  {
    code: 'city-name-duplicate',
    pass: testMap(),
    fail: testMap([testCity(1, [2]), testCity(2, [1], { name: '도시1' })]),
    target: { kind: 'city', index: 1 },
  },
  {
    code: 'city-out-of-canvas',
    pass: testMap([testCity(1, [2], { position: { x: 0, y: 0 } }), testCity(2, [1], { position: { x: 700, y: 500 } })]),
    fail: testMap([testCity(1, [2]), testCity(2, [1], { position: { x: 701, y: 10 } })]),
    target: { kind: 'city', index: 1 },
  },
  {
    code: 'city-level-range',
    pass: testMap([testCity(1, [2], { level: 1 }), testCity(2, [1], { level: 8 })]),
    fail: testMap([testCity(1, [2]), testCity(2, [1], { level: 9 })]),
    target: { kind: 'city', index: 1 },
  },
  {
    code: 'city-region-range',
    pass: testMap([testCity(1, [2], { region: 8 }), testCity(2, [1])]),
    fail: testMap([testCity(1, [2], { region: 0 }), testCity(2, [1])]),
    target: { kind: 'city', index: 0 },
  },
  {
    code: 'link-self',
    pass: testMap(),
    fail: testMap([testCity(1, [1, 2]), testCity(2, [1])]),
    target: { kind: 'city', index: 0 },
  },
  {
    code: 'link-missing-city',
    pass: testMap(),
    fail: testMap([testCity(1, [2, 9]), testCity(2, [1])]),
    target: { kind: 'city', index: 0 },
  },
  {
    code: 'link-one-way',
    pass: testMap(),
    fail: testMap([testCity(1, [2]), testCity(2, [1, 3]), testCity(3, [])]),
    target: { kind: 'city', index: 1 },
  },
  {
    code: 'network-split',
    pass: testMap(),
    fail: testMap([testCity(1, [2]), testCity(2, [1]), testCity(3, [4]), testCity(4, [3])]),
    target: { kind: 'city', index: 2 },
  },
  {
    code: 'terrain-open',
    pass: {
      ...testMap(),
      terrain: {
        coast: [square],
        lakes: [],
        rivers: [
          {
            points: [
              [1, 1],
              [2, 2],
            ],
          },
        ],
        mountains: [],
      },
    },
    fail: { ...testMap(), terrain: { coast: [], lakes: [square.slice(0, 3)], rivers: [], mountains: [] } },
    target: { kind: 'terrain', layer: 'lakes', index: 0 },
  },
  {
    code: 'terrain-out-of-canvas',
    pass: {
      ...testMap(),
      terrain: {
        coast: [],
        lakes: [],
        rivers: [
          {
            points: [
              [0, 0],
              [700, 500],
            ],
          },
        ],
        mountains: [],
      },
    },
    fail: {
      ...testMap(),
      terrain: { coast: [], lakes: [], rivers: [], mountains: [[...square.slice(0, 3), [-1, 10], [10, 10]]] },
    },
    target: { kind: 'terrain', layer: 'mountains', index: 0 },
  },
];

describe.each(cases)('$code', ({ code, pass, fail, target }) => {
  it('통과', () => {
    expect(codes(pass)).toEqual([]);
  });
  it('실패하면 대상을 가리킨다', () => {
    const issues = validateMap(fail).filter((issue) => issue.code === code);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.target).toEqual(target);
  });
});

describe('문구', () => {
  it('받침에 맞는 조사를 쓴다', () => {
    const messages = validateMap(
      testMap([
        testCity(1, [2], { name: '업' }),
        testCity(2, [1, 3], { name: '허창' }),
        testCity(3, [], { name: '낙양' }),
      ]),
    ).map((issue) => issue.message);
    expect(messages).toContain('허창에서 낙양으로 가는 연결만 있고 돌아오는 연결이 없습니다.');
    expect(messages).toContain('낙양 등 도시 1개가 업의 연결망에 닿지 않습니다.');
  });

  it('강은 점이 2개 미만이면 열린 선으로 알린다', () => {
    const map = {
      ...testMap(),
      terrain: { coast: [], lakes: [], rivers: [{ points: [[1, 1]] as Array<[number, number]> }], mountains: [] },
    };
    expect(validateMap(map)).toEqual([
      {
        code: 'terrain-open',
        message: '강 1의 점이 1개라서 선이 되지 않습니다.',
        target: { kind: 'terrain', layer: 'rivers', index: 0 },
      },
    ]);
  });
});
