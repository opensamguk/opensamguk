// 성 화면 슬롯 방식의 기하(기획 docs/design/castle-panorama-plan.md 4.1, 4.3, 4.3.1).
// 서버 땅 슬롯 하나 = 화면 3×3칸 받침 하나. 슬롯 사이는 1칸 길. 성 안 슬롯은 성벽 안, 성 밖 슬롯은 성벽 밖 둘레 길 너머.
// 성벽은 칸 단위 상자로 계산한다. 그림은 이 상자 자리에 맞춰 덧칠한 조각만 쓴다(그림이 자리를 정하지 않는다).
import { CITY_LAND, type CityGrade } from '@opensamguk/shared';

/** 화면 1칸(2:1 마름모) 가로 px(1배). */
export const CELL = 128;

/** 등급별 성벽 단계, 성문 수(사용자 2026-11-16). 치는 성벽 3단계(특, 경)부터. */
export const WALL_GRADE: Readonly<Record<CityGrade, { level: 1 | 2 | 3; gates: 1 | 2 | 4 }>> = {
  현: { level: 1, gates: 1 },
  소: { level: 1, gates: 1 },
  중: { level: 2, gates: 2 },
  대: { level: 2, gates: 2 },
  특: { level: 3, gates: 4 },
  경: { level: 3, gates: 4 },
};

/**
 * 높이(화면 1배 px)와 성가퀴 틀. 칠한 성벽 그림이 성벽 단계별 높이로 그려져 있어 같은 단계의 두 등급은 높이가 같다
 * (사용자 2026-11-16 "단계별 높이로"). 등급 차이는 성 크기, 성문 수, 치, 각루 누각으로 난다.
 * 두께는 성가퀴 간격과 맞아야 한다: t = m/n - 1 (m 홀수). 그래야 바깥 모서리에 성가퀴가 꼭 하나 오고 칸 경계는 빈틈이 된다.
 */
const LEVEL_SIZE = {
  1: { height: 56, merlon: 18, gateTower: 30, n: 5, thick: 0.4 },
  2: { height: 76, merlon: 22, gateTower: 38, n: 4, thick: 0.75 },
  3: { height: 96, merlon: 26, gateTower: 36, n: 4, thick: 0.75 },
} as const;
export const WALL_SIZE: Readonly<
  Record<CityGrade, { height: number; merlon: number; gateTower: number; n: number; thick: number }>
> = {
  현: LEVEL_SIZE[1],
  소: LEVEL_SIZE[1],
  중: LEVEL_SIZE[2],
  대: LEVEL_SIZE[2],
  특: LEVEL_SIZE[3],
  경: LEVEL_SIZE[3],
};

/** 두께가 성가퀴 수와 맞는 값인지(m/n - 1, m 홀수). */
export function thickFits(n: number, thick: number): boolean {
  const m = (thick + 1) * n;
  return Math.abs(m - Math.round(m)) < 1e-6 && Math.round(m) % 2 === 1 && m > n && m < 2 * n;
}

export type BoxKind = 'wall' | 'gate' | 'merlon' | 'tower' | 'roof';
/** 상자: i0, i1, j0, j1(칸), z0, z1(1배 px), 종류. */
export type Box = readonly [number, number, number, number, number, number, BoxKind];

export interface SlotCell {
  id: string;
  zone: 'inside' | 'outside';
  /** 받침 왼쪽 위 칸(가장 작은 i, j). 받침은 [a, a+3] × [b, b+3]. */
  a: number;
  b: number;
}

export interface CastleLayout {
  grade: CityGrade | null;
  /** 성 안 칸 수(길 포함). 성이 없으면 0. */
  inner: number;
  /** 성벽 칸: lo = -1, hi = inner. 성이 없으면 null. */
  wall: { lo: number; hi: number } | null;
  /** 성문 자리(벽 가운데 칸 번호)와 성문이 서는 벽. */
  gate: number;
  gateSides: readonly WallSide[];
  slots: readonly SlotCell[];
  /** 그릴 땅 범위(칸). */
  bounds: { i0: number; i1: number; j0: number; j1: number };
  /** 태수부 받침(3 x 3칸) 왼쪽 위 칸. 성이 없으면 null. */
  palace: { a: number; b: number } | null;
}

