import { describe, expect, it } from 'vitest';
import { parseMapJson, serializeMap, type MapV2 } from './contract';
import { testMap } from './fixtures';

// T4-80·T4-88: 지금 형식(v1)과 v2 읽기, v2 쓰기 왕복. 실제 che@1 94도시 왕복은 e2e/mapEditor.spec.ts가 게시 DB에서 읽어 본다.
const loaded = (source: string): MapV2 => {
  const result = parseMapJson(source);
  if (!result.ok) throw new Error(result.error);
  return result.map;
};

const values = (population: number) => ({
  population,
  agriculture: 100,
  commerce: 200,
  security: 300,
  defence: 400,
  wall: 500,
});
// 작은 v1 지도. 출처 고지, 기본값 네 칸, 순서가 섞인 연결, 형식 밖 meta를 일부러 넣었다.
const legacyCity = (id: number, name: string, connections: number[], extra: object = {}) => ({
  id,
  name,
  level: id,
  region: id,
  position: { x: id * 100, y: id * 50 },
  connections,
  max: values(id * 1000),
  initial: values(id * 100),
  ...extra,
});
const legacySource = JSON.stringify({
  $comment: '시험용 출처 고지 · MIT',
  id: 'legacy',
  name: '옛 형식',
  cities: [
    legacyCity(1, '북성', [3, 2], { meta: { source: 'legacy', connectionNames: ['남성', '중성'] } }),
    legacyCity(2, '중성', [1, 3]),
    legacyCity(3, '남성', [2, 1]),
  ],
  defaults: { trust: 50, trade: 100, supplyState: 1, frontState: 0 },
});

describe('지금 형식 읽기', () => {
  it('v1을 v2로 읽는다. 도시 수, 빈 지형 층, 700×500, 출처 고지·기본값·연결 순서 보존, meta 버림', () => {
    const result = parseMapJson(legacySource);
    expect(result.ok && result.legacy).toBe(true);
    const map = loaded(legacySource);
    expect(map.version).toBe(2);
    expect(map.cities).toHaveLength(3);
    expect(map.canvas).toEqual({ width: 700, height: 500 });
    expect(map.terrain).toEqual({ coast: [], lakes: [], rivers: [], mountains: [] });
    expect(map.$comment).toContain('MIT');
    expect(map.defaults).toEqual({ trust: 50, trade: 100, supplyState: 1, frontState: 0 });
    expect(map.cities[0]).toEqual({
      id: 1,
      name: '북성',
      level: 1,
      region: 1,
      position: { x: 100, y: 50 },
      connections: [3, 2],
      max: values(1000),
      initial: values(100),
    });
    expect(map.cities.map((city) => city.connections)).toEqual([
      [3, 2],
      [1, 3],
      [2, 1],
    ]);
    expect(map.cities[0]).not.toHaveProperty('meta');
  });
});

describe('v2 쓰기와 읽기', () => {
  it('쓰고 다시 읽으면 같은 지도이고 다시 쓴 글자열도 같다', () => {
    const map = testMap();
    map.terrain.coast.push([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 0],
    ]);
    map.terrain.rivers.push(
      {
        name: '황하',
        points: [
          [10, 10],
          [20, 30],
        ],
      },
      {
        points: [
          [1, 1],
          [2, 2],
        ],
      },
    );
    const text = serializeMap(map);
    const again = loaded(text);
    expect(again).toEqual(map);
    expect(serializeMap(again)).toBe(text);
    expect(parseMapJson(text)).toMatchObject({ ok: true, legacy: false });
  });

  it('v1에서 바꾼 지도도 쓰고 다시 읽으면 같다', () => {
    const map = loaded(legacySource);
    const text = serializeMap(map);
    expect(loaded(text)).toEqual(map);
    expect(serializeMap(loaded(text))).toBe(text);
  });

  it('키 순서가 입력과 달라도 같은 글자열을 쓴다', () => {
    const map = testMap();
    const shuffled = {
      ...map,
      cities: map.cities.map((city) => Object.fromEntries(Object.entries(city).reverse()) as typeof city),
    };
    expect(serializeMap(shuffled)).toBe(serializeMap(map));
  });
});

// 거부 문구는 공개 validateMap의 shape-invalid·map-canvas-range 문구를 그대로 쓴다.
describe('모양이 틀린 파일 거부', () => {
  const base = () => JSON.parse(serializeMap(testMap())) as Record<string, unknown>;
  it.each([
    ['JSON이 아님', '{', 'JSON으로 읽을 수 없는 파일입니다.'],
    ['형식 판 3', JSON.stringify({ ...base(), version: 3 }), '형식이 맞지 않습니다 (version, 허용된 값이어야 함).'],
    [
      '도시 ID가 글자',
      JSON.stringify({ ...base(), cities: [{ ...testMap().cities[0], id: 'a' }] }),
      '형식이 맞지 않습니다 (cities.0.id, 숫자여야 함).',
    ],
    [
      '좌표 없음',
      JSON.stringify({ ...base(), cities: [{ ...testMap().cities[0], position: null }] }),
      '형식이 맞지 않습니다 (cities.0.position, 객체여야 함).',
    ],
    [
      '점 모양',
      JSON.stringify({ ...base(), terrain: { coast: [[[1, 2, 3]]], lakes: [], rivers: [], mountains: [] } }),
      '형식이 맞지 않습니다 (terrain.coast.0.0, 길이나 값이 2 이하여야 함).',
    ],
    [
      '캔버스 0',
      JSON.stringify({ ...base(), canvas: { width: 0, height: 10 } }),
      '캔버스는 700×500이어야 합니다 (0, 10).',
    ],
  ])('%s', (_, source, error) => {
    expect(parseMapJson(source)).toEqual({ ok: false, error });
  });
});
