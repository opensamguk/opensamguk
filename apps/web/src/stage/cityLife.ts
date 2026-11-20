// 성 화면의 사람과 동물(시안 castle-panorama의 populate, actors를 옮김, 2026-11-17 사용자 "시안 기능 전부 옮기기").
// 사람은 길로만 다닌다. 슬롯(3 x 3칸)은 4칸 간격이라 슬롯 둘레 0.5칸 자리가 늘 길이다:
// 성 안 길 4k + 0.5, 성벽 안 둘레 0.5와 inner - 0.5, 성벽 밖 둘레 -1.5와 inner + 1.5, 그 바깥 길은 4칸씩.
// 길은 교차점과 성문을 잇는 길망(roadNet)이다. 사람과 동물은 종류마다 정한 이동 규칙(MOVES)대로
// 다닐 수 있는 곳(성 안, 성 밖, 둘 다)에서 갈 곳을 골라 길망의 가장 짧은 길로 가고, 닿으면 잠시 쉬었다 다시 고른다
// (사용자 2026-11-17: "성밖으로 나가는건 사람종류나 동물 종류에 따라서 다르게", "길따라 가게 만들고 종류에 따라 어떻게 가는지 정의").
// 건물 그림 위를 지나지 않으니(사용자 2026-11-16 "아예 건물도 이제는 뚫고 지나는데?") 앞뒤 가림은 칸 좌표만으로 정한다.
import type { CastleLayout } from './castleGeometry';
import { ANIMALS, ROLE_KIND } from './cityTalk';

export type Pt = readonly [number, number];
export interface Walker {
  kind: string;
  /** 지금 가는 길(칸 좌표 꺾은선). 다 가면 쉬었다가 다음 갈 곳을 고른다. */
  path: readonly Pt[];
  /** 한 틀에 가는 칸 수. */
  speed: number;
  /** 길 위 거리(칸). */
  s: number;
  /** 정해진 둘레를 계속 도는 사람(순찰병). */
  loop: boolean;
  role?: string | undefined;
  /** 시설 일꾼이면 그 시설 키(반쯤은 일터로 돌아간다). */
  work?: string | undefined;
  /** 종류의 다닐 곳 대신 쓸 곳(성 밖 시설의 아낙처럼 일터가 종류의 다닐 곳 밖일 때). */
  area?: Area | undefined;
  /** 집(건물 인물은 그 건물 앞, 동물은 민가 앞) 길망 점. */
  home: number;
  /** 지금 서 있는 길망 점. */
  at: number;
  /** 남은 쉬는 틀 수. */
  rest: number;
  seed: number;
}
/** 제자리에서 일하는 사람(밭 농부, 공사 일꾼). */
export interface Actor {
  kind: 'farmer' | 'worker';
  i: number;
  j: number;
  row: number;
  rate: number;
  building?: string | undefined;
}
export interface LifeSlot {
  id: string;
  a: number;
  b: number;
  zone: 'inside' | 'outside';
  building: string | null;
  level: number;
  pending: boolean;
}
export type Terrain = 'coast' | 'river' | 'mountain' | 'forest' | 'steppe' | 'dry' | 'paddy' | 'nanzhong' | 'default';

/** 양식의 바탕(시안 TERRAIN, STEPPE). 수(나루, 수채) 거점은 물가로 따로 준다. */
const TERRAIN_OF: Readonly<Record<string, Terrain>> = {
  liang: 'dry',
  'tribe-qiang': 'dry',
  yang: 'paddy',
  jing: 'paddy',
  'east-mahan': 'paddy',
  'east-wa': 'paddy',
  'ba-shu': 'mountain',
  'east-goguryeo': 'mountain',
  'tribe-di': 'mountain',
  'tribe-shanyue': 'mountain',
  'tribe-yizhou': 'mountain',
  'east-okjeo-ye': 'forest',
  'east-eupru': 'forest',
  nanzhong: 'nanzhong',
  'tribe-nanman': 'nanzhong',
  'tribe-xiongnu': 'steppe',
  'tribe-xianbei': 'steppe',
  'tribe-wuhuan': 'steppe',
};
export const terrainOf = (style: string, water?: 'coast' | 'river' | null): Terrain =>
  water ?? TERRAIN_OF[style] ?? 'default';

