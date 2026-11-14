// 3D 군략도의 지형 자료 (INT-27, D-089). 도트 바탕의 지형 칸(16종)과 실제 높이 자료로 높이와 색을 만든다.
// 높이 자료(heights/*.ts)가 있으면 실제 높이를 쓰고, 없으면 지형 종류로 높이를 정한다(0단계 방식).
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
  // 지형 판의 꼭짓점 i는 지도 x = i × 너비 / (칸 수 - 1)에 있다(PlaneGeometry). 같은 기준으로 읽어야 길·모형이 땅에 묻히지 않는다.
  const fx = Math.min(Math.max((x / canvas.width) * (grid.columns - 1), 0), grid.columns - 1);
  const fy = Math.min(Math.max((y / canvas.height) * (grid.rows - 1), 0), grid.rows - 1);
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
  if (kind === 'PASS') return { side: 6, height: 4 };
  if (kind === 'PORT') return { side: 3.5, height: 1.6 };
  if (kind === 'FIELD') return { side: 3, height: 1 };
  // 경(9)은 특(8)보다 한 칸 더 크다(사용자 2026-11-14: 경은 더 키울 수 있다).
  const step = Math.min(Math.max(level ?? 3, 1), 9);
  return { side: 4 + step * 1, height: 2 + step * 0.4 };
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

// 실제 높이 자료 (tools/map-data/build-height-field.py). 칸마다 1바이트, 0은 해수면 이하,
// 나머지는 round(sqrt(m / maxMetres) * 255)다. 높이 과장 배율은 지도 단위 1당 미터다.
export type HeightData = {
  columns: number;
  rows: number;
  maxMetres: number;
  data: string;
  /** 바다 깊이(칸 두 개마다 1바이트, round(sqrt(깊이 / maxDepth) × 255)). 옛 자료에는 없다. */
  depth?: string;
  depthColumns?: number;
  depthRows?: number;
  maxDepth?: number;
};
// 지도 1단위가 약 3.5km라 실제 비율이면 산이 거의 보이지 않는다. 9km가 60단위(약 1:2.6 과장 기준의 1.5배)가 되게 크게 과장해 산세가 또렷하다.
export const UNITS_PER_METRE = 60 / 9000;

export function decodeMetres(height: HeightData): Float32Array {
  const binary = atob(height.data);
  const metres = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    const value = binary.charCodeAt(i) / 255;
    metres[i] = value * value * height.maxMetres;
  }
  return metres;
}

// 실제 높이로 칸 높이를 만든다. 물 칸(지형 종류)은 바다 깊이만큼 물높이 아래로, 땅 칸은 물높이 위로 둔다.
// 한 번 평균을 내 모서리를 다듬고, 바닷가는 땅·물 표시를 넓게 흐려 그 0 높이 선을 해안선으로 쓴다.
// 도트 지도의 계단 해안이 둥근 해안선이 된다(물 띠·거점은 groundAt으로 물높이 위에 남는다).
export function heightFieldFromMetres(
  grid: TerrainCells,
  metres: Float32Array,
  depth: Float32Array | null = null,
): Float32Array {
  const { cells, columns, rows } = grid;
  const raw = new Float32Array(columns * rows);
  for (let i = 0; i < raw.length; i++)
    raw[i] = isOpenWater(cells[i]!)
      ? WATER_LEVEL - 0.6 - Math.min(depth?.[i] ?? 0, 3000) * UNITS_PER_METRE * 0.4
      : Math.max(metres[i]! * UNITS_PER_METRE, WATER_LEVEL + 0.25);
  const field = boxBlur(raw, columns, rows, 1);
  let side: Float32Array = new Float32Array(raw.length);
  for (let i = 0; i < side.length; i++) side[i] = isOpenWater(cells[i]!) ? -1 : 1;
  side = boxBlur(side, columns, rows, 2);
  for (let i = 0; i < field.length; i++) {
    const s = side[i]!;
    const coast = Math.abs(s);
    if (coast >= 1) continue;
    // 해안 근처: 흐린 땅·물 표시(s)가 0인 곳이 물높이가 되게 하고, 바닷가에서 멀어질수록 원래 높이로 돌아간다.
    const near = s * 0.7;
    const far = isOpenWater(cells[i]!)
      ? Math.min(field[i]!, WATER_LEVEL - 0.05)
      : Math.max(field[i]!, WATER_LEVEL + 0.05);
    const blended = near * (1 - coast) + far * coast;
    // 땅 쪽(s > 0)은 물높이 위, 물 쪽은 아래에 묶어 0 높이 선이 s = 0과 겹치게 한다.
    field[i] = s > 0 ? Math.max(blended, WATER_LEVEL + 0.02 * s) : Math.min(blended, WATER_LEVEL + 0.07 * s);
  }
  return field;
}

