export type TerritorySeed = { key: number; x: number; y: number; level: number };
export type TerritoryOwnership = {
  originX: number;
  originY: number;
  columns: number;
  rows: number;
  owner: Int32Array;
};

/** 지도 좌표 → 돌린 칸 좌표(칸 단위). 지도 가운데가 원점이다. 셰이더와 같은 식이다. */
export function toTile(x: number, y: number, canvas: { width: number; height: number }, tile: number) {
  const wx = x - canvas.width / 2;
  const wz = y - canvas.height / 2;
  return { u: ((wx + wz) * Math.SQRT1_2) / tile, v: ((wz - wx) * Math.SQRT1_2) / tile };
}

/** 돌린 칸 좌표(칸 단위) → 지도 좌표. */
export function fromTile(u: number, v: number, canvas: { width: number; height: number }, tile: number) {
  const qu = u * tile;
  const qv = v * tile;
  return { x: (qu - qv) * Math.SQRT1_2 + canvas.width / 2, y: (qu + qv) * Math.SQRT1_2 + canvas.height / 2 };
}

/** 무대 너비: 가장 가까운 거점에서 땅길로 이 칸 수(약 340km)보다 멀면 오지다. */
export const STAGE = 12;

// 단계 코드 0~4는 크기가 아니라 원작의 거점 종류다(0 무, 1 수, 2 진, 3 관, 4 이). 5~9가 크기(소·중·대·특·경)다.
// 영지 넓이는 종류를 크기 순위로 바꿔 정한다(D-092). 이민족 본거(이)는 초원·산지를 다스리므로 대만큼 넓다.
const REACH_RANK = [1, 1.5, 2, 2, 7, 5, 6, 7, 8, 9] as const;

/** 도시 단계별로 영지가 닿는 거리(칸 수). 진 약 3.1칸, 소 약 4.5칸, 이·대 약 5.4칸, 경 약 6.3칸. */
export function reachOf(level: number) {
  const rank = REACH_RANK[Math.min(Math.max(Math.round(level), 0), 9)] ?? 5;
  return 2.2 + rank * 0.45;
}

export function assignTerritory(
  sites: readonly TerritorySeed[],
  canvas: { width: number; height: number },
  tile: number,
  isLand: (x: number, y: number) => boolean,
  /** 호수 칸. 호수는 둘레 성의 영지로 친다(사용자 결정 2026-11-14). 바다는 주인이 없다. */
  isLake: (x: number, y: number) => boolean = () => false,
): TerritoryOwnership {
  const corners = [
    toTile(0, 0, canvas, tile),
    toTile(canvas.width, 0, canvas, tile),
    toTile(0, canvas.height, canvas, tile),
    toTile(canvas.width, canvas.height, canvas, tile),
  ];
  const originX = Math.floor(Math.min(...corners.map((c) => c.u)));
  const originY = Math.floor(Math.min(...corners.map((c) => c.v)));
  const columns = Math.ceil(Math.max(...corners.map((c) => c.u))) - originX;
  const rows = Math.ceil(Math.max(...corners.map((c) => c.v))) - originY;
  const owner = new Int32Array(columns * rows).fill(-1);
  const placed = sites.map((site) => ({
    site,
    at: toTile(site.x, site.y, canvas, tile),
    reach: reachOf(site.level),
  }));
  // 땅 칸 표시. 지도 판 밖과 물 칸은 땅이 아니다.
  const land = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const centre = fromTile(originX + column + 0.5, originY + row + 0.5, canvas, tile);
      if (centre.x < 0 || centre.y < 0 || centre.x > canvas.width || centre.y > canvas.height) continue;
      if (isLand(centre.x, centre.y) || isLake(centre.x, centre.y)) land[row * columns + column] = 1;
    }
  const assign = (index: number, entry: (typeof placed)[number]) => {
    owner[index] = entry.site.key;
  };
  // 땅으로 이어진 거리로 영지를 나눈다(여러 출발점 다익스트라). 바다 건너 땅은 붙지 않는다(요동반도가 북평에 붙던 문제).
  // 비용은 걸은 칸 수 ÷ 그 성의 닿는 거리라서 큰 성일수록 멀리까지 영지가 퍼진다.
  const bestCost = new Float64Array(land.length).fill(Infinity);
  const walked = new Float64Array(land.length);
  const heap: Array<[distance: number, index: number]> = [];
  const push = (item: [distance: number, index: number]) => {
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
  const startByCity = placed.map(({ at }) => {
    const column = Math.floor(at.u) - originX;
    const row = Math.floor(at.v) - originY;
    if (column < 0 || row < 0 || column >= columns || row >= rows) return -1;
    // 바닷가 성은 성 칸이 물로 잡힐 수 있어 성 칸은 땅으로 친다.
    const index = row * columns + column;
    land[index] = 1;
    return index;
  });
  const starts = new Set(startByCity);
  const steps: Array<[number, number, number]> = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  // 먼저 도시마다 12칸 안을 탐색해야 큰 도시가 작은 도시의 도달 경로를 막지 않는다.
  placed.forEach((entry, which) => {
    const start = startByCity[which]!;
    if (start === -1) return;
    walked.fill(Infinity);
    walked[start] = 0;
    push([0, start]);
    while (heap.length) {
      const [distance, index] = pop();
      if (distance > walked[index]!) continue;
      const score = distance / entry.reach;
      if (score < bestCost[index]!) {
        bestCost[index] = score;
        assign(index, entry);
      }
      const column = index % columns;
      const row = (index - column) / columns;
      for (const [dx, dy, length] of steps) {
        const nx = column + dx;
        const ny = row + dy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const next = ny * columns + nx;
        const nextDistance = distance + length;
        if (!land[next] || nextDistance > STAGE || nextDistance >= walked[next]!) continue;
        walked[next] = nextDistance;
        push([nextDistance, next]);
      }
    }
  });
  // 성이 없는 섬(거점과 땅으로 이어지지 않은 덩어리)만 곧은 거리로 가장 가까운 성에 준다(STAGE칸 안일 때).
  // 거점과 이어진 땅인데 STAGE칸보다 먼 칸은 무대 밖 오지로 남긴다. 바다 건너 성에 붙이지 않는다.
  const part = new Int32Array(land.length).fill(-1);
  const seeded = new Set<number>();
  for (let start = 0, label = 0; start < land.length; start++) {
    if (!land[start] || part[start] !== -1) continue;
    const stack = [start];
    part[start] = label;
    while (stack.length) {
      const index = stack.pop()!;
      if (starts.has(index)) seeded.add(label);
      const column = index % columns;
      const row = (index - column) / columns;
      for (const [dx, dy] of steps) {
        const nx = column + dx;
        const ny = row + dy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const next = ny * columns + nx;
        if (land[next] && part[next] === -1) {
          part[next] = label;
          stack.push(next);
        }
      }
    }
    label++;
  }
  for (let index = 0; index < land.length; index++) {
    if (!land[index] || seeded.has(part[index]!)) continue;
    const u = originX + (index % columns) + 0.5;
    const v = originY + Math.floor(index / columns) + 0.5;
    let best: (typeof placed)[number] | null = null;
    let bestScore = Infinity;
    for (const entry of placed) {
      const distance = Math.hypot(entry.at.u - u, entry.at.v - v);
      if (distance > STAGE) continue;
      const score = distance / entry.reach;
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (best) assign(index, best);
  }
  return { originX, originY, columns, rows, owner };
}
