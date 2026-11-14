import { describe, expect, it } from 'vitest';
import { assignTerritory, fromTile, publicGeographySchema, toTile } from '../packages/shared/src/index';
import { operationalMapSchema } from '../packages/rules/src/world/map/operational';
import { createMapTerritory } from '../packages/rules/src/world/map/territory';
import { operationalMapDisplay, readOperationalMap } from '../packages/rules/src/world/map/stored';
import { readFileSync } from 'node:fs';

describe('INT-28 territory snapshot', () => {
  it('keeps land within 12 walking tiles even when a larger city owns the junction', () => {
    const canvas = { width: 400, height: 400 };
    const tile = 8;
    const point = (u: number, v: number) => fromTile(u + 0.5, v + 0.5, canvas, tile);
    const grid = assignTerritory(
      [
        { key: 1, ...point(0, 0), level: 9 },
        { key: 2, ...point(6, 4), level: 1 },
      ],
      canvas,
      tile,
      (x, y) => {
        const { u, v } = toTile(x, y, canvas, tile);
        const column = Math.floor(u);
        const row = Math.floor(v);
        return (row === 0 && column >= 0 && column <= 17) || (column === 6 && row >= 0 && row <= 4);
      },
    );
    const owner = (u: number, v: number) => grid.owner[(v - grid.originY) * grid.columns + u - grid.originX];
    expect(owner(6, 0)).toBe(1);
    expect(owner(12, 0)).toBe(1);
    expect(owner(13, 0)).toBe(2);
    expect(owner(15, 0)).toBe(-1);
  });

  it.each(['integration', 'san10', 'san10-v2'])('%s keeps city ownership through storage', (id) => {
    const file = new URL('../resources/map/' + id + '.json', import.meta.url);
    const resource = operationalMapSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    const map = createMapTerritory(resource, new Map());
    const territory = map.territory!;
    const cityKeys = new Set(map.sites.flatMap((site) => (site.kind === 'CITY' ? [site.anchorKey] : [])));
    expect(territory.owner.some((owner) => cityKeys.has(owner))).toBe(true);
    expect(territory.owner.every((owner) => owner === -1 || cityKeys.has(owner))).toBe(true);
    expect(territory.owner).toContain(-1);
    expect(createMapTerritory(resource, new Map())).toEqual(map);
    const stored = readOperationalMap(JSON.parse(JSON.stringify(map)), ['operational-map'], {
      initial: { operationalMap: map },
    })!;
    const projected = publicGeographySchema.parse(operationalMapDisplay(stored));
    expect(projected.territory).toEqual(territory);
    expect(projected.sites).toHaveLength(resource.sites.length);
    const bad = { ...projected, territory: { ...territory, owner: [...territory.owner] } };
    bad.territory.owner[0] = 2147483647;
    expect(publicGeographySchema.safeParse(bad).success).toBe(false);
  });
});