/** 옷차림 무리(사람 그림 폴더). 한족은 han. */
export function groupOf(style: string): 'han' | 'steppe' | 'west' | 'south' | 'eastnorth' | 'samhan' | 'wa' {
  if (style.startsWith('tribe-'))
    return style === 'tribe-xiongnu' || style === 'tribe-xianbei' || style === 'tribe-wuhuan'
      ? 'steppe'
      : style === 'tribe-qiang' || style === 'tribe-di'
        ? 'west'
        : 'south';
  if (['east-goguryeo', 'east-buyeo', 'east-eupru', 'east-okjeo-ye'].includes(style)) return 'eastnorth';
  if (style === 'east-mahan' || style === 'east-jinbyeon') return 'samhan';
  if (style === 'east-wa') return 'wa';
  return 'han';
}

export const pathLength = (path: readonly Pt[]) =>
  path.slice(1).reduce((sum, b, n) => sum + Math.hypot(b[0] - path[n]![0], b[1] - path[n]![1]), 0);

/** 길 위 거리 s의 칸 좌표와 가는 방향. 도는 길은 처음으로 돌아가고, 아니면 끝에 멈춘다. */
export function walkerAt(w: Pick<Walker, 'path' | 's' | 'loop'>): { i: number; j: number; di: number; dj: number } {
  const len = pathLength(w.path);
  if (len <= 0) return { i: w.path[0]![0], j: w.path[0]![1], di: 1, dj: 0 };
  let s = w.loop ? w.s % len : Math.min(w.s, len);
  for (let n = 0; n < w.path.length - 1; n++) {
    const a = w.path[n]!;
    const b = w.path[n + 1]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= seg || n === w.path.length - 2) {
      const t = seg ? Math.min(1, s / seg) : 0;
      return { i: a[0] + (b[0] - a[0]) * t, j: a[1] + (b[1] - a[1]) * t, di: b[0] - a[0], dj: b[1] - a[1] };
    }
    s -= seg;
  }
  const last = w.path[w.path.length - 1]!;
  return { i: last[0], j: last[1], di: 1, dj: 0 };
}

/** 그림 방향(SE, SW, NE, NW). i가 늘면 화면 오른쪽 아래, j가 늘면 왼쪽 아래. */
export const facing = (di: number, dj: number) =>
  Math.abs(di) >= Math.abs(dj) ? (di > 0 ? 'SE' : 'NW') : dj > 0 ? 'SW' : 'NE';

// ---------- 길망 ----------
export type Area = 'inside' | 'outside' | 'both';
export interface RoadNet {
  pts: Pt[];
  /** 이웃 점 번호. */
  next: number[][];
  /** 점이 성 안인가(성벽 안 둘레 길 포함). 성이 없으면 모두 성 밖. */
  inside: boolean[];
  /** 성문 안쪽 점, 바깥쪽 점. */
  gates: Array<{ inner: number; outer: number }>;
  /** 땅 가장자리 점(밭, 들, 물가로 나가는 사냥꾼, 목동이 가는 곳). */
  edge: number[];
}

