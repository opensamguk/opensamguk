import { describe, expect, it } from 'vitest';
import { mapV2Schema, normalizeMapToV2, readMapVersion } from './format';
import { mapFixture, v2Fixture, freezeDeep } from '../validate/testFixtures';

describe('T4-76 지도 사본 정규화', () => {
  it('형식 판과 중첩 추가 필드를 구분한다', () => {
    expect(readMapVersion({})).toBe(1);
    expect(readMapVersion({ version: 2 })).toBe(2);
    for (const version of [null, 1, 3, undefined]) expect(readMapVersion({ version })).toBeNull();
    const v2 = v2Fixture();
    expect(mapV2Schema.safeParse({ ...v2, cities: [{ ...v2.cities[0], meta: {} }] }).success).toBe(false);
    expect(normalizeMapToV2({ ...mapFixture(), version: 3 }).ok).toBe(false);
  });
  it.each(['bad', null, true, [], {}, NaN, Infinity, -Infinity])(
    'v1의 검사 대상 밖 값 %j를 새 판에 옮기지 않는다',
    (bad) => {
      for (const field of ['trade', 'frontState'] as const) {
        const source = { ...mapFixture(), defaults: { trust: 50, supplyState: 1, [field]: bad } };
        const before = structuredClone(source);
        const result = normalizeMapToV2(freezeDeep(source));
        expect(source).toEqual(before);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.map.defaults).not.toHaveProperty(field);
        expect(result.dropped).toEqual([`defaults.${field}`]);
        expect(mapV2Schema.safeParse(result.map).success).toBe(true);
        expect(normalizeMapToV2(result.map)).toEqual({ ok: true, map: result.map, dropped: [] });
      }
    },
  );
  it('출처와 유한수 100·0을 보존하고 키 삽입 순서가 달라도 누락 목록이 같다', () => {
    const map = mapFixture();
    const source = {
      ...map,
      $comment: 'MIT source',
      meta: {},
      defaults: { ...map.defaults, z: {}, trade: 100, frontState: 0, a: {} },
    };
    const result = normalizeMapToV2(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.map.$comment).toBe('MIT source');
    expect(result.map.defaults).toEqual({ trust: 50, supplyState: 1, trade: 100, frontState: 0 });
    expect(result.dropped).toEqual(['defaults.a', 'defaults.z', 'meta']);
    const reversed = { ...source, defaults: Object.fromEntries(Object.entries(source.defaults).reverse()) };
    expect(normalizeMapToV2(reversed)).toEqual(result);
    result.map.cities[0]!.max.wall = 0;
    expect(source.cities[0]!.max.wall).toBe(100);
    expect(normalizeMapToV2(map)).toMatchObject({ ok: true, dropped: [] });
  });
  it('누락 경로의 배열 번호는 문자 정렬을 쓰지 않는다', () => {
    const source = {
      ...mapFixture(),
      cities: Array.from({ length: 12 }, (_, i) => ({ ...mapFixture().cities[0]!, id: i + 1, meta: {} })),
    };
    const result = normalizeMapToV2(source);
    expect(result.ok && result.dropped).toEqual(Array.from({ length: 12 }, (_, i) => `cities.${i}.meta`));
  });
});