// 3×3 평균을 passes번. 판 밖은 세지 않는다.
export function boxBlur(source: Float32Array, columns: number, rows: number, passes: number): Float32Array {
  let field: Float32Array = source;
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
        next[y * columns + x] = sum / count;
      }
    field = next;
  }
  return field;
}

// 바다 깊이(m)를 지도 칸 해상도로. 깊이 자료는 칸 두 개마다 하나라 쌍선형으로 늘린다. 자료가 없으면 null.
export function decodeDepth(height: HeightData, columns: number, rows: number): Float32Array | null {
  if (!height.depth || !height.depthColumns || !height.depthRows || !height.maxDepth) return null;
  const binary = atob(height.depth);
  const dc = height.depthColumns;
  const dr = height.depthRows;
  const at = (x: number, y: number) => {
    const value = binary.charCodeAt(Math.min(y, dr - 1) * dc + Math.min(x, dc - 1)) / 255;
    return value * value * height.maxDepth!;
  };
  const stepX = columns / dc;
  const stepY = rows / dr;
  const out = new Float32Array(columns * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const fx = Math.max((x + 0.5) / stepX - 0.5, 0);
      const fy = Math.max((y + 0.5) / stepY - 0.5, 0);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      out[y * columns + x] =
        (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
        (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
    }
  return out;
}

// 바다·호수처럼 물높이 아래로 내리는 칸. 강은 땅 높이를 따르고 색으로만 그린다(칸 모양 도랑이 생기지 않게).
const OPEN_WATER = new Set<Terrain>(['deepSea', 'sea', 'shallow', 'lake']);
export function isOpenWater(index: number) {
  const terrain = TERRAINS[index];
  return terrain !== undefined && OPEN_WATER.has(terrain);
}

const mix = (a: readonly number[], b: readonly number[], t: number) =>
  [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as [number, number, number];
const ROCK = [0.46, 0.42, 0.36] as const;
const SNOW = [0.94, 0.94, 0.92] as const;
const SHORE = [0.84, 0.78, 0.6] as const;

// 높이별 땅 색(낮은 평야 → 구릉 → 산 → 고원). 지형 종류 색과 반씩 섞어 칸 경계가 덜 보이게 한다.
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [0.56, 0.66, 0.38]],
  [300, [0.6, 0.66, 0.4]],
  [900, [0.58, 0.58, 0.38]],
  [1800, [0.55, 0.49, 0.36]],
  [3200, [0.5, 0.44, 0.36]],
  [4600, [0.62, 0.58, 0.52]],
];
function ramp(metres: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    const [top, color] = RAMP[i]!;
    if (metres <= top) {
      const [bottom, from] = RAMP[i - 1]!;
      return mix(from, color, (metres - bottom) / (top - bottom));
    }
  }
  return RAMP[RAMP.length - 1]![1];
}

