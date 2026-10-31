import { expect, it } from 'vitest';
import { publicGeographySchema } from './publicGeography';

const geography = {
  id: 'integration',
  version: 3,
  canvas: { width: 1000, height: 700 },
  basemap: {
    source: 'natural-earth-5.1.2',
    projection: 'WGS84 plate carree',
    sha256: 'a'.repeat(64),
    bounds: [94, 17, 132.57142857142856, 44],
  },
  sites: [{ id: 'city:1', name: '도시', kind: 'CITY', anchorKey: 1, position: { x: 200, y: 100 } }],
  routes: [],
};
it('AC-INT-10 공개 지리 사본은 중첩된 병력·경제·소유·사람 필드를 버린다', () => {
  const parsed = publicGeographySchema.parse({
    ...geography,
    generals: [{ name: 'secret' }],
    sites: [
      {
        ...geography.sites[0],
        nationId: 1,
        crew: 100,
        initial: { population: 999 },
        position: { x: 200, y: 100, gold: 3 },
      },
    ],
    routes: [
      { id: 'route:1', from: 'city:1', to: 'city:1', mode: 'LAND', direction: 'BOTH', enabled: true, armies: [1] },
    ],
  });
  expect(Object.keys(parsed)).toEqual(['id', 'version', 'canvas', 'basemap', 'sites', 'routes']);
  expect(parsed.sites).toEqual(geography.sites);
  expect(JSON.stringify(parsed)).not.toMatch(/secret|population|nationId|crew|gold|armies/);
});
it.each(['kind', 'anchor', 'port', 'coordinate', 'canvas'] as const)(
  'AC-INT-10 잘못된 공개 지리 %s를 거부한다',
  (field) => {
    const value = structuredClone(geography);
    const changed =
      field === 'kind'
        ? { ...value, sites: [{ ...value.sites[0], kind: 'ARMY' }] }
        : field === 'anchor'
          ? { ...value, sites: [{ ...value.sites[0], anchorKey: undefined }] }
          : field === 'port'
            ? { ...value, sites: [{ ...value.sites[0], kind: 'PORT', anchorKey: undefined }] }
            : field === 'coordinate'
              ? { ...value, sites: [{ ...value.sites[0], position: { x: Infinity, y: 0 } }] }
              : { ...value, canvas: { width: 0, height: 500 } };
    expect(publicGeographySchema.safeParse(changed).success).toBe(false);
  },
);

it.each(['id', 'anchor'] as const)('AC-INT-10 공개 사본은 중복 %s를 거부한다', (field) => {
  const duplicate = { ...geography.sites[0]!, ...(field === 'anchor' ? { id: 'city:2' } : { anchorKey: 2 }) };
  expect(publicGeographySchema.safeParse({ ...geography, sites: [...geography.sites, duplicate] }).success).toBe(false);
});
