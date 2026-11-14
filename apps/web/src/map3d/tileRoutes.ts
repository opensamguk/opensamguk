// 칸 길 (INT-27, 사용자 2026-11-14: 길은 타일대로, 8방향). 거점 사이 길을 영지 칸 위 칸 경로로 바꾼다.
// 육로·수로·해로가 같은 8방향 칸 경로 찾기를 쓰고 지나갈 수 있는 칸과 비용만 다르다.
// 순수 계산만 둔다. 서버도 같은 함수를 써서 월드마다 저장할 수 있게 지도·그리기와 떨어져 있다.

/** 8방향: 칸 좌표(u, v)에서 0 +u, 1 +u+v, 2 +v, 3 -u+v, 4 -u, 5 -u-v, 6 -v, 7 +u-v. 반대 방향은 (k + 4) % 8. */
export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** 칸 성질. 비용 계산에 쓴다. */
export type TileTerrain = 'plain' | 'rough' | 'mountain' | 'peak' | 'river' | 'lake' | 'sea' | 'void';
export type RouteMode = 'LAND' | 'BRIDGE' | 'FORD' | 'RIVER' | 'SEA';

const LAND_COST: Record<TileTerrain, number> = {
  plain: 1,
  rough: 2,
  mountain: 4,
  peak: 8,
  river: 3,
  lake: Infinity,
  sea: Infinity,
  void: Infinity,
};
const RIVER_COST: Record<TileTerrain, number> = {
  river: 1,
  lake: 1.2,
  sea: 3,
  plain: Infinity,
  rough: Infinity,
  mountain: Infinity,
  peak: Infinity,
  void: Infinity,
};
const SEA_COST: Record<TileTerrain, number> = {
  sea: 1,
  lake: 1,
  river: 2,
  plain: Infinity,
  rough: Infinity,
  mountain: Infinity,
  peak: Infinity,
  void: Infinity,
};

/** 길 종류별 칸 비용(Infinity는 못 지남). 육로는 다리·나루 길만 강을 건너기 쉽다. */
export function tileCost(mode: RouteMode, terrain: TileTerrain): number {
  if (mode === 'RIVER') return RIVER_COST[terrain];
  if (mode === 'SEA') return SEA_COST[terrain];
  if (terrain === 'river' && (mode === 'BRIDGE' || mode === 'FORD')) return 1.5;
  return LAND_COST[terrain];
}

export const FLAG_MAJOR = 1;
export const FLAG_BRIDGE = 2;
export const FLAG_FORD = 4;
export const FLAG_SITE = 8;

export type TileRoutePlan = {
  /** 칸마다 육로가 이어진 방향 비트(8개). */
  land: Uint8Array;
  /** 칸마다 수로·해로가 이어진 방향 비트(8개). */
  water: Uint8Array;
  /** 칸마다 표시: 1 큰길(길 셋 이상이 지남), 2 다리, 4 나루, 8 거점 칸(길을 그리지 않음). */
  flags: Uint8Array;
  /** 길 id → 지나는 칸 번호(출발 칸부터). 칸 경로를 못 찾은 길은 없다. */
  paths: Map<string, number[]>;
};

type Route = { id: string; mode: RouteMode; from: number; to: number };

/**
 * 칸 경로 찾기(A*, 8방향). 이미 같은 갈래(육로/물길) 길이 난 칸은 비용을 절반으로 쳐서 길이 큰길로 모인다.
 * 대각선으로 갈 때는 옆 두 칸 가운데 하나는 지날 수 있어야 한다(물 사이 모서리로 빠져나가지 않게).
 * 출발·도착 칸은 성질과 상관없이 들어간다(바닷가 성, 강가 항구).
 */