export type WallSide = 'R' | 'L' | 'BR' | 'BL';
const GATE_ORDER: readonly WallSide[] = ['R', 'L', 'BR', 'BL'];

/**
 * 서버 슬롯 좌표(가운데 0, 짝수 한 변은 반 정수)를 화면 칸으로 옮긴다.
 * 성 안 맨 뒤 줄과 맨 뒤 열(슬롯 한 칸 너비, 4칸)은 태수부 띠다(사용자 2026-11-17 "성 안을 뒤로 넓힘"):
 * 맨 뒤 모서리 칸(1, 1)에 태수부, 나머지는 마당. 서버 슬롯 수는 그대로이고 성 안 한 변만 슬롯 하나만큼 넓어진다.
 * 성 안 슬롯 s(0..core-1)는 a = 1 + 4(s + 1). 성 밖은 성벽(1칸)과 둘레 길(1칸)만큼 2칸 더 바깥.
 */
export const PALACE_BAND = 1;
export function castleLayout(
  grade: CityGrade | null,
  slots: ReadonlyArray<{ id: string; zone: 'inside' | 'outside'; i: number; j: number }>,
): CastleLayout {
  const core = grade ? CITY_LAND[grade].core : 0;
  const ring = grade ? CITY_LAND[grade].ring : 0;
  const side = grade ? core + 2 * ring : Math.round(Math.sqrt(slots.length));
  const band = core ? PALACE_BAND : 0;
  const inner = core ? 1 + 4 * (core + band) : 0;
  const axis = (v: number) => {
    const s = Math.round(v + (side - 1) / 2) - ring;
    if (!core) return 4 * s;
    if (s < 0) return 1 + 4 * s - 2;
    if (s >= core) return 1 + 4 * (s + band) + 2;
    return 1 + 4 * (s + band);
  };
  const cells = slots.map((slot) => ({ id: slot.id, zone: slot.zone, a: axis(slot.i), b: axis(slot.j) }));
  let i0 = Infinity,
    i1 = -Infinity,
    j0 = Infinity,
    j1 = -Infinity;
  for (const c of cells) {
    i0 = Math.min(i0, c.a - 1);
    i1 = Math.max(i1, c.a + 4);
    j0 = Math.min(j0, c.b - 1);
    j1 = Math.max(j1, c.b + 4);
  }
  if (!cells.length) {
    i0 = j0 = -2;
    i1 = j1 = inner + 2;
  }
  const gates = grade ? WALL_GRADE[grade].gates : 0;
  return {
    grade,
    inner,
    wall: core ? { lo: -1, hi: inner } : null,
    gate: Math.floor((inner - 1) / 2),
    gateSides: GATE_ORDER.slice(0, gates),
    slots: cells,
    bounds: { i0, i1, j0, j1 },
    palace: core ? { a: 1, b: 1 } : null,
  };
}

/** 칸이 슬롯 받침 안인지(길이 아닌지). */
export function slotAt(layout: CastleLayout, i: number, j: number): SlotCell | null {
  for (const s of layout.slots) if (i >= s.a && i < s.a + 3 && j >= s.b && j < s.b + 3) return s;
  return null;
}

