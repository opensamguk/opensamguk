import { assignTerritory, type TerritoryOwnership, type TerritorySeed } from '@opensamguk/shared';

export { fromTile, reachOf, STAGE, toTile } from '@opensamguk/shared';
export type TerritorySite = TerritorySeed & { color: string | null };
export type TerritoryTiles = TerritoryOwnership & { data: Uint8Array };

const hex = (color: string | null): [number, number, number] => {
  if (!color) return [0, 0, 0];
  const value = color.replace('#', '');
  const rgb = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) || 0) as [number, number, number];
  // 순검정은 "나라 없음"과 겹치므로 한 칸 밝힌다.
  return rgb[0] + rgb[1] + rgb[2] === 0 ? [1, 1, 1] : rgb;
};

export function territoryTiles(
  sites: readonly TerritorySite[],
  canvas: { width: number; height: number },
  tile: number,
  isLand: (x: number, y: number) => boolean,
  isLake?: (x: number, y: number) => boolean,
): TerritoryTiles {
  const territory = assignTerritory(sites, canvas, tile, isLand, isLake);
  return colorTerritory(territory, sites);
}

export function colorTerritory(
  territory: Omit<TerritoryOwnership, 'owner'> & { owner: ArrayLike<number> },
  sites: readonly Pick<TerritorySite, 'key' | 'color'>[],
): TerritoryTiles {
  const owner = Int32Array.from(territory.owner);
  const colors = new Map(sites.map(({ key, color }, index) => [key, [...hex(color), (index % 255) + 1]]));
  const data = new Uint8Array(territory.owner.length * 4);
  owner.forEach((key, index) => {
    const color = colors.get(key);
    if (color) data.set(color, index * 4);
  });
  return { ...territory, owner, data };
}
