import { describe, expect, it } from 'vitest';
import { mapFixture } from '../validate/fixtures';
import { validateMap } from '../validate/map';
import { mapSchema, normalizeMapToV2, MAP_SKETCH_PALETTE } from './format';

describe('AC-P2-27 지도 형식', () => {
  it('v1은 모르는 칸을 버리며 v2 변환은 출처와 네 기본 칸을 보존한다', () => {
    const fixture = mapFixture();
    const v1 = { id: fixture.id, name: fixture.name, defaults: fixture.defaults, cities: fixture.cities };
    const input = {
      ...v1,
      $comment: '출처',
      meta: {},
      defaults: { ...v1.defaults, trade: 1, frontState: 0, ignored: 7 },
      cities: v1.cities.map((city) => ({ ...city, meta: {} })),
    };
    const before = structuredClone(input);
    expect(mapSchema.parse(input)).not.toHaveProperty('meta');
    const result = normalizeMapToV2(input);
    expect(result).toMatchObject({
      version: 2,
      $comment: '출처',
      canvas: { width: 700, height: 500 },
      defaults: { trade: 1, frontState: 0 },
    });
    expect(result.cities).toEqual(v1.cities);
    expect(result).not.toHaveProperty('meta');
    expect(result.defaults).not.toHaveProperty('ignored');
    expect(result.terrain).toEqual({ coast: [], lakes: [], mountains: [], rivers: [] });
    expect(normalizeMapToV2(result)).toBe(result);
    expect(validateMap(result)).toMatchObject({ ok: true, issues: [] });
    expect(input).toEqual(before);
  });

  it.each([
    [
      '루트',
      (m: Record<string, unknown>) => {
        m.extra = 1;
      },
    ],
    [
      'meta',
      (m: Record<string, unknown>) => {
        m.meta = {};
      },
    ],
    [
      'version',
      (m: Record<string, unknown>) => {
        m.version = 3;
      },
    ],
    [
      '빠진 층',
      (m: Record<string, unknown>) => {
        m.terrain = { coast: [], lakes: [], mountains: [] };
      },
    ],
    [
      '빠진 지형',
      (m: Record<string, unknown>) => {
        delete m.terrain;
      },
    ],
    [
      '도시 meta',
      (m: Record<string, unknown>) => {
        (m.cities as object[])[0] = { ...(m.cities as object[])[0], meta: {} };
      },
    ],
    [
      '중첩 칸',
      (m: Record<string, unknown>) => {
        m.canvas = { width: 700, height: 500, extra: 0 };
      },
    ],
    [
      '기본 칸',
      (m: Record<string, unknown>) => {
        m.defaults = { trust: 50, supplyState: 1, extra: 0 };
      },
    ],
    [
      '강 이름',
      (m: Record<string, unknown>) => {
        m.terrain = {
          coast: [],
          lakes: [],
          mountains: [],
          rivers: [
            {
              name: '',
              points: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        };
      },
    ],
  ])('v2 %s 형식 오류 뒤에는 뜻 검사를 하지 않는다', (_, change) => {
    const map = { ...mapFixture(), id: 'wrong' };
    change(map);
    const result = validateMap(map, { expectedId: 'expected' });
    expect(result.value).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((issue) => issue.code === 'shape-invalid' && issue.target.kind === 'path')).toBe(true);
  });

  it('형식 오류 경로와 유한수 검사를 보존한다', () => {
    const map = mapFixture();
    map.cities[0]!.position.x = Infinity;
    expect(validateMap(map).issues[0]?.target).toEqual({ kind: 'path', path: ['cities', 0, 'position', 'x'] });
    expect(MAP_SKETCH_PALETTE).toEqual(['#2b5d8c', '#cbb98a', '#4f8fd0', '#7a6347', '#6aa6d8']);
  });
});