/** 성벽, 성문, 치, 성가퀴, 낮은 담 상자(각루 빼고). 성이 없으면 빈 배열. 그릴 때는 wallChunks를 쓴다. */
export function wallBoxes(layout: CastleLayout): Box[] {
  const { grade, wall, inner: IN, gate: g, gateSides } = layout;
  if (!grade || !wall) return [];
  const { level } = WALL_GRADE[grade];
  const { height: h, merlon: mh, gateTower, n, thick: t } = WALL_SIZE[grade];
  const p = 1 / n;
  const a = (1 - t) / 2;
  const b0 = a;
  const b1 = 1 - a;
  const { lo, hi } = wall;
  const out: Box[] = [];
  const add = (i0: number, i1: number, j0: number, j1: number, z0: number, z1: number, kind: BoxKind = 'wall') => {
    if (i1 - i0 > 1e-6 && j1 - j0 > 1e-6 && z1 - z0 > 1e-6)
      out.push([Math.min(i0, i1), Math.max(i0, i1), Math.min(j0, j1), Math.max(j0, j1), z0, z1, kind]);
  };
  type Side = { axis: 'i' | 'j'; o: 1 | -1; outer: number; base: number };
  const sides: Record<WallSide, Side> = {
    BR: { axis: 'i', o: -1, outer: lo + b0, base: lo },
    R: { axis: 'j', o: 1, outer: hi + b1, base: hi },
    L: { axis: 'i', o: 1, outer: hi + b1, base: hi },
    BL: { axis: 'j', o: -1, outer: lo + b0, base: lo },
  };
  const put = (
    axis: 'i' | 'j',
    s0: number,
    s1: number,
    n0: number,
    n1: number,
    z0: number,
    z1: number,
    kind?: BoxKind,
  ) => (axis === 'i' ? add(s0, s1, n0, n1, z0, z1, kind) : add(n0, n1, s0, s1, z0, z1, kind));
  // 몸통은 겹치지 않게: i 방향 두 변은 바깥 모서리까지, j 방향 두 변은 그 사이.
  const span = { i: [lo + b0, hi + b1], j: [lo + b1, hi + b0] } as const;
  const bumps: Record<WallSide, Array<[number, number, number]>> = { BR: [], R: [], L: [], BL: [] };
  for (const key of ['BR', 'R', 'L', 'BL'] as const) {
    const sd = sides[key];
    const [s0, s1] = span[sd.axis];
    const nb0 = sd.base + b0;
    const nb1 = sd.base + b1;
    const segs: Array<[number, number]> = [];
    if (gateSides.includes(key)) {
      // 성문 3칸: 문대는 바깥으로 1.5/n, 높이는 벽과 같다. 가운데 칸이 문길. 위에 문루.
      const x0 = g - 1 + p;
      const x1 = g + 2 - p;
      segs.push([s0, x0], [x1, s1]);
      const F = sd.outer + sd.o * 1.5 * p;
      const n0 = Math.min(nb0, F);
      const n1 = Math.max(nb1, F);
      put(sd.axis, x0, g + 0.25, n0, n1, 0, h, 'gate');
      put(sd.axis, g + 0.75, x1, n0, n1, 0, h, 'gate');
      put(sd.axis, g + 0.25, g + 0.75, n0, n1, h * 0.62, h, 'gate');
      bumps[key].push([x0, x1, 1.5 * p]);
      const mid = g + 0.5;
      const c = (n0 + n1) / 2;
      const floors: Array<[number, number]> =
        level >= 3
          ? [
              [gateTower, 0.85],
              [gateTower * 0.83, 0.65],
            ]
          : [[gateTower, level === 1 ? 0.7 : 0.8]];
      let z = h;
      floors.forEach(([th, wr], k) => {
        const hw = ((x1 - x0) * wr) / 2;
        const dj = (n1 - n0) * (k === 0 ? 0.32 : 0.26);
        put(sd.axis, mid - hw, mid + hw, c - dj, c + dj, z, z + th, 'tower');
        z += th;
        put(sd.axis, mid - hw - 0.12, mid + hw + 0.12, c - dj - 0.1, c + dj + 0.1, z, z + 5, 'roof');
        z += 5;
      });
      put(sd.axis, mid - (x1 - x0) * 0.22, mid + (x1 - x0) * 0.22, c - 0.06, c + 0.06, z, z + 20, 'roof');
    } else segs.push([s0, s1]);
    for (const [u0, u1] of segs) put(sd.axis, u0, u1, nb0, nb1, 0, h);
    if (level >= 3) {
      for (let k = 0; k < IN; k++) {
        if (k % 3 !== 2) continue;
        if (gateSides.includes(key) && Math.abs(k - g) <= 1) continue;
        put(sd.axis, k + p, k + 1 - p, sd.outer, sd.outer + sd.o * 1.5 * p, 0, h);
        bumps[key].push([k + p, k + 1 - p, 1.5 * p]);
      }
    }
  }
  // 안쪽 낮은 담(여장).
  const lw = 0.06;
  const lh = mh * 0.45;
  add(lo + b1 - lw, hi + b0 + lw, lo + b1 - lw, lo + b1, h, h + lh);
  add(lo + b1 - lw, hi + b0 + lw, hi + b0, hi + b0 + lw, h, h + lh);
  add(lo + b1 - lw, lo + b1, lo + b1, hi + b0, h, h + lh);
  add(hi + b0, hi + b0 + lw, lo + b1, hi + b0, h, h + lh);
  // 바깥 둘레선: 북쪽 꼭짓점에서 반 간격 뒤(빈틈 한가운데)에서 출발해 +i, +j, -i, -j로 돈다.
  const N: [number, number] = [lo + b0, lo + b0];
  const E: [number, number] = [hi + b1, lo + b0];
  const S: [number, number] = [hi + b1, hi + b1];
  const W: [number, number] = [lo + b0, hi + b1];
  const path: Array<[number, number]> = [];
  const pushSide = (key: WallSide, from: [number, number], to: [number, number]) => {
    const sd = sides[key];
    const bs = bumps[key].slice().sort((u, v) => u[0] - v[0]);
    const fwd = (sd.axis === 'i' ? to[0] - from[0] : to[1] - from[1]) > 0;
    if (!fwd) bs.reverse();
    const pt = (s: number, nrm: number): [number, number] => (sd.axis === 'i' ? [s, nrm] : [nrm, s]);
    path.push(from);
    for (const [u0, u1, dep] of bs) {
      const [x0, x1] = fwd ? [u0, u1] : [u1, u0];
      const F = sd.outer + sd.o * dep;
      path.push(pt(x0, sd.outer), pt(x0, F), pt(x1, F), pt(x1, sd.outer));
    }
  };
  const start: [number, number] = [N[0] + p / 2, N[1]];
  pushSide('BR', start, E);
  pushSide('R', E, S);
  pushSide('L', S, W);
  pushSide('BL', W, N);
  path.push(N, start);
  out.push(...pathMerlons(path, h, mh, n));
  return out;
}

