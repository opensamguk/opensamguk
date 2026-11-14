// 3D 군략도의 지형 자료 (INT-27 0단계, D-089). 도트 바탕의 지형 칸(16종)에서 높이와 색을 만든다.
// 0단계는 DEM 없이 지형 종류로 높이를 정한다. 1단계에서 ETOPO 2022 높이 자료로 바꾼다(INT-27 설계).
import { TERRAINS, type Terrain } from '../main/terrainTiles';

export type TerrainCells = { cells: Int8Array; columns: number; rows: number };

// 지형 종류별 기본 높이(지도 단위). 산맥이 읽히도록 실제 비율보다 과장했다.
export const TERRAIN_HEIGHT: Record<Terrain, number> = {
  deepSea: -3,
  sea: -2,
  shallow: -0.8,
  lake: -0.6,
  river: -0.4,
  coastSand: 0.3,
  plains: 0.6,
  farmland: 0.6,
  grassland: 0.9,
  desert: 1,
  loess: 1.6,
  forest: 1.4,
  hills: 3.5,
  mountains: 8,
  highMountains: 13,
  snow: 15,
};

export const WATER_LEVEL = 0;

const heightOf = (index: number) => {
  const terrain = TERRAINS[index];
  return terrain === undefined ? 0 : TERRAIN_HEIGHT[terrain];
};

// 칸마다 높이를 정하고 이웃 칸과 평균을 내 계단을 없앤다. 물 칸은 평균에 끌려 올라가지 않게 물높이 아래로 묶는다.
export function heightField(grid: TerrainCells, passes = 2): Float32Array {
  const { cells, columns, rows } = grid;
  let field = new Float32Array(columns * rows);
  for (let i = 0; i < field.length; i++) field[i] = heightOf(cells[i]!);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(field.length);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
            sum += field[ny * columns + nx]!;
            count++;
          }
        const index = y * columns + x;
        const water = isWater(cells[index]!);
        next[index] = water ? Math.min(sum / count, WATER_LEVEL - 0.2) : Math.max(sum / count, WATER_LEVEL + 0.1);
      }
    field = next;
  }
  return field;
}

const WATER = new Set<Terrain>(['deepSea', 'sea', 'shallow', 'lake', 'river']);
export function isWater(index: number) {
  const terrain = TERRAINS[index];
  return terrain !== undefined && WATER.has(terrain);
}

// 지도 좌표(x, y)의 땅 높이. 칸 사이는 쌍선형으로 잇는다. 거점·길을 땅 위에 올릴 때 쓴다.
export function groundAt(
  field: Float32Array,
  grid: TerrainCells,
  canvas: { width: number; height: number },
  x: number,
  y: number,
) {
  const fx = Math.min(Math.max((x / canvas.width) * grid.columns - 0.5, 0), grid.columns - 1);
  const fy = Math.min(Math.max((y / canvas.height) * grid.rows - 0.5, 0), grid.rows - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, grid.columns - 1);
  const y1 = Math.min(y0 + 1, grid.rows - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (cx: number, cy: number) => field[cy * grid.columns + cx]!;
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return Math.max(top * (1 - ty) + bottom * ty, WATER_LEVEL);
}

// 칸 색(지형 색 판)을 0~1 RGB로. 높은 곳은 조금 밝게 해 능선이 보이게 한다.
export function cellColors(grid: TerrainCells, palette: Record<Terrain, string>, field: Float32Array): Float32Array {
  const rgb = TERRAINS.map((terrain) => {
    const hex = palette[terrain].replace('#', '');
    return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  });
  const colors = new Float32Array(grid.columns * grid.rows * 3);
  for (let i = 0; i < grid.cells.length; i++) {
    const base = rgb[grid.cells[i]!] ?? [0.5, 0.5, 0.5];
    const lift = Math.min(Math.max(field[i]! / 40, 0), 0.15);
    colors[i * 3] = Math.min(base[0] + lift, 1);
    colors[i * 3 + 1] = Math.min(base[1] + lift, 1);
    colors[i * 3 + 2] = Math.min(base[2] + lift, 1);
  }
  return colors;
}

// 거점 모형 크기. 도시 규모(1 작음 ~ 8 특)에 따라 성벽 한 변과 높이를 키운다. 관문·항구·전장은 고정 크기다.
export function siteSize(kind: 'CITY' | 'PASS' | 'PORT' | 'FIELD', level: number | undefined) {
  if (kind === 'PASS') return { side: 8, height: 5 };
  if (kind === 'PORT') return { side: 4.5, height: 2 };
  if (kind === 'FIELD') return { side: 3.5, height: 1 };
  const step = Math.min(Math.max(level ?? 3, 1), 8);
  return { side: 6 + step * 1.6, height: 2.5 + step * 0.5 };
}

export type LabelBox = { id: string; x: number; y: number; width: number; height: number; priority: number };

// 이름판 겹침 정리. 중요한 것(고른 거점, 내 도시, 큰 도시)부터 자리를 잡고 이미 잡힌 자리와 겹치면 작은 점으로 줄인다.
// 줄인 거점도 단추는 남아 키보드·화면 낭독으로 고를 수 있다. 돌려주는 것은 줄일 거점 id다.
export function compactLabels(boxes: readonly LabelBox[]): Set<string> {
  const placed: LabelBox[] = [];
  const compact = new Set<string>();
  for (const box of [...boxes].sort((a, b) => b.priority - a.priority)) {
    const hit = placed.some(
      (other) =>
        Math.abs(box.x - other.x) * 2 < box.width + other.width &&
        Math.abs(box.y - other.y) * 2 < box.height + other.height,
    );
    if (hit) compact.add(box.id);
    else placed.push(box);
  }
  return compact;
}