// 실제 게임처럼 보이는 지형 색. 지형 종류 색과 높이별 색을 섞고, 경사가 가파르면 바위색, 높으면 눈,
// 바닷가는 모래색을 섞는다. 마지막에 땅 칸끼리 두 번 평균을 내 도트 경계를 풀어 준다.
export function realisticColors(
  grid: TerrainCells,
  palette: Record<Terrain, string>,
  field: Float32Array,
  metres: Float32Array | null,
): Float32Array {
  const { cells, columns, rows } = grid;
  const rgb = TERRAINS.map((terrain) => {
    const hex = palette[terrain].replace('#', '');
    return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  });
  let colors = new Float32Array(columns * rows * 3);
  const at = (x: number, y: number) =>
    field[Math.min(Math.max(y, 0), rows - 1) * columns + Math.min(Math.max(x, 0), columns - 1)]!;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      let color: [number, number, number] = rgb[cells[i]!] ?? [0.5, 0.5, 0.5];
      if (!isOpenWater(cells[i]!)) {
        const height = metres ? metres[i]! : field[i]! / UNITS_PER_METRE;
        if (!isWater(cells[i]!)) color = mix(color, ramp(height), metres ? 0.55 : 0.2);
        // 강 칸은 땅색으로 칠한다. 강은 물 띠로 따로 그리므로 칸을 파랗게 칠하면 강가 평야에 파란 얼룩이 남는다.
        else if (TERRAINS[cells[i]!] === 'river')
          color = mix(rgb[TERRAINS.indexOf('plains')] ?? color, ramp(height), 0.55);
        const slope = Math.hypot(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1)) / 2;
        color = mix(color, ROCK, Math.min(Math.max((slope - 0.8) / 3, 0), 0.7));
        color = mix(color, SNOW, Math.min(Math.max((height - 4800) / 1200, 0), 0.9));
        let shore = false;
        for (let dy = -1; dy <= 1 && !shore; dy++)
          for (let dx = -1; dx <= 1 && !shore; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < columns && ny < rows && isOpenWater(cells[ny * columns + nx]!)) shore = true;
          }
        if (shore && height < 120) color = mix(color, SHORE, 0.45);
      }
      colors[i * 3] = color[0];
      colors[i * 3 + 1] = color[1];
      colors[i * 3 + 2] = color[2];
    }
  // 땅 칸끼리만 평균을 낸다(물·땅 경계는 또렷하게 둔다).
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(colors);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        const i = y * columns + x;
        const open = isOpenWater(cells[i]!);
        const sum = [0, 0, 0];
        let count = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
            const j = ny * columns + nx;
            if (isOpenWater(cells[j]!) !== open) continue;
            sum[0]! += colors[j * 3]!;
            sum[1]! += colors[j * 3 + 1]!;
            sum[2]! += colors[j * 3 + 2]!;
            count++;
          }
        next[i * 3] = sum[0]! / count;
        next[i * 3 + 1] = sum[1]! / count;
        next[i * 3 + 2] = sum[2]! / count;
      }
    colors = next;
  }
  return colors;
}

// 칸 번호로 정하는 0~1 난수(같은 지도면 늘 같다). 나무 자리처럼 고정된 흩뿌림에 쓴다.
export function cellNoise(index: number, salt = 0) {
  let h = (index * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const FOREST_DENSITY: Partial<Record<Terrain, number>> = { forest: 0.9, hills: 0.35, grassland: 0.08, mountains: 0.25 };

// 숲 칸에 나무 자리를 흩뿌린다. 칸 하나에 많아야 두 그루, 높은 산(4000m 위)에는 심지 않는다.
export function treeSpots(
  grid: TerrainCells,
  canvas: { width: number; height: number },
  metres: Float32Array | null,
  limit = 14000,
): Array<{ x: number; y: number; scale: number }> {
  const spots: Array<{ x: number; y: number; scale: number }> = [];
  const cellW = canvas.width / grid.columns;
  const cellH = canvas.height / grid.rows;
  for (let i = 0; i < grid.cells.length && spots.length < limit; i++) {
    const terrain = TERRAINS[grid.cells[i]!];
    const density = terrain ? (FOREST_DENSITY[terrain] ?? 0) : 0;
    if (!density || (metres && metres[i]! > 4000)) continue;
    for (let n = 0; n < 2; n++) {
      if (cellNoise(i, n) > density) continue;
      const column = i % grid.columns;
      const row = Math.floor(i / grid.columns);
      spots.push({
        x: (column + cellNoise(i, n + 10)) * cellW,
        y: (row + cellNoise(i, n + 20)) * cellH,
        scale: 1.1 + cellNoise(i, n + 30) * 0.8,
      });
    }
  }
  return spots;
}