/**
 * 둘레선을 따라 같은 간격(1/n)으로 성가퀴를 놓는다. 가운데는 길이 p/2 + kp, 폭 0.6p, 두께는 폭의 절반.
 * 안쪽(몸통 쪽)은 진행 방향의 왼쪽(-dj, di). 바깥 모서리(성가퀴 한가운데에 오는 꼭짓점)는 네모 하나로 합친다.
 */
export function pathMerlons(
  path: ReadonlyArray<readonly [number, number]>,
  z: number,
  mh: number,
  n: number,
  kind: BoxKind = 'merlon',
): Box[] {
  const p = 1 / n;
  const w = 0.6 * p;
  const d = w / 2;
  const sc = 0.75 * w;
  type Seg = {
    P: readonly [number, number];
    Q: readonly [number, number];
    s0: number;
    s1: number;
    di: number;
    dj: number;
    ni: number;
    nj: number;
  };
  const segs: Seg[] = [];
  let acc = 0;
  for (let k = 0; k + 1 < path.length; k++) {
    const P = path[k]!;
    const Q = path[k + 1]!;
    const L = Math.abs(Q[0] - P[0]) + Math.abs(Q[1] - P[1]);
    if (L < 1e-9) continue;
    const di = Math.sign(Q[0] - P[0]);
    const dj = Math.sign(Q[1] - P[1]);
    segs.push({ P, Q, s0: acc, s1: acc + L, di, dj, ni: -dj, nj: di });
    acc += L;
  }
  const out: Array<[number, number, number, number, number, number]> = [];
  for (let t = p / 2; t - w / 2 < acc; t += p) {
    for (const sg of segs) {
      const a0 = Math.max(t - w / 2, sg.s0);
      const a1 = Math.min(t + w / 2, sg.s1);
      if (a1 <= a0 + 1e-9) continue;
      const u0 = a0 - sg.s0;
      const u1 = a1 - sg.s0;
      if (sg.di !== 0) {
        const x0 = sg.P[0] + sg.di * u0;
        const x1 = sg.P[0] + sg.di * u1;
        const J = sg.P[1];
        out.push([Math.min(x0, x1), Math.max(x0, x1), sg.nj > 0 ? J : J - d, sg.nj > 0 ? J + d : J, z, z + mh]);
      } else {
        const y0 = sg.P[1] + sg.dj * u0;
        const y1 = sg.P[1] + sg.dj * u1;
        const I = sg.P[0];
        out.push([sg.ni > 0 ? I : I - d, sg.ni > 0 ? I + d : I, Math.min(y0, y1), Math.max(y0, y1), z, z + mh]);
      }
    }
  }
  for (let k = 0; k + 1 < segs.length; k++) {
    const A = segs[k]!;
    const C = segs[k + 1]!;
    const r = (A.s1 - p / 2) / p;
    if (Math.abs(r - Math.round(r)) > 1e-6) continue;
    if (A.di * C.dj - A.dj * C.di < 0) continue; // 안쪽 꺾임
    const v = A.Q;
    const si = (A.ni || C.ni) > 0 ? 1 : -1;
    const sj = (A.nj || C.nj) > 0 ? 1 : -1;
    const ci: [number, number] = si > 0 ? [v[0], v[0] + sc] : [v[0] - sc, v[0]];
    const cj: [number, number] = sj > 0 ? [v[1], v[1] + sc] : [v[1] - sc, v[1]];
    for (let m = out.length - 1; m >= 0; m--) {
      const b = out[m]!;
      if (b[0] < ci[1] - 1e-9 && ci[0] < b[1] - 1e-9 && b[2] < cj[1] - 1e-9 && cj[0] < b[3] - 1e-9) out.splice(m, 1);
    }
    out.push([ci[0], ci[1], cj[0], cj[1], z, z + mh]);
  }
  return out.map((b) => [...b, kind] as Box);
}