/** 슬롯 사이 길과 성벽 안팎 둘레 길을 교차점으로 잇는다. 성벽은 성문 자리로만 지난다. */
export function roadNet(layout: CastleLayout): RoadNet {
  const { inner } = layout;
  const { i0, i1, j0, j1 } = layout.bounds;
  const lo = Math.min(i0, j0);
  const hi = Math.max(i1, j1);
  const lines = new Set<number>();
  if (inner) {
    for (let v = 0.5; v <= inner - 0.5 + 1e-9; v += 4) lines.add(v);
    for (let v = -1.5; v >= lo; v -= 4) lines.add(v);
    for (let v = inner + 1.5; v <= hi; v += 4) lines.add(v);
  } else for (let v = -0.5 + 4 * Math.ceil((lo + 0.5) / 4); v <= hi; v += 4) lines.add(v);
  const g = layout.gate + 0.5;
  // 성문 칸 g가 슬롯 사이 길이 아니어도 성벽 안팎 둘레 길 위에는 점을 둔다.
  const ringVals = inner ? [-1.5, 0.5, inner - 0.5, inner + 1.5] : [];
  const axis = [...lines].sort((a, b) => a - b);
  const pts: Pt[] = [];
  const key = new Map<string, number>();
  const node = (i: number, j: number) => {
    const k = `${i},${j}`;
    let n = key.get(k);
    if (n === undefined) {
      n = pts.length;
      pts.push([i, j]);
      key.set(k, n);
    }
    return n;
  };
  const inBounds = (v: number, a: number, b: number) => v >= a && v <= b;
  for (const i of axis) for (const j of axis) if (inBounds(i, i0, i1) && inBounds(j, j0, j1)) node(i, j);
  if (inner && layout.gateSides.length)
    for (const r of ringVals) {
      node(r, g);
      node(g, r);
    }
  const isInside = (p: Pt) => !!inner && p[0] > 0 && p[0] < inner && p[1] > 0 && p[1] < inner;
  const next: number[][] = pts.map(() => []);
  const link = (a: number, b: number) => {
    if (!next[a]!.includes(b)) next[a]!.push(b);
    if (!next[b]!.includes(a)) next[b]!.push(a);
  };
  // 같은 줄 위 이웃 점끼리 잇되 성벽(안팎이 바뀌는 곳)은 건너지 않는다.
  for (const fixedFirst of [true, false]) {
    const groups = new Map<number, number[]>();
    pts.forEach((p, n) => {
      const k = fixedFirst ? p[0] : p[1];
      const list = groups.get(k) ?? [];
      list.push(n);
      groups.set(k, list);
    });
    for (const [fixed, list] of groups) {
      // 성문 칸 줄(g)이 슬롯 사이 길이 아니면 그 줄로는 잇지 않는다(성문 길만 따로 잇는다).
      if (!lines.has(fixed)) continue;
      const along = list.sort((a, b) => (fixedFirst ? pts[a]![1] - pts[b]![1] : pts[a]![0] - pts[b]![0]));
      for (let n = 0; n + 1 < along.length; n++) {
        const a = along[n]!;
        const b = along[n + 1]!;
        if (isInside(pts[a]!) !== isInside(pts[b]!)) continue;
        link(a, b);
      }
    }
  }
  // 성문: 안쪽 둘레 점과 바깥 둘레 점을 잇는다.
  const gates: RoadNet['gates'] = [];
  for (const side of layout.gateSides) {
    const [ii, oo] =
      side === 'R'
        ? [node(inner - 0.5, g), node(inner + 1.5, g)]
        : side === 'L'
          ? [node(g, inner - 0.5), node(g, inner + 1.5)]
          : side === 'BR'
            ? [node(g, 0.5), node(g, -1.5)]
            : [node(0.5, g), node(-1.5, g)];
    link(ii, oo);
    gates.push({ inner: ii, outer: oo });
  }
  const inside = pts.map(isInside);
  const edgeAt = (p: Pt) =>
    p[0] === axis.find((v) => v >= i0) ||
    p[1] === axis.find((v) => v >= j0) ||
    p[0] === [...axis].reverse().find((v) => v <= i1) ||
    p[1] === [...axis].reverse().find((v) => v <= j1);
  const edge = pts.map((p, n) => (!inside[n] && edgeAt(p) ? n : -1)).filter((n) => n >= 0);
  return { pts, next, inside, gates, edge };
}

/** 길망에서 가장 짧은 길(점 번호). 다닐 수 없는 곳(area 밖)은 지나지 않는다. 못 가면 null. */
export function route(net: RoadNet, from: number, to: number, area: Area): number[] | null {
  const ok = (n: number) => area === 'both' || (area === 'inside' ? net.inside[n] : !net.inside[n]);
  if (!ok(from) || !ok(to)) return null;
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const todo = new Set([from]);
  while (todo.size) {
    let u = -1;
    let best = Infinity;
    for (const n of todo) if (dist.get(n)! < best) [u, best] = [n, dist.get(n)!];
    todo.delete(u);
    if (u === to) break;
    for (const v of net.next[u]!) {
      if (!ok(v)) continue;
      const d = best + Math.hypot(net.pts[v]![0] - net.pts[u]![0], net.pts[v]![1] - net.pts[u]![1]);
      if (d < (dist.get(v) ?? Infinity)) {
        dist.set(v, d);
        prev.set(v, u);
        todo.add(v);
      }
    }
  }
  if (!dist.has(to)) return null;
  const out = [to];
  while (out[0] !== from) out.unshift(prev.get(out[0]!)!);
  return out;
}

/** 가장 가까운 길망 점(다닐 수 있는 곳 안에서). */
export function nearest(net: RoadNet, p: Pt, area: Area = 'both'): number {
  let best = -1;
  let d = Infinity;
  net.pts.forEach((q, n) => {
    if (area !== 'both' && (area === 'inside') !== net.inside[n]) return;
    const e = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (e < d) [best, d] = [n, e];
  });
  return best;
}

