import { assignTerritory, fromTile, toTile, type TerritorySeed } from '@opensamguk/shared';
import type { InitialCity } from '../bootstrap';
import { isStrategicSite, type OperationalMapResource } from './operational';
import landMasks from './territoryLand.json' with { type: 'json' };
import mountainMask from './supplyMountains.json' with { type: 'json' };

const TILE = 8;

function terrainFor(map: OperationalMapResource) {
  const mask = landMasks.find(
    (item) =>
      item.canvas.width === map.canvas.width &&
      item.canvas.height === map.canvas.height &&
      item.basemap.sha256 === map.basemap.sha256 &&
      item.basemap.bounds.every((bound, i) => bound === map.basemap.bounds[i]),
  );
  if (!mask || mask.basemap.sha256 !== mountainMask.basemap.sha256) return undefined;
  const land = atob(mask.land);
  const mountains = atob(mountainMask.mountain);
  const indexAt = (u: number, v: number) => {
    const i = u - mask.originX;
    const j = v - mask.originY;
    return i >= 0 && j >= 0 && i < mask.columns && j < mask.rows ? j * mask.columns + i : -1;
  };
  const has = (bytes: string, i: number) => i >= 0 && (bytes.charCodeAt(i >> 3) & (1 << (i % 8))) !== 0;
  const isLand = (x: number, y: number) => {
    const at = toTile(x, y, map.canvas, TILE);
    return has(land, indexAt(Math.floor(at.u), Math.floor(at.v)));
  };
  return { mask, indexAt, hasLand: (i: number) => has(land, i), isMountain: (i: number) => has(mountains, i), isLand };
}

export function createMapTerritory(
  map: OperationalMapResource,
  cities: readonly InitialCity[],
): OperationalMapResource {
  if (map.siteClassification !== 'd096') return map;
  const terrain = terrainFor(map);
  if (!terrain) return map;
  const seeds: TerritorySeed[] = cities.flatMap((city) =>
    city.kind === 'CITY' && city.parentCityKey == null
      ? [{ key: city.cityKey, x: city.x, y: city.y, level: city.level }]
      : [],
  );
  const { owner, ...grid } = assignTerritory(seeds, map.canvas, TILE, terrain.isLand);
  return { ...map, territory: { tile: TILE, ...grid, owner: Array.from(owner) } };
}

/** Ownership keys stay stable in the ledger. The occupying nation comes from the current world state. */
export function supplyTerrain(map: OperationalMapResource) {
  if (!map.territory) return undefined;
  const terrain = terrainFor(map);
  const { territory } = map;
  if (
    !terrain ||
    (['originX', 'originY', 'columns', 'rows'] as const).some((key) => territory[key] !== terrain.mask[key])
  )
    throw new Error('행군 지도와 영지 지형의 칸이 일치하지 않습니다.');
  const { canvas } = map;
  const tileAt = ({ x, y }: { x: number; y: number }) => toTile(x, y, canvas, TILE);
  const sites = map.sites.filter((site) => isStrategicSite(map, site));
  const special = new Map<number, number>();
  for (const site of [...sites].sort((a, b) => b.anchorKey - a.anchorKey)) {
    if (site.kind === 'CITY' && site.parentCityKey === undefined) continue;
    const { u, v } = tileAt(site.position);
    special.set(terrain.indexAt(Math.floor(u), Math.floor(v)), site.anchorKey);
  }
  // Unlike territory ownership, distance to safety includes passes, counties, and battlefields.
  const nearby = assignTerritory(
    sites.map((site) => ({ key: site.anchorKey, ...site.position, level: 0 })),
    canvas,
    TILE,
    terrain.isLand,
  ).owner;

  const cellAt = (u: number, v: number, atSea: boolean, onWater: boolean) => {
    const i = terrain.indexAt(u, v);
    const centre = fromTile(u + 0.5, v + 0.5, canvas, TILE);
    const owner = special.get(i) ?? (atSea ? -1 : territory.owner[i]) ?? -1;
    return {
      cellId: `cell:${u}:${v}`,
      x: Math.round(Math.max(0, Math.min(canvas.width, centre.x))),
      y: Math.round(Math.max(0, Math.min(canvas.height, centre.y))),
      mountain: !onWater && terrain.isMountain(i),
      remote: !onWater && terrain.hasLand(i) && nearby[i] === -1,
      ownerAnchorKey: owner === -1 ? null : owner,
    };
  };

  return { tileAt, cellAt };
}