/**
 * 모서리 각루(사용자 2026-11-16 "각루가 없네?"). 모서리 칸을 통째로 차지하는 대, 위에 성가퀴(한 변 3개).
 * 성벽 2단계부터 누각 1층, 3단계는 2층. 모서리 칸의 성벽 조각은 wallChunks에서 뺀다(겹치면 앞뒤를 못 정한다).
 */
export function towerBoxes(layout: CastleLayout): Box[] {
  const { grade, wall } = layout;
  if (!grade || !wall) return [];
  const { level } = WALL_GRADE[grade];
  const { height: h, merlon: mh, gateTower } = WALL_SIZE[grade];
  const { lo, hi } = wall;
  const out: Box[] = [];
  const th = h + ({ 1: 16, 2: 22, 3: 28 } as const)[level];
  for (const [ci, cj] of [
    [lo, lo],
    [hi, lo],
    [hi, hi],
    [lo, hi],
  ] as const) {
    out.push([ci, ci + 1, cj, cj + 1, 0, th, 'gate']); // 대는 성벽과 같은 돌
    const sq: Array<[number, number]> = [
      [ci + 0.5, cj],
      [ci + 1, cj],
      [ci + 1, cj + 1],
      [ci, cj + 1],
      [ci, cj],
      [ci + 0.5, cj],
    ];
    out.push(...pathMerlons(sq, th, mh, 3));
    const floors: Array<[number, number]> =
      level === 1
        ? []
        : level === 2
          ? [[gateTower * 0.9, 0.36]]
          : [
              [gateTower * 0.9, 0.36],
              [gateTower * 0.72, 0.28],
            ];
    let z = th;
    for (const [fh, half] of floors) {
      out.push([ci + 0.5 - half, ci + 0.5 + half, cj + 0.5 - half, cj + 0.5 + half, z, z + fh, 'tower']);
      z += fh;
      out.push([
        ci + 0.5 - half - 0.1,
        ci + 0.5 + half + 0.1,
        cj + 0.5 - half - 0.1,
        cj + 0.5 + half + 0.1,
        z,
        z + 5,
        'roof',
      ]);
      z += 5;
    }
    if (floors.length) out.push([ci + 0.38, ci + 0.62, cj + 0.38, cj + 0.62, z, z + 14, 'roof']);
  }
  return out;
}