// ---------- 종류마다 이동 규칙 ----------
/** 갈 곳: 건물 키(그 건물 앞), 'gate'(성문 안쪽), 'gateOut'(성문 바깥), 'home', 'near'(집 둘레 몇 칸), 'edge'(땅 가장자리), 'any'. */
type Goal = string;
export interface Move {
  area: Area;
  /** 한 틀에 가는 칸 수. */
  speed: number;
  /** 닿은 뒤 쉬는 틀 수(최소, 최대). */
  rest: readonly [number, number];
  /** 갈 곳 후보(앞에 있을수록 자주). 그 건물이 없으면 다음 후보. */
  goals: readonly Goal[];
  /** near일 때 집에서 몇 칸 안. */
  radius?: number;
}
const MARKETS = ['market', 'grand_market', 'black_market', 'fish_market'];
const FIELDS = ['farm', 'military_farm', 'irrigation', 'granary', 'dam'];
export const MOVES: Readonly<Record<string, Move>> = {
  // 백성: 성 안팎을 오간다. 집, 장, 관청, 밭.
  villager: {
    area: 'both',
    speed: 0.012,
    rest: [20, 80],
    goals: ['house', 'market', 'office', 'gateOut', 'farm', 'tavern', 'any'],
  },
  // 아낙: 성 안에서 집, 장, 우물가(민가), 주점, 사당.
  woman: {
    area: 'inside',
    speed: 0.011,
    rest: [30, 90],
    goals: ['house', 'market', 'tavern', 'shrine', 'house', 'any'],
  },
  // 아이: 성 안 집 둘레를 뛰어다닌다.
  child: { area: 'inside', speed: 0.02, rest: [5, 25], goals: ['near', 'near', 'market', 'house'], radius: 8 },
  // 노인: 성 안, 느리고 오래 쉰다.
  elder: {
    area: 'inside',
    speed: 0.005,
    rest: [80, 200],
    goals: ['shrine', 'house', 'academy', 'clinic', 'near'],
    radius: 6,
  },
  scholar: {
    area: 'inside',
    speed: 0.009,
    rest: [60, 150],
    goals: ['academy', 'palace', 'office', 'shrine', 'stone_maze', 'any'],
  },
  clerk: {
    area: 'inside',
    speed: 0.01,
    rest: [40, 120],
    goals: ['palace', 'office', 'tally', 'granary', 'market', 'mint', 'arsenal'],
  },
  // 행상: 성문 밖에서 들어와 장을 돈다.
  peddler: { area: 'both', speed: 0.009, rest: [30, 90], goals: [...MARKETS, 'gateOut', 'house'] },
  // 짐꾼: 창고, 장, 성문 밖, 소금밭, 제철소.
  porter: {
    area: 'both',
    speed: 0.01,
    rest: [15, 50],
    goals: ['granary', 'market', 'gateOut', 'saltworks', 'ironworks', 'arsenal', 'shipyard'],
  },
  // 수레: 성문과 창고, 장 사이 큰길. 쉬는 시간이 길다.
  cart: {
    area: 'both',
    speed: 0.008,
    rest: [60, 160],
    goals: ['granary', 'market', 'gateOut', 'grand_market', 'workshop'],
  },
  // 농부: 집에서 성문을 나가 밭으로.
  farmer: { area: 'both', speed: 0.01, rest: [80, 200], goals: [...FIELDS, 'house'] },
  // 병사: 병영, 성문, 망루. 성 밖 진지로도 나간다.
  soldier: {
    area: 'both',
    speed: 0.012,
    rest: [20, 60],
    goals: ['barracks', 'gate', 'patrol', 'drill_ground', 'camp', 'fort', 'gateOut'],
  },
  // 어부, 사냥꾼, 목동: 성 밖에서만.
  fisher: { area: 'outside', speed: 0.008, rest: [60, 160], goals: ['fish_market', 'ferry', 'shipyard', 'edge'] },
  hunter: { area: 'outside', speed: 0.01, rest: [40, 120], goals: ['edge', 'edge', 'stable', 'gateOut'] },
  herder: { area: 'outside', speed: 0.007, rest: [80, 200], goals: ['edge', 'stable', 'edge', 'farm'] },
  // 개: 사람 따라 어디든, 빠르다.
  dog: { area: 'both', speed: 0.018, rest: [10, 40], goals: ['near', 'near', 'gate', 'market'], radius: 8 },
  // 닭, 돼지: 민가 앞 몇 칸만.
  chicken: { area: 'both', speed: 0.006, rest: [20, 80], goals: ['near'], radius: 4 },
  pig: { area: 'both', speed: 0.005, rest: [40, 120], goals: ['near'], radius: 4 },
  // 소, 물소: 성 밖 밭과 물길.
  ox: { area: 'outside', speed: 0.004, rest: [100, 260], goals: [...FIELDS, 'near'], radius: 6 },
  buffalo: { area: 'outside', speed: 0.004, rest: [100, 260], goals: ['irrigation', 'farm', 'dam', 'near'], radius: 6 },
  // 말: 마구간, 성문 밖, 들.
  horse: { area: 'outside', speed: 0.014, rest: [40, 120], goals: ['stable', 'edge', 'camp', 'near'], radius: 8 },
  // 양, 낙타: 성 밖 들판에서 천천히.
  sheep: { area: 'outside', speed: 0.004, rest: [80, 200], goals: ['near', 'edge'], radius: 6 },
  camel: { area: 'outside', speed: 0.005, rest: [80, 220], goals: ['edge', 'near', 'market'], radius: 8 },
};
const moveOf = (kind: string): Move => MOVES[kind] ?? MOVES.villager!;

