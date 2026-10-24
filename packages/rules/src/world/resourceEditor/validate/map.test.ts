import { describe, expect, it } from 'vitest';
import type { MapResourceV2, Ring } from '../map/format';
import { MAP_LIMITS } from '../map/format';
import { mapFixture, scenarioFixture } from './fixtures';
import { validateMap } from './map';
import type { IssueTarget, ResourceIssueCode } from './issues';

const coast: Ring = [
  [0, 0],
  [700, 0],
  [700, 500],
  [0, 500],
  [0, 0],
];
const city = { kind: 'city', index: 0 } as const;
const terrain = { kind: 'terrain', layer: 'rivers', index: 0 } as const;
const cases: Array<[ResourceIssueCode, (map: MapResourceV2) => void, IssueTarget]> = [
  [
    'resource-id-mismatch',
    (m) => {
      m.id = 'other';
    },
    { kind: 'root' },
  ],
  [
    'map-canvas-range',
    (m) => {
      m.canvas.width = 701;
    },
    { kind: 'root' },
  ],
  [
    'map-too-large',
    (m) => {
      m.cities = Array.from({ length: 301 }, (_, i) => ({
        ...m.cities[0]!,
        id: i + 1,
        name: `도시${i + 1}`,
        connections: i === 0 ? Array.from({ length: 300 }, (_, j) => j + 2) : [1],
      }));
    },
    { kind: 'root' },
  ],
  [
    'city-id-duplicate',
    (m) => {
      m.cities = [
        { ...m.cities[0]!, connections: [] },
        { ...m.cities[1]!, id: 1, connections: [] },
      ];
    },
    { kind: 'city', index: 1 },
  ],
  [
    'city-name-empty',
    (m) => {
      m.cities[0]!.name = ' ';
    },
    city,
  ],
  [
    'city-name-duplicate',
    (m) => {
      m.cities[1]!.name = ' 도시1 ';
    },
    { kind: 'city', index: 1 },
  ],
  [
    'city-out-of-canvas',
    (m) => {
      m.cities[0]!.position.x = -1;
    },
    city,
  ],
  [
    'city-level-range',
    (m) => {
      m.cities[0]!.level = 9;
    },
    city,
  ],
  [
    'city-region-range',
    (m) => {
      m.cities[0]!.region = 0;
    },
    city,
  ],
  [
    'city-initial-over-max',
    (m) => {
      m.cities[0]!.initial.wall = 11;
    },
    city,
  ],
  [
    'link-duplicate',
    (m) => {
      m.cities[0]!.connections.push(2);
    },
    city,
  ],
  [
    'link-self',
    (m) => {
      m.cities[0]!.connections.push(1);
    },
    city,
  ],
  [
    'link-missing-city',
    (m) => {
      m.cities[0]!.connections.push(999);
    },
    city,
  ],
  [
    'link-one-way',
    (m) => {
      m.cities[1]!.connections = [3];
    },
    city,
  ],
  [
    'network-split',
    (m) => {
      m.cities.forEach((c) => {
        c.connections = [];
      });
    },
    { kind: 'city', index: 1 },
  ],
  [
    'terrain-open',
    (m) => {
      m.terrain.mountains = [coast.slice(0, -1)];
    },
    { kind: 'terrain', layer: 'mountains', index: 0 },
  ],
  [
    'terrain-degenerate',
    (m) => {
      m.terrain.rivers = [
        {
          points: [
            [1, 1],
            [1, 1],
          ],
        },
      ];
    },
    terrain,
  ],
  [
    'terrain-out-of-canvas',
    (m) => {
      m.terrain.rivers = [
        {
          points: [
            [0, 0],
            [701, 500],
          ],
        },
      ];
    },
    terrain,
  ],
  [
    'terrain-too-large',
    (m) => {
      m.terrain.rivers = [{ points: Array.from({ length: 2001 }, (_, i) => [i % 700, 0]) }];
    },
    terrain,
  ],
  [
    'city-off-land',
    (m) => {
      m.terrain.coast = [coast];
      m.terrain.lakes = [
        [
          [9, 9],
          [11, 9],
          [11, 11],
          [9, 11],
          [9, 9],
        ],
      ];
    },
    city,
  ],
];