/** 그릴 조각: 성벽을 칸으로 쪼개고, 모서리 칸은 각루만 남긴다. */
export function wallChunks(layout: CastleLayout): Chunk[] {
  if (!layout.wall) return [];
  const { lo, hi } = layout.wall;
  const corner = (c: Chunk['c']) => {
    const a = Math.floor(c[0] + 1e-6);
    const b = Math.floor(c[2] + 1e-6);
    return (a === lo || a === hi) && (b === lo || b === hi);
  };
  return [...splitCells(wallBoxes(layout)).filter((ch) => !corner(ch.c)), ...splitCells(towerBoxes(layout))];
}

/** 칸 경계(정수 i, j)에서 상자를 쪼갠다. 조각마다 원래 상자를 기억한다(테두리 선 긋기용). */
export interface Chunk {
  c: readonly [number, number, number, number, number, number];
  o: Box;
}
export function splitCells(boxes: readonly Box[]): Chunk[] {
  const out: Chunk[] = [];
  for (const b of boxes) {
    const ic = [b[0]];
    for (let k = Math.floor(b[0]) + 1; k < b[1]; k++) if (k > b[0]) ic.push(k);
    ic.push(b[1]);
    const jc = [b[2]];
    for (let k = Math.floor(b[2]) + 1; k < b[3]; k++) if (k > b[2]) jc.push(k);
    jc.push(b[3]);
    for (let x = 0; x + 1 < ic.length; x++)
      for (let y = 0; y + 1 < jc.length; y++)
        out.push({ c: [ic[x]!, ic[x + 1]!, jc[y]!, jc[y + 1]!, b[4], b[5]], o: b });
  }
  return out;
}