const rand = (w: Walker) => {
  w.seed = (w.seed * 16807) % 2147483647;
  return (w.seed % 100000) / 100000;
};

/** 갈 곳 점 하나를 고른다. 없는 건물은 건너뛰고, 다닐 수 없는 곳은 고르지 않는다. */
function pickGoal(w: Walker, net: RoadNet, fronts: ReadonlyMap<string, number[]>): number {
  const m = moveOf(w.kind);
  const area = w.area ?? m.area;
  const ok = (n: number) => area === 'both' || (area === 'inside') === net.inside[n];
  const home = net.pts[w.home]!;
  // 시설 사람은 반쯤은 일터(집)로 돌아간다.
  if ((w.work || w.role) && w.at !== w.home && rand(w) < 0.5) return w.home;
  for (let tries = 0; tries < 6; tries++) {
    const goal = m.goals[Math.floor(rand(w) * m.goals.length)]!;
    let list: number[];
    if (goal === 'home') list = [w.home];
    else if (goal === 'gate') list = net.gates.map((g) => g.inner);
    else if (goal === 'gateOut') list = net.gates.map((g) => g.outer);
    else if (goal === 'edge') list = net.edge;
    else if (goal === 'any') list = net.pts.map((_, n) => n);
    else if (goal === 'near') {
      const r = m.radius ?? 4;
      list = net.pts
        .map((_, n) => n)
        .filter((n) => Math.hypot(net.pts[n]![0] - home[0], net.pts[n]![1] - home[1]) <= r);
    } else list = fronts.get(goal) ?? [];
    list = list.filter((n) => ok(n) && n !== w.at);
    if (list.length) return list[Math.floor(rand(w) * list.length)]!;
  }
  return w.home;
}

/** 한 틀 나아간다. 길 끝에 닿으면 쉬고, 다 쉬면 다음 갈 곳까지 길망을 따라 길을 낸다. */
export function advance(w: Walker, net: RoadNet, fronts: ReadonlyMap<string, number[]>) {
  if (w.loop) {
    w.s += w.speed;
    return;
  }
  const len = pathLength(w.path);
  if (w.s < len) {
    w.s = Math.min(len, w.s + w.speed);
    return;
  }
  if (w.rest > 0) {
    w.rest--;
    return;
  }
  const m = moveOf(w.kind);
  const to = pickGoal(w, net, fronts);
  const r = route(net, w.at, to, w.area ?? m.area);
  if (r && r.length > 1) {
    w.path = r.map((n) => net.pts[n]!);
    w.at = to;
    w.s = 0;
  }
  w.rest = Math.round(m.rest[0] + rand(w) * (m.rest[1] - m.rest[0]));
}

/** 건물 키마다 그 건물 슬롯 앞 길망 점(슬롯 오른쪽 아래 모서리 바깥 교차점). */
export function slotFronts(net: RoadNet, slots: readonly LifeSlot[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const s of slots) {
    if (!s.building || s.pending) continue;
    const area: Area = s.zone === 'inside' ? 'inside' : 'outside';
    const n = nearest(net, [s.a + 3.5, s.b + 3.5], area);
    if (n < 0) continue;
    const list = out.get(s.building) ?? [];
    list.push(n);
    out.set(s.building, list);
  }
  return out;
}

