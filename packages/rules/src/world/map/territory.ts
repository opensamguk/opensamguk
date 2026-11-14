import { assignTerritory, toTile, type TerritorySeed } from '@opensamguk/shared';
import type { OperationalMapResource } from './operational';
import landMasks from './territoryLand.json';

const TILE = 8;
function landFor(map: Pick<OperationalMapResource, 'canvas' | 'basemap'>) {
  const mask = landMasks.find(
    (item) =>
      item.canvas.width === map.canvas.width &&
      item.canvas.height === map.canvas.height &&
      item.basemap.sha256 === map.basemap.sha256 &&
      item.basemap.bounds.every((bound, i) => bound === map.basemap.bounds[i]),
  );
  if (!mask) return undefined;
  const bytes = atob(mask.land);
  const indexAt = (x: number, y: number) => {
    const { u, v } = toTile(x, y, map.canvas, TILE);
    const i = Math.floor(u) - mask.originX;
    const j = Math.floor(v) - mask.originY;
    return i >= 0 && j >= 0 && i < mask.columns && j < mask.rows ? j * mask.columns + i : -1;
  };
  const walkable = (index: number) => index >= 0 && (bytes.charCodeAt(index >> 3) & (1 << (index % 8))) !== 0;
  return { indexAt, walkable };
}

export function createMapTerritory(
  map: OperationalMapResource,
  levels: ReadonlyMap<number, number>,
): OperationalMapResource {
  if (map.territory) return map;
  const land = landFor(map);
  if (!land) return map;
  const seeds: TerritorySeed[] = map.sites.flatMap((site) =>
    site.kind === 'CITY'
      ? [{ key: site.anchorKey, ...site.position, level: levels.get(site.anchorKey) ?? site.level }]
      : [],
  );
  const { owner, ...grid } = assignTerritory(seeds, map.canvas, TILE, (x, y) => land.walkable(land.indexAt(x, y)));
  // Cell keys are stable across conquest. Nation ownership follows the live city row.
  return { ...map, territory: { tile: TILE, ...grid, owner: Array.from(owner) } };
}