type P2 = readonly [number, number];
function hull(pts: P2[]): P2[] {
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [];
  const up: P2[] = [];
  for (const q of s) {
    while (lo.length >= 2 && cr(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let k = s.length - 1; k >= 0; k--) {
    const q = s[k]!;
    while (up.length >= 2 && cr(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function projHull(c: Chunk['c']): P2[] {
  const pts: P2[] = [];
  for (const i of [c[0], c[1]])
    for (const j of [c[2], c[3]]) for (const z of [c[4], c[5]]) pts.push([(i - j) * 64, (i + j) * 32 - z]);
  return hull(pts);
}
function overlap(A: P2[], B: P2[], tol: number): boolean {
  for (const P of [A, B]) {
    for (let k = 0; k < P.length; k++) {
      const [x1, y1] = P[k]!;
      const [x2, y2] = P[(k + 1) % P.length]!;
      const nx = y2 - y1;
      const ny = x1 - x2;
      const L = Math.hypot(nx, ny) || 1;
      let amin = Infinity,
        amax = -Infinity,
        bmin = Infinity,
        bmax = -Infinity;
      for (const [x, y] of A) {
        const v = nx * x + ny * y;
        amin = Math.min(amin, v);
        amax = Math.max(amax, v);
      }
      for (const [x, y] of B) {
        const v = nx * x + ny * y;
        bmin = Math.min(bmin, v);
        bmax = Math.max(bmax, v);
      }
      if (amax <= bmin + tol * L || bmax <= amin + tol * L) return false;
    }
  }
  return true;
}
const behind = (a: Chunk['c'], b: Chunk['c']) => a[1] <= b[0] + 1e-6 || a[3] <= b[2] + 1e-6 || a[5] <= b[4] + 1e-6;

/**
 * 그리는 순서: 화면에서 실제로 겹치는 조각끼리만 앞뒤(i, j, 높이 중 갈라지는 축)를 정해 위상 정렬한다.
 * 겹치지 않는 조각끼리 앞뒤를 정하면 기준끼리 반대 답이 나와 꼬인다(기획 4.3).
 * 고리가 남으면 그 수를 cycles로 돌려준다(0이어야 한다).
 */
export function depthOrder<T extends { c: Chunk['c'] }>(items: readonly T[]): { order: T[]; cycles: number } {
  const n = items.length;
  const H = items.map((it) => projHull(it.c));
  const bb = H.map((h) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [x, y] of h) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1] as const;
  });
  const G = 48;
  const grid = new Map<string, number[]>();
  bb.forEach((b, k) => {
    for (let gx = Math.floor(b[0] / G); gx <= Math.floor(b[2] / G); gx++)
      for (let gy = Math.floor(b[1] / G); gy <= Math.floor(b[3] / G); gy++) {
        const key = `${gx},${gy}`;
        const list = grid.get(key);
        if (list) list.push(k);
        else grid.set(key, [k]);
      }
  });
  const seen = new Set<number>();
  const indeg = new Array<number>(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const ks of grid.values())
    for (let u = 0; u < ks.length; u++)
      for (let v = u + 1; v < ks.length; v++) {
        const x = Math.min(ks[u]!, ks[v]!);
        const y = Math.max(ks[u]!, ks[v]!);
        const key = x * n + y;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = bb[x]!;
        const B = bb[y]!;
        if (A[2] <= B[0] || B[2] <= A[0] || A[3] <= B[1] || B[3] <= A[1]) continue;
        if (!overlap(H[x]!, H[y]!, 0.3)) continue;
        const xy = behind(items[x]!.c, items[y]!.c);
        const yx = behind(items[y]!.c, items[x]!.c);
        if (xy && !yx) {
          adj[x]!.push(y);
          indeg[y]!++;
        } else if (yx && !xy) {
          adj[y]!.push(x);
          indeg[x]!++;
        }
      }
  const order: number[] = [];
  const ready: number[] = [];
  for (let k = 0; k < n; k++) if (!indeg[k]) ready.push(k);
  while (ready.length) {
    const k = ready.pop()!;
    order.push(k);
    for (const m of adj[k]!) if (--indeg[m]! === 0) ready.push(m);
  }
  const cycles = n - order.length;
  if (cycles) {
    const done = new Set(order);
    for (let k = 0; k < n; k++) if (!done.has(k)) order.push(k);
  }
  return { order: order.map((k) => items[k]!), cycles };
}

/** 뒤쪽 벽(건물보다 먼저 그릴 조각)인지. 북쪽 모서리와 뒤쪽 두 벽, 그 바깥으로 튀어나온 것. */
export function isBackWall(layout: CastleLayout, c: Chunk['c']): boolean {
  if (!layout.wall) return false;
  const { lo, hi } = layout.wall;
  const ci = (c[0] + c[1]) / 2;
  const cj = (c[2] + c[3]) / 2;
  return (ci < lo + 1 && cj < hi) || (cj < lo + 1 && ci < hi);
}