describe('AC-P2-27 지도 검증', () => {
  it('공백뿐인 이름은 빈 이름 오류만 내고 중복 비교에서 뺍니다.', () => {
    const map = mapFixture();
    map.cities[0]!.name = ' ';
    map.cities[1]!.name = '\t ';
    expect(validateMap(map).issues.map((issue) => [issue.code, issue.target])).toEqual([
      ['city-name-empty', { kind: 'city', index: 0 }],
      ['city-name-empty', { kind: 'city', index: 1 }],
    ]);
    map.cities[0]!.name = '도시';
    map.cities[1]!.name = ' 도시 ';
    expect(validateMap(map).issues.map((issue) => issue.code)).toEqual(['city-name-duplicate']);
  });

  it.each(['coast', 'lakes', 'mountains', 'rivers'] as const)(
    '%s의 캔버스 밖 점을 선마다 하나로 묶습니다.',
    (layer) => {
      const map = mapFixture();
      const points: Ring = [[0, 0], ...Array.from({ length: 1998 }, (_, i): [number, number] => [-1, i % 500]), [0, 0]];
      if (layer === 'rivers')
        map.terrain.rivers = [
          { points },
          {
            points: [
              [0, 0],
              [700, 500],
            ],
          },
          {
            points: [
              [700, 500],
              [701, 500],
            ],
          },
        ];
      else
        map.terrain[layer] = [
          points,
          coast,
          [
            [0, 0],
            [701, 0],
            [700, 500],
            [0, 0],
          ],
        ];
      const issues = validateMap(map).issues.filter((issue) => issue.code === 'terrain-out-of-canvas');
      expect(issues).toHaveLength(2);
      expect(issues[0]).toMatchObject({
        target: { kind: 'terrain', layer, index: 0 },
        params: { outsideCount: 1998, firstPointIndex: 1 },
      });
      expect(issues[1]).toMatchObject({
        target: { kind: 'terrain', layer, index: 2 },
        params: { outsideCount: 1, firstPointIndex: 1 },
      });
      expect(issues[0]!.params).not.toHaveProperty('x');
      expect(issues[0]!.params).not.toHaveProperty('pointIndex');
    },
  );

  it.each(cases)('%s 실패와 고친 통과', (code, change, target) => {
    const good = mapFixture();
    expect(validateMap(good, { expectedId: 'map' })).toMatchObject({ ok: true, issues: [] });
    const changed = structuredClone(good);
    change(changed);
    const result = validateMap(changed, { expectedId: 'map' });
    expect(result.issues.map((issue) => issue.code)).toEqual([code]);
    expect(result.issues[0]).toMatchObject({ target, severity: code === 'city-off-land' ? 'warning' : 'error' });
    expect(result.ok).toBe(code === 'city-off-land');
    expect(result.value).not.toBeNull();
  });

  it('연결망은 양쪽 연결만 따라가며 못 닿는 첫 도시 하나를 알린다', () => {
    const map = mapFixture();
    map.cities[0]!.connections = [2];
    map.cities[1]!.connections = [1];
    map.cities[2]!.connections = [1];
    expect(validateMap(map).issues.map((i) => [i.code, i.target])).toEqual([
      ['link-one-way', { kind: 'city', index: 2 }],
      ['network-split', { kind: 'city', index: 2 }],
    ]);
  });

  it('경계 좌표·한도 경계·빈 지형·호수만 있는 지도는 통과한다', () => {
    const map = mapFixture();
    map.cities[0]!.position = { x: 0, y: 0 };
    map.cities[1]!.position = { x: 700, y: 500 };
    map.terrain.lakes = [coast];
    expect(validateMap(map).issues).toEqual([]);
    map.terrain.lakes = [];
    map.terrain.rivers = Array.from({ length: 10 }, () => ({
      points: Array.from({ length: 2000 }, (_, i) => [i % 700, 0]),
    }));
    expect(validateMap(map).issues).toEqual([]);
    map.terrain.rivers.push({
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(validateMap(map).issues).toEqual([
      expect.objectContaining({
        code: 'terrain-too-large',
        target: { kind: 'root' },
        params: { count: 20002, limit: MAP_LIMITS.terrainPoints },
      }),
    ]);
  });

  it('닫힌 퇴화 다각형과 짧은 강을 알린다', () => {
    const map = mapFixture();
    map.terrain.mountains = [
      [
        [0, 0],
        [1, 1],
        [0, 0],
        [0, 0],
      ],
    ];
    map.terrain.rivers = [{ points: [[1, 1]] }];
    expect(validateMap(map).issues.map((i) => i.code)).toEqual([
      'terrain-degenerate',
      'terrain-open',
      'terrain-degenerate',
    ]);
  });

  it('오류 순서는 전체·도시·연결망·지형·경고·다른 자원이며 입력을 바꾸지 않는다', () => {
    const map = mapFixture();
    map.canvas.width = 701;
    map.cities[0]!.level = 9;
    map.cities.forEach((c) => {
      c.connections = [];
    });
    map.terrain.coast = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ];
    map.terrain.rivers = [
      {
        points: [
          [0, 0],
          [702, 0],
        ],
      },
    ];
    const before = structuredClone(map);
    const ctx = { scenarios: [{ key: 'bad', content: {} }] };
    const result = validateMap(map, ctx);
    expect(result).toEqual(validateMap(map, ctx));
    expect(result.issues.map((i) => i.code)).toEqual([
      'map-canvas-range',
      'city-level-range',
      'network-split',
      'terrain-out-of-canvas',
      'city-off-land',
      'city-off-land',
      'city-off-land',
      'scenario-invalid',
    ]);
    expect(map).toEqual(before);
  });

  it('넘긴 시나리오는 도시 참조만 보고 자원 키를 단다', () => {
    const scenario = scenarioFixture();
    scenario.nation[0]![8] = ['없음'];
    scenario.general[0]![4] = '없음';
    scenario.general[0]![3] = 999;
    const result = validateMap(mapFixture(), { scenarios: [{ key: 'scenario@2', content: scenario }] });
    expect(result.issues.map((i) => i.code)).toEqual(['scenario-nation-city-missing', 'scenario-general-city-missing']);
    expect(result.issues.every((i) => i.resource?.key === 'scenario@2' && i.resource.kind === 'SCENARIO')).toBe(true);
    expect(validateMap(mapFixture(), { scenarios: [{ key: 'good', content: scenarioFixture() }] }).issues).toEqual([]);
    expect(validateMap(mapFixture(), { scenarios: [{ key: 'bad', content: {} }] }).issues).toEqual([
      expect.objectContaining({ code: 'scenario-invalid', resource: { kind: 'SCENARIO', key: 'bad' } }),
    ]);
  });
});