export function planTileRoutes(
  columns: number,
  rows: number,
  terrainAt: (index: number) => TileTerrain,
  routes: readonly Route[],
  siteTiles: Iterable<number> = [],
): TileRoutePlan {
  const size = columns * rows;
  const land = new Uint8Array(size);
  const water = new Uint8Array(size);
  const flags = new Uint8Array(size);
  const uses = new Uint8Array(size);
  const paths = new Map<string, number[]>();
  const terrain = new Array<TileTerrain>(size);
  for (let i = 0; i < size; i++) terrain[i] = terrainAt(i);
  for (const index of siteTiles) if (index >= 0 && index < size) flags[index]! |= FLAG_SITE;

  const ordered = [...routes].sort((a, b) =>
    a.mode === b.mode ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.mode < b.mode ? -1 : 1,
  );
  const cost = new Float64Array(size);
  const came = new Int32Array(size);
  for (const route of ordered) {
    if (route.from < 0 || route.to < 0 || route.from >= size || route.to >= size) continue;
    const isWater = route.mode === 'RIVER' || route.mode === 'SEA';
    const bits = isWater ? water : land;
    const step = (index: number) => {
      if (index === route.from || index === route.to) return 1;
      const base = tileCost(route.mode, terrain[index]!);
      return bits[index] ? base * 0.5 : base;
    };
    const passable = (index: number) => index === route.from || index === route.to || Number.isFinite(step(index));
    cost.fill(Infinity);
    came.fill(-1);
    const goalU = route.to % columns;
    const goalV = Math.floor(route.to / columns);
    const heuristic = (index: number) => {
      const du = Math.abs((index % columns) - goalU);
      const dv = Math.abs(Math.floor(index / columns) - goalV);
      return (Math.max(du, dv) + (Math.SQRT2 - 1) * Math.min(du, dv)) * 0.5;
    };
    const heap: Array<[number, number]> = [];
    const push = (item: [number, number]) => {
      heap.push(item);
      for (let i = heap.length - 1; i > 0;) {
        const parent = (i - 1) >> 1;
        if (heap[parent]![0] <= heap[i]![0]) break;
        [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
        i = parent;
      }
    };
    const pop = () => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i]!, heap[m]!];
          i = m;
        }
      }
      return top;
    };
    cost[route.from] = 0;
    push([heuristic(route.from), route.from]);
    let found = false;
    while (heap.length) {
      const [, index] = pop();
      if (index === route.to) {
        found = true;
        break;
      }
      const u = index % columns;
      const v = (index - u) / columns;
      for (let k = 0; k < 8; k++) {
        const [du, dv] = DIRECTIONS[k]!;
        const nu = u + du;
        const nv = v + dv;
        if (nu < 0 || nv < 0 || nu >= columns || nv >= rows) continue;
        const next = nv * columns + nu;
        if (!passable(next)) continue;
        if (du !== 0 && dv !== 0 && !passable(v * columns + nu) && !passable(nv * columns + u)) continue;
        const length = du !== 0 && dv !== 0 ? Math.SQRT2 : 1;
        const total = cost[index]! + step(next) * length;
        if (total < cost[next]!) {
          cost[next] = total;
          came[next] = index;
          push([total + heuristic(next), next]);
        }
      }
    }
    if (!found) continue;
    const path: number[] = [];
    for (let at = route.to; at !== -1; at = came[at]!) path.unshift(at);
    paths.set(route.id, path);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const du = (b % columns) - (a % columns);
      const dv = Math.floor(b / columns) - Math.floor(a / columns);
      const k = DIRECTIONS.findIndex(([x, y]) => x === du && y === dv);
      bits[a]! |= 1 << k;
      bits[b]! |= 1 << ((k + 4) % 8);
    }
    for (const index of path) {
      if (isWater) continue;
      uses[index] = Math.min(255, uses[index]! + 1);
      if (uses[index]! >= 3) flags[index]! |= FLAG_MAJOR;
      if (terrain[index] === 'river') flags[index]! |= route.mode === 'FORD' ? FLAG_FORD : FLAG_BRIDGE;
    }
  }
  return { land, water, flags, paths };
}
