import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMapJson, serializeMap, type MapV2 } from './contract';
import { testMap } from './fixtures';

// T4-80: 지금 형식(che)과 v2 읽기, v2 쓰기 왕복.
const cheSource = readFileSync(new URL('../../../../resources/map/che.json', import.meta.url), 'utf8');
const loaded = (source: string): MapV2 => {
  const result = parseMapJson(source);
  if (!result.ok) throw new Error(result.error);
  return result.map;
};

describe('지금 형식 읽기', () => {
  it('che를 v2로 읽는다. 도시 94개, 빈 지형 층, 700×500, 출처 고지 보존', () => {
    const result = parseMapJson(cheSource);
    expect(result.ok && result.legacy).toBe(true);
    const map = loaded(cheSource);
    expect(map.version).toBe(2);
    expect(map.cities).toHaveLength(94);
    expect(map.canvas).toEqual({ width: 700, height: 500 });
    expect(map.terrain).toEqual({ coast: [], lakes: [], rivers: [], mountains: [] });
    expect(map.$comment).toContain('MIT');
    expect(map.defaults).toEqual({ trust: 50, trade: 100, supplyState: 1, frontState: 0 });
    const raw = JSON.parse(cheSource) as { cities: Array<{ id: number; connections: number[]; meta?: unknown }> };
    expect(map.cities[0]).toMatchObject({ id: 1, name: '업', level: 8, region: 1, position: { x: 345, y: 130 } });
    expect(map.cities.map((city) => city.connections)).toEqual(raw.cities.map((city) => city.connections));
    expect(map.cities[0]).not.toHaveProperty('meta');
  });
});

describe('v2 쓰기와 읽기', () => {
  it('쓰고 다시 읽으면 같은 지도이고 다시 쓴 글자열도 같다', () => {
    const map = loaded(cheSource);
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

  it('키 순서가 입력과 달라도 같은 글자열을 쓴다', () => {
    const map = testMap();
    const shuffled = {
      ...map,
      cities: map.cities.map((city) => Object.fromEntries(Object.entries(city).reverse()) as typeof city),
    };
    expect(serializeMap(shuffled)).toBe(serializeMap(map));
  });
});

describe('모양이 틀린 파일 거부', () => {
  const base = () => JSON.parse(serializeMap(testMap())) as Record<string, unknown>;
  it.each([
    ['JSON이 아님', '{', 'JSON으로 읽을 수 없는 파일입니다.'],
    ['형식 판 3', JSON.stringify({ ...base(), version: 3 }), '지원하지 않는 형식 판입니다 (version 3).'],
    [
      '도시 ID가 글자',
      JSON.stringify({ ...base(), cities: [{ ...testMap().cities[0], id: 'a' }] }),
      '정수여야 합니다 (1번째 도시의 ID).',
    ],
    [
      '좌표 없음',
      JSON.stringify({ ...base(), cities: [{ ...testMap().cities[0], position: null }] }),
      '좌표가 없습니다 (1번째 도시).',
    ],
    [
      '점 모양',
      JSON.stringify({ ...base(), terrain: { coast: [[[1, 2, 3]]] } }),
      '점은 [x, y] 모양이어야 합니다 (해안 1).',
    ],
    ['캔버스 0', JSON.stringify({ ...base(), canvas: { width: 0, height: 10 } }), '캔버스 크기는 0보다 커야 합니다.'],
  ])('%s', (_, source, error) => {
    expect(parseMapJson(source)).toEqual({ ok: false, error });
  });
});
