import { describe, expect, it } from 'vitest';
import type { ResourceIssueCode } from '@opensamguk/rules/resources';
import type { MapV2 } from './contract';
import { testCity, testMap } from './fixtures';
import { editorIssues } from './validate';

// T4-80·T4-88: 공개 validateMap의 지도 코드마다 통과 1건, 실패 1건과 화면 대상. 범위 경계는 rules가 정한다.
// 실제 che@1이 오류 0건인지는 e2e/mapEditor.spec.ts가 게시 DB에서 읽어 본다.
const codes = (map: MapV2) => editorIssues(map).map((issue) => issue.code);

const square: Array<[number, number]> = [
  [10, 10],
  [50, 10],
  [50, 50],
  [10, 10],
];

const cases: Array<{ code: ResourceIssueCode; pass: MapV2; fail: MapV2; target: unknown }> = [
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
    code: 'city-name-empty',
    pass: testMap(),
    fail: testMap([testCity(1, [2]), testCity(2, [1], { name: '  ' })]),
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
    fail: testMap([testCity(1, [2]), testCity(2, [1], { level: 10 })]),
    target: { kind: 'city', index: 1 },
  },
  {
    code: 'city-region-range',
    pass: testMap([testCity(1, [2], { region: 16 }), testCity(2, [1])]),
    fail: testMap([testCity(1, [2], { region: 17 }), testCity(2, [1])]),
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
    const issues = editorIssues(fail).filter((issue) => issue.code === code);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.target).toEqual(target);
    expect(issues[0]!.severity).toBe('error');
  });
});

describe('형식 오류와 경고', () => {
  it('이름이 빈 글자면 shape-invalid를 그 도시로 가리키고 rules 문구를 그대로 쓴다', () => {
    expect(editorIssues(testMap([testCity(1, [2]), testCity(2, [1], { name: '' })]))).toEqual([
      {
        code: 'shape-invalid',
        severity: 'error',
        message: '형식이 맞지 않습니다 (cities.1.name, 길이나 값이 1 이상이어야 함).',
        target: { kind: 'city', index: 1 },
      },
    ]);
  });

  it('도시가 땅 밖이면 경고로 알린다', () => {
    const map = { ...testMap(), terrain: { coast: [square], lakes: [], rivers: [], mountains: [] } };
    map.cities = [testCity(1, [2]), testCity(2, [1], { position: { x: 200, y: 200 } })];
    expect(editorIssues(map)).toEqual([
      {
        code: 'city-off-land',
        severity: 'warning',
        message: '도시가 땅 밖이나 호수 안에 있습니다 (도시2, 200, 200).',
        target: { kind: 'city', index: 1 },
      },
    ]);
  });
});

describe('문구', () => {
  it('받침에 맞는 조사를 쓴다', () => {
    const messages = editorIssues(
      testMap([
        testCity(1, [2], { name: '업' }),
        testCity(2, [1, 3], { name: '허창' }),
        testCity(3, [], { name: '낙양' }),
      ]),
    ).map((issue) => issue.message);
    expect(messages).toContain('허창에서 낙양으로 가는 연결만 있고 돌아오는 연결이 없습니다.');
    expect(messages).toContain('낙양이 업의 연결망에 닿지 않습니다.');
  });

  it('겹치는 도시 이름은 두 ID를 함께 알린다', () => {
    const issues = editorIssues(testMap([testCity(1, [2], { name: '업' }), testCity(2, [1], { name: '업' })]));
    expect(issues.map((issue) => issue.message)).toEqual(['도시 이름 업이 ID 1과 ID 2에 겹칩니다.']);
  });

  it('강은 점이 2개 미만이면 열린 선으로 알린다', () => {
    const map = {
      ...testMap(),
      terrain: { coast: [], lakes: [], rivers: [{ points: [[1, 1]] as Array<[number, number]> }], mountains: [] },
    };
    expect(editorIssues(map)).toEqual([
      {
        code: 'terrain-open',
        severity: 'error',
        message: '강 1의 점이 1개라서 선이 되지 않습니다.',
        target: { kind: 'terrain', layer: 'rivers', index: 0 },
      },
      {
        code: 'terrain-degenerate',
        severity: 'error',
        message: '지형의 서로 다른 점이 부족합니다 (1, 2).',
        target: { kind: 'terrain', layer: 'rivers', index: 0 },
      },
    ]);
  });
});