const ringPath = (lo: number, hi: number): Pt[] => [
  [lo, lo],
  [hi, lo],
  [hi, hi],
  [lo, hi],
  [lo, lo],
];
/** 슬롯 앞쪽 두 변을 따라가는 길(공사판 짐꾼). */
const frontOf = (s: { a: number; b: number }): Pt[] => [
  [s.a + 3.5, s.b - 0.5],
  [s.a + 3.5, s.b + 3.5],
  [s.a - 0.5, s.b + 3.5],
];

/** 무리(옷차림)와 바탕에 맞는 동물(시안 animalKinds). */
export function animalKinds(style: string, terrain: Terrain): string[] {
  if (style === 'east-buyeo') return ['horse', 'ox', 'pig', 'dog'];
  if (terrain === 'steppe') return ['sheep', 'sheep', 'horse', 'horse', 'dog'];
  if (terrain === 'dry') return ['camel', 'camel', 'sheep', 'dog'];
  if (terrain === 'paddy' || terrain === 'nanzhong' || groupOf(style) === 'south')
    return ['buffalo', 'buffalo', 'pig', 'chicken'];
  if (terrain === 'mountain') return ['ox', 'pig', 'chicken'];
  if (terrain === 'forest') return ['dog', 'pig', 'horse'];
  if (terrain === 'coast' || terrain === 'river') return ['dog', 'chicken', 'chicken'];
  return ['dog', 'chicken', 'ox'];
}

/**
 * 시설마다 나오는 사람(사용자 2026-11-17: "시설을 지으면 그에 맞는 사람이 나오게 해줘", "부두 같은 시설을 세우면 그에 맞는 사람").
 * 첫 사람은 그 시설 인물(지역 꾸러미 role 대사를 한다). 단계마다 한 사람씩 더 나온다(목록을 돌며, 최대 4).
 * 물가 시설(나루, 조선소, 어시장, 화선)은 뱃사람과 어부가 나온다.
 */
export const FACILITY_CREW: Readonly<Record<string, readonly string[]>> = {
  // 태수부: 아전과 문지기 병사(성 화면이 슬롯 대신 따로 넣는다)
  palace: ['clerk', 'soldier', 'clerk', 'soldier'],
  office: ['clerk', 'clerk', 'villager'],
  tally: ['clerk', 'soldier'],
  market: ['peddler', 'woman', 'villager', 'porter'],
  grand_market: ['peddler', 'cart', 'woman', 'peddler'],
  mint: ['worker', 'clerk', 'soldier'],
  black_market: ['peddler', 'villager'],
  house: ['woman', 'child', 'villager', 'elder'],
  patrol: ['soldier', 'soldier'],
  shrine: ['elder', 'woman', 'villager'],
  academy: ['scholar', 'scholar', 'child'],
  clinic: ['elder', 'woman', 'villager'],
  tavern: ['woman', 'villager', 'peddler'],
  smith: ['worker', 'porter'],
  workshop: ['worker', 'porter', 'worker'],
  arsenal: ['clerk', 'soldier', 'porter'],
  bronze_terrace: ['elder', 'scholar', 'soldier'],
  farm: ['villager', 'farmer'],
  granary: ['clerk', 'porter', 'cart', 'porter'],
  military_farm: ['soldier', 'farmer', 'soldier'],
  irrigation: ['villager', 'farmer'],
  saltworks: ['porter', 'worker', 'porter'],
  ironworks: ['worker', 'porter', 'cart', 'worker'],
  fish_market: ['fisher', 'woman', 'peddler', 'fisher'],
  shipyard: ['worker', 'fisher', 'porter', 'worker'],
  barracks: ['soldier', 'soldier', 'soldier', 'soldier'],
  drill_ground: ['soldier', 'soldier', 'soldier'],
  stable: ['herder', 'soldier', 'herder'],
  camp: ['soldier', 'soldier', 'soldier'],
  fort: ['soldier', 'soldier'],
  citadel: ['soldier', 'soldier', 'soldier'],
  bastion: ['soldier', 'soldier'],
  crossbow_tower: ['soldier'],
  repeating_tower: ['soldier'],
  catapult: ['soldier', 'worker'],
  drum: ['soldier'],
  band: ['villager', 'woman', 'child'],
  stone_maze: ['scholar'],
  beacon: ['soldier'],
  earthwork: ['soldier', 'worker'],
  stone_wall: ['worker', 'soldier'],
  palisade: ['soldier'],
  fire_seed: ['soldier'],
  fire_ball: ['soldier'],
  fire_ship: ['fisher', 'soldier', 'fisher'],
  rockfall: ['soldier'],
  dam: ['worker', 'villager'],
  bridge: ['villager', 'cart', 'porter'],
  ferry: ['fisher', 'porter', 'villager', 'cart'],
};
/** 시설에 딸린 짐승(마구간 말, 밭 소, 물가 밭 물소). */
const FACILITY_ANIMALS: Readonly<Record<string, readonly string[]>> = {
  stable: ['horse', 'horse', 'horse'],
  farm: ['ox'],
  irrigation: ['buffalo'],
  military_farm: ['ox'],
  camp: ['horse'],
};

