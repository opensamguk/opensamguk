// 3D 군략도의 영지 칸 (INT-27, INT-28 초안). 지도를 45° 돌린 정사각 칸으로 나누고 칸마다 주인 도시를 정한다.
// 서버 영지 규칙(INT-28)이 오기 전까지는 화면 쪽 임시 규칙이다. 땅 칸을 땅길로 가장 가까운 도시에 준다.
// 도시 규모가 클수록 더 가깝게 쳐서 영지가 넓다(성마다 영지 크기가 다르다). 도시 사이에는 빈 칸을 남기지 않는다.
// 게임 무대 안의 땅은 빈 칸 없이 어느 도시의 영지다. 무대 밖(모든 거점에서 땅길로 STAGE칸보다 먼 판 가장자리)만
// 오지로 남긴다(사용자 결정 2026-11-14: 지도 바깥은 오지로). 흉노 초원·반도 끝처럼 거점 가까운 땅은 영지다.

export type TerritorySite = { key: number; x: number; y: number; level: number; color: string | null };

export type TerritoryTiles = {
  /** 칸 좌표의 시작(돌린 좌표 기준 칸 번호). */
  originX: number;
  originY: number;
  columns: number;
  rows: number;
  /** 칸마다 RGBA. RGB는 소유국 색(없으면 0), A는 도시 번호(1~255, 주인 없으면 0). 오지(주인 없는 땅·강·호수)는 B=1. */
  data: Uint8Array;
  /** 칸마다 주인 도시 key(없으면 -1). 화면 밖 계산·시험용. */
  owner: Int32Array;
};

/** 지도 좌표 → 돌린 칸 좌표(칸 단위). 지도 가운데가 원점이다. 셰이더와 같은 식이다. */
export function toTile(x: number, y: number, canvas: { width: number; height: number }, tile: number) {
  const wx = x - canvas.width / 2;
  const wz = y - canvas.height / 2;
  // 2:1 마름모 칸(INT-27 2D 그림 지도, 사용자 참고 그림의 격자 각도 ±26.6°): 가로 대각선 2T, 세로 대각선 T.
  // 넓이는 예전 45° 정사각 칸과 같은 T²이다.
  return { u: wx / (2 * tile) + wz / tile, v: wz / tile - wx / (2 * tile) };
}

/** 돌린 칸 좌표(칸 단위) → 지도 좌표. */
export function fromTile(u: number, v: number, canvas: { width: number; height: number }, tile: number) {
  const qu = u * tile;
  const qv = v * tile;
  return { x: qu - qv + canvas.width / 2, y: (qu + qv) / 2 + canvas.height / 2 };
}

/** 지도 판을 덮는 돌린 칸 격자의 시작 칸과 크기. 영지 칸·칸 길이 같은 격자를 쓴다. */
export function tileBounds(canvas: { width: number; height: number }, tile: number) {
  const corners = [
    toTile(0, 0, canvas, tile),
    toTile(canvas.width, 0, canvas, tile),
    toTile(0, canvas.height, canvas, tile),
    toTile(canvas.width, canvas.height, canvas, tile),
  ];
  const originX = Math.floor(Math.min(...corners.map((c) => c.u)));
  const originY = Math.floor(Math.min(...corners.map((c) => c.v)));
  return {
    originX,
    originY,
    columns: Math.ceil(Math.max(...corners.map((c) => c.u))) - originX,
    rows: Math.ceil(Math.max(...corners.map((c) => c.v))) - originY,
  };
}

/** 무대 너비: 가장 가까운 거점에서 땅길로 이 칸 수(약 340km)보다 멀면 오지다. */
export const STAGE = 12;

// 단계 코드 0~4는 크기가 아니라 원작의 거점 종류다(0 무, 1 수, 2 현(원작 진), 3 관, 4 이). 5~9가 크기(소·중·대·특·경)다.
// 영지 넓이는 종류를 크기 순위로 바꿔 정한다(D-092). 이민족 본거(이)는 초원·산지를 다스리므로 대만큼 넓다.
const REACH_RANK = [1, 1.5, 2, 2, 7, 5, 6, 7, 8, 9] as const;

