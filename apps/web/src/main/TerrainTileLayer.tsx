import type { PublicGeography } from '@opensamguk/shared';
import { useEffect, useMemo, useState } from 'react';
import { BANK_TILES, BRIDGE_TILES, ROAD_TILES, TERRAIN_TILE_CELLS, TERRAIN_TILES } from '../art/tiles';
import { ROAD_CELL } from './roadPixels';
import {
  WATER_TERRAINS,
  bankTiles,
  roadTiles,
  shadowPaths,
  terrainGrid,
  type TerrainPalette,
  terrainPaths,
  visibleCells,
  type View,
} from './terrainTiles';

export type TerrainGrid = { cells: Int8Array; columns: number; rows: number };

// 확대 지형·길 타일 층 (INT-20). 칸 하나에 타일 하나를 깔고, 타일 그림은 지형마다 SVG 무늬로 한 번만 둔다.
// 그림은 apps/web/src/art/sources.json의 생성 원본을 tools/pixel-assets/build-tiles.py로 줄인 것이다.

type Grid = TerrainGrid;
const grids = new Map<string, Promise<Grid>>();

// 도트 바탕 PNG의 픽셀 색을 지형 번호로 읽는다. 같은 그림은 한 번만 읽는다.
function loadGrid(url: string, colors: TerrainPalette): Promise<Grid> {
  let grid = grids.get(url);
  if (!grid) {
    grid = new Promise<Grid>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return reject(new Error('canvas'));
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        resolve({
          cells: terrainGrid(data, canvas.width, canvas.height, colors),
          columns: canvas.width,
          rows: canvas.height,
        });
      };
      image.onerror = () => reject(new Error('image'));
      image.src = url;
    });
    grids.set(url, grid);
  }
  return grid;
}

// 지형 칸을 읽지 못하는 환경(그림을 못 읽는 시험 등)에서는 null이고 타일과 물길 표시를 하지 않는다.
export function useTerrainGrid(pixels: string | undefined, colors: TerrainPalette | undefined) {
  const [grid, setGrid] = useState<Grid | null>(null);
  useEffect(() => {
    if (!pixels || !colors || typeof document === 'undefined') return;
    let live = true;
    loadGrid(pixels, colors).then(
      (value) => live && setGrid(value),
      () => live && setGrid(null),
    );
    return () => {
      live = false;
    };
  }, [pixels, colors]);
  return grid;
}

export function TerrainTileLayer({
  grid,
  map,
  skip,
  gateCells,
  view,
  idPrefix,
}: {
  grid: Grid;
  map: Pick<PublicGeography, 'sites' | 'routes'>;
  skip: ReadonlySet<string>;
  // 거점 중심에서 문 칸까지의 칸 수.
  gateCells: (siteId: string) => number;
  view: View;
  idPrefix: string;
}) {
  const roads = useMemo(() => roadTiles(map, skip, gateCells), [map, skip, gateCells]);
  const ground = grid;
  const terrains = terrainPaths(ground.cells, ground.columns, ground.rows, view);
  const shadows = shadowPaths(ground, view);
  const banks = bankTiles(ground, view);
  const { left, top, right, bottom } = visibleCells(view, grid.columns, grid.rows);
  const visibleRoads = roads.filter((tile) => tile.x >= left && tile.x <= right && tile.y >= top && tile.y <= bottom);
  return (
    <g aria-hidden="true" pointerEvents="none" data-testid="terrain-tiles">
      <defs>
        {terrains.map(({ terrain }) => (
          <pattern
            key={terrain}
            id={`${idPrefix}-${terrain}`}
            patternUnits="userSpaceOnUse"
            width={ROAD_CELL * (TERRAIN_TILE_CELLS[terrain] ?? 1)}
            height={ROAD_CELL * (TERRAIN_TILE_CELLS[terrain] ?? 1)}
          >
            <image
              href={TERRAIN_TILES[terrain]}
              width={ROAD_CELL * (TERRAIN_TILE_CELLS[terrain] ?? 1)}
              height={ROAD_CELL * (TERRAIN_TILE_CELLS[terrain] ?? 1)}
              style={{ imageRendering: 'pixelated' }}
            />
          </pattern>
        ))}
      </defs>
      {terrains.map(({ terrain, d }) => (
        <path key={terrain} data-terrain={terrain} d={d} fill={`url(#${idPrefix}-${terrain})`} />
      ))}
      {banks.map((tile) => (
        <image
          key={`bank-${tile.x},${tile.y}`}
          data-bank-mask={tile.mask}
          href={BANK_TILES[tile.mask]}
          x={tile.x * ROAD_CELL}
          y={tile.y * ROAD_CELL}
          width={ROAD_CELL}
          height={ROAD_CELL}
          style={{ imageRendering: 'pixelated' }}
        />
      ))}
      {shadows.map(({ step, d }) => (
        <path key={step} data-shadow={step} d={d} fill="#1f1a10" fillOpacity={0.22 + step * 0.12} />
      ))}
      {visibleRoads.map((tile) => (
        <image
          key={`${tile.x},${tile.y}`}
          data-road-mask={tile.mask}
          href={
            (WATER_TERRAINS.has(ground.cells[tile.y * ground.columns + tile.x]!) && BRIDGE_TILES[tile.mask]) ||
            ROAD_TILES[tile.mask]
          }
          x={tile.x * ROAD_CELL}
          y={tile.y * ROAD_CELL}
          width={ROAD_CELL}
          height={ROAD_CELL}
          style={{ imageRendering: 'pixelated' }}
        />
      ))}
    </g>
  );
}
