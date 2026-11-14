import { describe, expect, it } from 'vitest';
import { publicGeographySchema } from '../packages/shared/src/index';
import { operationalMapSchema } from '../packages/rules/src/world/map/operational';
import { createMapTerritory } from '../packages/rules/src/world/map/territory';
import { operationalMapDisplay, readOperationalMap } from '../packages/rules/src/world/map/stored';
import { readFileSync } from 'node:fs';

describe('INT-28 territory snapshot', () => {
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