/** 도시 단계별로 영지가 닿는 거리(칸 수). 진 약 3.1칸, 소 약 4.5칸, 이·대 약 5.4칸, 경 약 6.3칸. */
export function reachOf(level: number) {
  const rank = REACH_RANK[Math.min(Math.max(Math.round(level), 0), 9)] ?? 5;
  return 2.2 + rank * 0.45;
}

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
  /** 호수·강 칸. 둘레 성의 영지로 친다(사용자 결정 2026-11-14 호수, 강도 같다: 강이 영지를 끊어 빈 곳이 생겼다). 바다는 주인이 없다. */
  isLake: (x: number, y: number) => boolean = () => false,
): TerritoryTiles {
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
  const data = new Uint8Array(columns * rows * 4);
  const owner = new Int32Array(columns * rows).fill(-1);
  const placed = sites.map((site, index) => ({
    site,
    id: (index % 255) + 1,
    at: toTile(site.x, site.y, canvas, tile),
    reach: reachOf(site.level),
    rgb: hex(site.color),
  }));
  // 땅 칸 표시. 지도 판 밖과 물 칸은 땅이 아니다.
  const land = new Uint8Array(columns * rows);
  /** 영지에 드는 물 칸(호수·강). */
  const wet = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const centre = fromTile(originX + column + 0.5, originY + row + 0.5, canvas, tile);
      if (centre.x < 0 || centre.y < 0 || centre.x > canvas.width || centre.y > canvas.height) continue;
      // 칸 가운데와 네 쪽 가운데 중 한 곳이라도 땅이면 땅 칸이다. 가운데만 보면 바다에 걸친 해안 칸이 오지로
      // 칠해졌다(사용자 2026-11-14: "바다랑 접해있는 영토가 오지가 되어버리는데").
      const dry = [
        [0.5, 0.5],
        [0.2, 0.5],
        [0.8, 0.5],
        [0.5, 0.2],
        [0.5, 0.8],
      ].some(([du, dv]) => {
        const point = fromTile(originX + column + du!, originY + row + dv!, canvas, tile);
        return isLand(point.x, point.y);
      });
      if (dry || isLake(centre.x, centre.y)) land[row * columns + column] = 1;
      if (!dry && land[row * columns + column]) wet[row * columns + column] = 1;
    }
  const assign = (index: number, entry: (typeof placed)[number]) => {
    owner[index] = entry.site.key;
    data.set([...entry.rgb, entry.id], index * 4);
  };
  // 땅으로 이어진 거리로 영지를 나눈다(여러 출발점 다익스트라). 바다 건너 땅은 붙지 않는다(요동반도가 북평에 붙던 문제).
  // 비용은 걸은 칸 수 ÷ 그 성의 닿는 거리라서 큰 성일수록 멀리까지 영지가 퍼진다.
  const cost = new Float64Array(columns * rows).fill(Infinity);
  const from = new Int32Array(columns * rows).fill(-1);
  const heap: Array<[number, number, number, number]> = [];
  const push = (item: [number, number, number, number]) => {
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
  const seeds: Array<[number, number]> = [];
  placed.forEach((entry, which) => {
    const column = Math.floor(entry.at.u) - originX;
    const row = Math.floor(entry.at.v) - originY;
    if (column < 0 || row < 0 || column >= columns || row >= rows) return;
    // 바닷가 성은 성 칸이 물로 잡힐 수 있어 성 칸은 땅으로 친다.
    const index = row * columns + column;
    land[index] = 1;
    seeds.push([index, which]);
  });
  // 2:1 마름모 칸의 이웃까지 실제 거리(칸 한 변 T 단위): 변 이웃 √5/2, 세로 이웃(u·v 같이) 1, 가로 이웃(u·v 반대) 2.
  const side = Math.sqrt(5) / 2;
  const steps: Array<[number, number, number]> = [
    [1, 0, side],
    [-1, 0, side],
    [0, 1, side],
    [0, -1, side],
    [1, 1, 1],
    [1, -1, 2],
    [-1, 1, 2],
    [-1, -1, 1],
  ];
  // 1단계 무대: 어느 거점에서든 땅길 STAGE칸 안인 칸. 상한을 영지를 차지한 성에서 걸은 거리로 세면, 큰 성 영지가
  // 상한에 걸린 너머 칸에 가까운 작은 성도 닿지 못해 주인 없는 구멍이 생겼다(거점 322곳 지도에서 212칸).
  const near = new Float64Array(columns * rows).fill(Infinity);
  for (const [index] of seeds) {
    near[index] = 0;
    push([0, index, -1, 0]);
  }
  while (heap.length) {
    const [walked, index] = pop();
    if (walked > near[index]!) continue;
    const column = index % columns;
    const row = (index - column) / columns;
    for (const [dx, dy, length] of steps) {
      const nx = column + dx;
      const ny = row + dy;
      if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
      const next = ny * columns + nx;
      if (!land[next] || walked + length > STAGE || walked + length >= near[next]!) continue;
      near[next] = walked + length;
      push([walked + length, next, -1, 0]);
    }
  }
  // 2단계 영지: 무대 칸 안에서 걸은 칸 수 ÷ 닿는 거리가 가장 작은 성이 주인이다(상한 없음).
  for (const [index, which] of seeds) {
    cost[index] = 0;
    push([0, index, which, 0]);
  }
  while (heap.length) {
    const [score, index, which, walked] = pop();
    if (from[index] !== -1) continue;
    from[index] = which;
    assign(index, placed[which]!);
    const column = index % columns;
    const row = (index - column) / columns;
    const reach = placed[which]!.reach;
    for (const [dx, dy, length] of steps) {
      const nx = column + dx;
      const ny = row + dy;
      if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
      const next = ny * columns + nx;
      if (!land[next] || from[next] !== -1 || near[next]! > STAGE) continue;
      const nextScore = score + length / reach;
      if (nextScore < cost[next]!) {
        cost[next] = nextScore;
        push([nextScore, next, which, walked + length]);
      }
    }
  }
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
      if (from[index] !== -1 && cost[index] === 0) seeded.add(label);
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
    if (!land[index] || from[index] !== -1 || seeded.has(part[index]!)) continue;
    const u = originX + (index % columns) + 0.5;
    const v = originY + Math.floor(index / columns) + 0.5;
    let best: (typeof placed)[number] | null = null;
    let bestScore = Infinity;
    for (const entry of placed) {
      const score = Math.hypot(entry.at.u - u, entry.at.v - v) / entry.reach;
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (best && Math.hypot(best.at.u - u, best.at.v - v) <= STAGE) assign(index, best);
  }
  // 사방이 영지로 둘러싸인 오지(판 가장자리까지 주인 없는 칸으로 이어지지 않는 땅)는 구멍처럼 보인다. 가장 가까운
  // 이웃 영지에 붙인다(사용자 2026-11-14: "빈곳 있는지 알아봐").
  const open = new Uint8Array(columns * rows);
  const queue: number[] = [];
  for (let column = 0; column < columns; column++) queue.push(column, (rows - 1) * columns + column);
  for (let row = 0; row < rows; row++) queue.push(row * columns, row * columns + columns - 1);
  while (queue.length) {
    const index = queue.pop()!;
    if (open[index] || owner[index] !== -1) continue;
    open[index] = 1;
    const column = index % columns;
    const row = (index - column) / columns;
    if (column > 0) queue.push(index - 1);
    if (column < columns - 1) queue.push(index + 1);
    if (row > 0) queue.push(index - columns);
    if (row < rows - 1) queue.push(index + columns);
  }
  for (let pass = 0, changed = true; changed && pass < columns + rows; pass++) {
    changed = false;
    for (let index = 0; index < land.length; index++) {
      if (!land[index] || owner[index] !== -1 || open[index]) continue;
      for (const next of [index - 1, index + 1, index - columns, index + columns]) {
        if (next < 0 || next >= land.length || owner[next] === -1) continue;
        if ((next === index - 1 || next === index + 1) && Math.floor(next / columns) !== Math.floor(index / columns))
          continue;
        const entry = placed.find((item) => item.site.key === owner[next]);
        if (!entry) continue;
        assign(index, entry);
        changed = true;
        break;
      }
    }
  }
  // 오지 땅과 맞닿은 물 칸은 오지다(사용자 2026-11-14: "오지 옆에 물이 있을경우엔 그건 그냥 오지지").
  // 강줄기를 따라 영지가 오지 안으로 뻗지 않는다.
  const outland = (index: number) => land[index] === 1 && !wet[index] && owner[index] === -1;
  const drop: number[] = [];
  for (let index = 0; index < land.length; index++) {
    if (!wet[index] || owner[index] === -1) continue;
    const column = index % columns;
    const sides = [
      column > 0 ? index - 1 : -1,
      column < columns - 1 ? index + 1 : -1,
      index - columns,
      index + columns,
    ].filter((next) => next >= 0 && next < land.length);
    if (sides.some(outland)) drop.push(index);
  }
  for (const index of drop) {
    owner[index] = -1;
    data.fill(0, index * 4, index * 4 + 4);
  }
  // 오지 표시: 주인 없는 땅·강·호수 칸은 B=1(A=0)로 둔다. 셰이더는 이 칸만 어둡게 칠한다. 바다 칸에 걸친 해안 땅
  // 조각은 오지로 칠하지 않고(사용자 2026-11-14: "해안에 오지가 남아있는데"), 오지 안의 강·호수는 함께 칠한다
  // (사용자 2026-11-14: "플레이 바깥 지역의 강이랑 호수가 물로 치부되어서 밝게 보인다").
  for (let index = 0; index < land.length; index++) if (land[index] && owner[index] === -1) data[index * 4 + 2] = 1;
  return { originX, originY, columns, rows, data, owner };
}