/** 성 안팎 사람과 동물. 수는 시안처럼 민가와 시장 단계, 상황에 따라 늘고 준다. */
export function populate(
  layout: CastleLayout,
  slots: readonly LifeSlot[],
  opts: { style: string; terrain: Terrain; conds: readonly string[] },
): { walkers: Walker[]; actors: Actor[]; net: RoadNet; fronts: Map<string, number[]> } {
  const net = roadNet(layout);
  const fronts = slotFronts(net, slots);
  const walkers: Walker[] = [];
  const actors: Actor[] = [];
  let seed = 7;
  // 집을 정해 그 자리에서 시작한다. 처음 갈 곳은 첫 틀에 고른다(쉬는 시간은 사람마다 엇갈리게).
  const add = (kind: string, home: number, role?: string) => {
    if (home < 0) return;
    seed = (seed * 48271) % 2147483647;
    walkers.push({
      kind,
      path: [net.pts[home]!],
      speed: moveOf(kind).speed,
      s: 0,
      loop: false,
      role,
      home,
      at: home,
      rest: seed % 90,
      seed,
    });
  };
  const homeIn = (area: Area, n: number) => {
    const houses = (fronts.get('house') ?? []).filter((h) => area === 'both' || (area === 'inside') === net.inside[h]);
    if (houses.length) return houses[n % houses.length]!;
    const any = net.pts.map((_, k) => k).filter((k) => area === 'both' || (area === 'inside') === net.inside[k]);
    return any.length ? any[(n * 7) % any.length]! : -1;
  };
  const outsideHome = (n: number) => {
    const list = net.edge.length ? net.edge : net.pts.map((_, k) => k).filter((k) => !net.inside[k]);
    return list.length ? list[(n * 5) % list.length]! : -1;
  };
  const levelOf = (key: string) =>
    slots.filter((s) => s.building === key && !s.pending).reduce((m, s) => Math.max(m, s.level), 0);
  const cs = new Set(opts.conds);
  let crowd = 2 + levelOf('house') * 2 + levelOf('market') * 2;
  if (cs.has('plague') || cs.has('battle') || cs.has('ruin')) crowd = Math.ceil(crowd / 2);
  if (cs.has('harvest') || cs.has('boom')) crowd += 3;
  const kinds = ['villager', 'woman', 'villager', 'porter'];
  for (let n = 0; n < crowd; n++)
    add(kinds[n % 4]!, homeIn(moveOf(kinds[n % 4]!).area === 'inside' ? 'inside' : 'both', n));
  add('child', homeIn('inside', 1));
  if (levelOf('house') >= 2) add('child', homeIn('inside', 2));
  add('elder', homeIn('inside', 3));
  if (levelOf('market')) add('peddler', net.gates[0]?.outer ?? homeIn('both', 4));
  if (levelOf('market') || levelOf('workshop')) add('cart', net.gates[0]?.inner ?? homeIn('both', 5));
  if (levelOf('farm') || levelOf('granary')) add('cart', net.gates[0]?.outer ?? homeIn('both', 6));
  const t = opts.terrain;
  if (t === 'coast' || t === 'river') add('fisher', outsideHome(1));
  if (t === 'mountain' || t === 'forest') add('hunter', outsideHome(2));
  if (t === 'steppe' || t === 'dry') add('herder', outsideHome(3));
  // 순찰병: 성벽 안 둘레를 계속 돈다(성문 수만큼 더, 전투 때 더).
  if (layout.inner) {
    const ring = ringPath(0.5, layout.inner - 0.5);
    const guards = 1 + layout.gateSides.length + (cs.has('battle') ? 5 : 0);
    for (let n = 0; n < guards; n++)
      walkers.push({
        kind: 'soldier',
        path: ring,
        speed: 0.01,
        s: n * 12,
        loop: true,
        home: 0,
        at: 0,
        rest: 0,
        seed: n + 1,
      });
  }
  if (cs.has('battle') || cs.has('unsupplied')) for (let n = 0; n < 3; n++) add('soldier', net.gates[0]?.inner ?? -1);
  // 건물 인물: 지은 건물 앞이 집이다. 공사 중이면 일꾼과 짐꾼.
  for (const s of slots) {
    if (!s.building) continue;
    if (s.pending) {
      for (let m = 0; m < 3; m++)
        actors.push({
          kind: 'worker',
          i: s.a + 3 * (0.3 + 0.3 * m),
          j: s.b + 3 * (0.8 - 0.25 * m),
          row: m,
          rate: 4 + m,
          building: s.building,
        });
      for (let m = 0; m < 2; m++)
        walkers.push({
          kind: 'porter',
          path: frontOf(s),
          speed: 0.02,
          s: m * 2.5,
          loop: true,
          home: 0,
          at: 0,
          rest: 0,
          seed: m + 3,
        });
      continue;
    }
    if (s.building === 'farm' || s.building === 'military_farm')
      for (let m = 0; m < s.level + 1; m++)
        actors.push({
          kind: 'farmer',
          i: s.a + 3 * (0.3 + 0.2 * m),
          j: s.b + 3 * (0.35 + 0.15 * (m % 2)),
          row: m % 2,
          rate: 6 + m,
        });
    const front = nearest(net, [s.a + 3.5, s.b + 3.5], s.zone === 'inside' ? 'inside' : 'outside');
    if (front < 0) continue;
    // 시설 인물(첫 사람, role 대사)과 단계마다 한 사람씩 더
    const crew = FACILITY_CREW[s.building] ?? (ROLE_KIND[s.building] ? [ROLE_KIND[s.building]!] : []);
    const count = Math.min(4, Math.max(1, s.level + (crew.length > 1 ? 1 : 0)));
    for (let n = 0; n < count && crew.length; n++) {
      const kind = n === 0 ? (ROLE_KIND[s.building] ?? crew[0]!) : crew[n % crew.length]!;
      add(kind, front, n === 0 ? s.building : undefined);
      const w = walkers[walkers.length - 1]!;
      w.work = s.building;
      // 일터가 그 종류의 다닐 곳 밖이면(성 밖 어시장의 아낙 등) 둘 다 다닌다.
      const area = moveOf(kind).area;
      if (area !== 'both' && (area === 'inside') !== net.inside[front]) w.area = 'both';
    }
    for (const k of (FACILITY_ANIMALS[s.building] ?? []).slice(0, s.level)) {
      add(k, front);
      walkers[walkers.length - 1]!.area = 'outside';
    }
  }
  // 동물: 민가 앞이 집(성 밖에서만 노는 동물은 성 밖 가장자리).
  animalKinds(opts.style, opts.terrain).forEach((k, n) => {
    if (!(ANIMALS as readonly string[]).includes(k)) return;
    add(k, moveOf(k).area === 'outside' ? outsideHome(n + 4) : homeIn('both', n));
  });
  // 집이 다닐 곳 밖이면(성 안에 집이 있는 성 밖 동물 등) 가장 가까운 다닐 곳으로 옮긴다.
  for (const w of walkers) {
    const area = w.area ?? moveOf(w.kind).area;
    if (w.loop || area === 'both' || (area === 'inside') === net.inside[w.home]) continue;
    const n = nearest(net, net.pts[w.home]!, area);
    if (n >= 0) {
      w.home = n;
      w.at = n;
      w.path = [net.pts[n]!];
    } else w.speed = 0;
  }
  return { walkers, actors, net, fronts };
}

/** 사람이 슬롯 그림보다 앞인가. 슬롯 앞쪽 변(오른쪽 아래 i = a + 3, 왼쪽 아래 j = b + 3)을 넘었으면 앞. */
export const personInFront = (p: { i: number; j: number }, s: { a: number; b: number }) =>
  p.i >= s.a + 3 || p.j >= s.b + 3;

/** 성벽 띠: 성 안, 성벽 앞(앞쪽 벽보다 나중), 성벽 뒤. */
export function personBand(layout: CastleLayout, p: { i: number; j: number }): 'behind' | 'inside' | 'front' {
  if (!layout.wall) return 'front';
  const far = layout.inner + 1;
  if (p.i >= far || p.j >= far) return 'front';
  if (p.i >= 0 && p.j >= 0 && p.i <= layout.inner && p.j <= layout.inner) return 'inside';
  return 'behind';
}
