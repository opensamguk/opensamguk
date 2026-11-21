// 거점별 육지 구역: 땅을 1단위 격자로 깔고, 거점에서 물길 비용을 더한 거리로 넓혀 나눈다.
import fs from 'node:fs';
import { REPO as R, S } from './paths.mjs';
const data = JSON.parse(fs.readFileSync(`${S}/data/data2.json`, 'utf8'));
const W = 1400,
  H = 1000;
const REACH = 95,
  RIVER = 16,
  SEA_PAD = 6,
  TOL = 0.9;
const at = (x, y) => y * W + x;

// ── 땅 격자
const rings = (d) =>
  d
    .split(/(?=M)/)
    .map((seg) => (seg.match(/-?\d+\.?\d*,-?\d+\.?\d*/g) ?? []).map((p) => p.split(',').map(Number)))
    .filter((r) => r.length > 2);
const land = new Uint8Array(W * H);
const rows = Array.from({ length: H }, () => []);
const fillRing = (ring) => {
  const xs = Array.from({ length: H }, () => null);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i],
      [x2, y2] = ring[j];
    const a = Math.min(y1, y2),
      c = Math.max(y1, y2);
    for (let y = Math.max(0, Math.ceil(a - 0.5)); y < Math.min(H, Math.ceil(c - 0.5)); y++) {
      const t = (y + 0.5 - y1) / (y2 - y1);
      (xs[y] ??= []).push(x1 + (x2 - x1) * t);
    }
  }
  for (let y = 0; y < H; y++) {
    const l = xs[y];
    if (!l) continue;
    l.sort((p, q) => p - q);
    for (let k = 0; k + 1 < l.length; k += 2)
      for (let x = Math.max(0, Math.ceil(l[k] - 0.5)); x < Math.min(W, Math.ceil(l[k + 1] - 0.5)); x++)
        land[at(x, y)] = 1;
  }
};
for (const d of data.land) for (const r of rings(d)) fillRing(r);
void rows;

// 바탕 지도에 없는 섬은 작은 원으로 더한다
const islands = [];
const sites = data.sites.map((s, i) => ({
  name: s[0],
  x: Math.round(s[1]),
  y: Math.round(s[2]),
  kind: s[3],
  level: s[4] || 2,
  src: s[6],
  label: i + 1,
}));
for (const s of sites) {
  if (land[at(s.x, s.y)]) continue;
  let near = false;
  for (let r = 1; r <= 3 && !near; r++)
    for (let a = 0; a < 16; a++) {
      const x = Math.round(s.x + r * Math.cos((a * Math.PI) / 8)),
        y = Math.round(s.y + r * Math.sin((a * Math.PI) / 8));
      if (land[at(x, y)]) {
        near = true;
        break;
      }
    }
  if (near) continue;
  islands.push({ name: s.name, x: s.x, y: s.y, r: 5 });
  for (let y = s.y - 5; y <= s.y + 5; y++)
    for (let x = s.x - 5; x <= s.x + 5; x++) if (Math.hypot(x - s.x, y - s.y) <= 5) land[at(x, y)] = 1;
}

// ── 큰 강: 건너는 데 비용을 물린다
const ne = JSON.parse(fs.readFileSync(`${R}/apps/web/src/mapEditor/geodata/natural-earth.json`, 'utf8'));
const BIG = /^(Yellow|Huang|Huang He|Yangtze|Chang Jiang|Jinsha)/i;
const river = new Uint8Array(W * H);
for (const r of ne.rivers.filter((x) => BIG.test(x.name ?? ''))) {
  for (const seg of r.path.split(/(?=M)/)) {
    const pts = (seg.match(/-?\d+\.?\d*,-?\d+\.?\d*/g) ?? []).map((p) => p.split(',').map(Number));
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1],
        [x2, y2] = pts[i];
      const yy1 = y1 + 260,
        yy2 = y2 + 260; // 강 자료의 y는 260 어긋나 있다
      const n = Math.ceil(Math.hypot(x2 - x1, yy2 - yy1)) + 1;
      for (let k = 0; k <= n; k++) {
        const x = Math.round(x1 + ((x2 - x1) * k) / n),
          y = Math.round(yy1 + ((yy2 - yy1) * k) / n);
        if (x >= 0 && x < W && y >= 0 && y < H) river[at(x, y)] = 1;
      }
    }
  }
}

// ── 거리 넓히기
const label = new Uint16Array(W * H);
const dist = new Float32Array(W * H).fill(Infinity);
const weight = (s) => (s.kind === 'P' ? 0 : s.level * 2.4);
const order = sites.slice().sort((a, c) => weight(c) - weight(a));
class Heap {
  // 작은 값 우선
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const kk = k.pop(),
      vv = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= kk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = kk;
      v[i] = vv;
    }
    return top;
  }
}
const heap = new Heap();
const startOf = new Float32Array(sites.length + 1);
for (const s of order) {
  startOf[s.label] = -weight(s);
  // 어느 거점이든 자기 둘레 작은 땅은 지킨다
  const SEED = land[at(s.x, s.y)] ? 3 : 5;
  for (let y = s.y - SEED; y <= s.y + SEED; y++)
    for (let x = s.x - SEED; x <= s.x + SEED; x++) {
      if (Math.hypot(x - s.x, y - s.y) > SEED || x < 0 || y < 0 || x >= W || y >= H) continue;
      const c = at(x, y);
      if (!land[c] || label[c]) continue;
      label[c] = s.label;
      dist[c] = -weight(s) + Math.hypot(x - s.x, y - s.y);
      heap.push(dist[c], c);
    }
}
const fixed = new Uint8Array(W * H);
for (let c = 0; c < label.length; c++) if (label[c]) fixed[c] = 1;
const NB = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];
const cap = new Float32Array(sites.length + 1).fill(REACH);
const grow = () => {
  while (heap.size) {
    const c = heap.pop();
    const d0 = dist[c],
      x0 = c % W,
      y0 = (c - x0) / W;
    const l = label[c];
    if (!l || d0 - startOf[l] > cap[l]) continue;
    for (const [dx, dy, w] of NB) {
      const x = x0 + dx,
        y = y0 + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const n = at(x, y);
      if (!land[n] || fixed[n]) continue;
      const nd = d0 + w * (river[n] ? 3 : 1) + (river[n] !== river[c] ? RIVER / 2 : 0);
      if (nd - startOf[l] > cap[l]) continue;
      if (nd < dist[n]) {
        dist[n] = nd;
        label[n] = l;
        heap.push(nd, n);
      }
    }
  }
};
grow();
// 끼인 거점의 띠 다듬기: 자기 넓이에 비해 너무 멀리 뻗은 땅을 놓아 이웃이 갖게 한다.
// 받을 이웃이 없으면 원래 구역으로 돌아가므로 반도와 회랑처럼 실제로 긴 땅은 그대로 남는다.
const FAR = 2.0,
  MINCAP = 14;
const orig = new Uint16Array(W * H);
const a0 = new Int32Array(sites.length + 1);
for (let c = 0; c < label.length; c++) if (label[c]) a0[label[c]]++;
const limit = new Float32Array(sites.length + 1);
for (let l = 1; l <= sites.length; l++) limit[l] = Math.max(MINCAP, FAR * Math.sqrt(a0[l] / Math.PI));
let released = 0;
for (let c = 0; c < label.length; c++) {
  const l = label[c];
  if (!l || fixed[c] || dist[c] - startOf[l] <= limit[l]) continue;
  orig[c] = l;
  label[c] = 0;
  dist[c] = Infinity;
  released++;
}
// 놓은 땅은 맞닿은 다른 구역이 받는다. 자기 땅이었던 곳은 다시 받지 못한다.
for (let c = 0; c < label.length; c++) {
  if (!label[c]) continue;
  const x0 = c % W,
    y0 = (c - x0) / W;
  for (const [dx, dy] of NB) {
    const x = x0 + dx,
      y = y0 + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const n = at(x, y);
    if (orig[n] && !label[n] && orig[n] !== label[c]) {
      heap.push(dist[c], c);
      break;
    }
  }
}
while (heap.size) {
  const c = heap.pop();
  const l = label[c],
    d0 = dist[c],
    x0 = c % W,
    y0 = (c - x0) / W;
  for (const [dx, dy, w] of NB) {
    const x = x0 + dx,
      y = y0 + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const n = at(x, y);
    if (!orig[n] || orig[n] === l) continue;
    const nd = d0 + w * (river[n] ? 3 : 1) + (river[n] !== river[c] ? RIVER / 2 : 0);
    if (nd < dist[n]) {
      dist[n] = nd;
      label[n] = l;
      heap.push(nd, n);
    }
  }
}
// 맞닿은 다른 구역이 없는 땅(반도·회랑)은 원래 구역으로 돌아간다
let returned = 0;
for (let c = 0; c < label.length; c++)
  if (!label[c] && orig[c]) {
    label[c] = orig[c];
    returned++;
  }
console.log('released', released, 'returned', returned);
// 거점과 이어지지 않은 조각은 가장 길게 맞닿은 다른 구역에 붙인다. 다른 구역과 닿지 않으면(섬) 그대로 둔다.
let merged = 0;
for (let pass = 0; pass < 3; pass++) {
  const seen = new Uint8Array(W * H);
  const seedOf = new Int32Array(sites.length + 1).fill(-1);
  for (const s of sites) {
    let best = -1;
    for (let r = 0; r <= 5 && best < 0; r++)
      for (let y = s.y - r; y <= s.y + r && best < 0; y++)
        for (let x = s.x - r; x <= s.x + r; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          if (label[at(x, y)] === s.label) {
            best = at(x, y);
            break;
          }
        }
    seedOf[s.label] = best;
  }
  const moves = [];
  for (let c = 0; c < label.length; c++) {
    if (!label[c] || seen[c]) continue;
    const l = label[c];
    const cells = [];
    const q = [c];
    seen[c] = 1;
    let hasSeed = false;
    const touch = new Map();
    while (q.length) {
      const v = q.pop();
      cells.push(v);
      if (v === seedOf[l]) hasSeed = true;
      const x0 = v % W,
        y0 = (v - x0) / W;
      for (const [dx, dy] of NB) {
        const x = x0 + dx,
          y = y0 + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const n = at(x, y);
        if (!label[n]) continue;
        if (label[n] === l) {
          if (!seen[n]) {
            seen[n] = 1;
            q.push(n);
          }
        } else touch.set(label[n], (touch.get(label[n]) ?? 0) + 1);
      }
    }
    if (hasSeed || !touch.size) continue;
    moves.push([cells, [...touch.entries()].sort((p, r) => r[1] - p[1])[0][0]]);
  }
  for (const [cells, to] of moves) {
    for (const v of cells) label[v] = to;
    merged += cells.length;
  }
  if (!moves.length) break;
}
console.log('merged fragment cells', merged);

// 면적 집계
const area = new Int32Array(sites.length + 1);
let landCells = 0,
  claimed = 0;
for (let c = 0; c < label.length; c++) {
  if (land[c]) {
    landCells++;
    if (label[c]) {
      claimed++;
      area[label[c]]++;
    }
  }
}

// ── 해안선을 바탕 지도로 자르도록 바다로 조금 넓힌다
const grid = label.slice();
let frontier = [];
for (let c = 0; c < grid.length; c++) if (grid[c]) frontier.push(c);
for (let pass = 0; pass < SEA_PAD; pass++) {
  const next = [];
  for (const c of frontier) {
    const x0 = c % W,
      y0 = (c - x0) / W;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = x0 + dx,
        y = y0 + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const n = at(x, y);
      if (land[n] || grid[n]) continue;
      grid[n] = grid[c];
      next.push(n);
    }
  }
  frontier = next;
}

// ── 경계선 그리기: 꼭짓점을 공유하도록 줄인다
const VW = W + 1;
const vid = (x, y) => y * VW + x;
const vx = (v) => v % VW,
  vy = (v) => (v - vx(v)) / VW;
const cell = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : grid[at(x, y)]);
const adj = new Map();
const link = (a, b) => {
  if (!adj.has(a)) adj.set(a, []);
  adj.get(a).push(b);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(b).push(a);
};
for (let y = 0; y <= H; y++)
  for (let x = 0; x <= W; x++) {
    if (x < W && cell(x, y) !== cell(x, y - 1)) link(vid(x, y), vid(x + 1, y));
    if (y < H && cell(x, y) !== cell(x - 1, y)) link(vid(x, y), vid(x, y + 1));
  }
const keep = new Set();
const dp = (pts, a, c) => {
  if (c <= a + 1) return;
  const [x1, y1] = [vx(pts[a]), vy(pts[a])],
    [x2, y2] = [vx(pts[c]), vy(pts[c])];
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  let m = -1,
    md = 0;
  for (let i = a + 1; i < c; i++) {
    const d = Math.abs((x2 - x1) * (y1 - vy(pts[i])) - (x1 - vx(pts[i])) * (y2 - y1)) / len;
    if (d > md) {
      md = d;
      m = i;
    }
  }
  if (md > TOL) {
    keep.add(pts[m]);
    dp(pts, a, m);
    dp(pts, m, c);
  }
};
const seen = new Set();
const ekey = (a, b) => (a < b ? a * 2000000 + b : b * 2000000 + a);
for (const [v, list] of adj) if (list.length !== 2) keep.add(v);
const walk = (start, first) => {
  const pts = [start];
  let p = start,
    c = first;
  seen.add(ekey(p, c));
  while (true) {
    pts.push(c);
    if (keep.has(c) && adj.get(c).length !== 2) break;
    const n = adj.get(c).find((q) => q !== p && !seen.has(ekey(c, q))) ?? null;
    if (n == null) break;
    seen.add(ekey(c, n));
    p = c;
    c = n;
    if (c === start) {
      pts.push(c);
      break;
    }
  }
  return pts;
};
for (const [v, list] of adj) {
  if (list.length === 2) continue;
  for (const n of list) {
    if (seen.has(ekey(v, n))) continue;
    const pts = walk(v, n);
    dp(pts, 0, pts.length - 1);
  }
}
for (const [v, list] of adj) {
  if (list.length !== 2 || seen.has(ekey(v, list[0]))) continue;
  const pts = walk(v, list[0]);
  keep.add(v);
  const mid = pts[Math.floor(pts.length / 2)];
  keep.add(mid);
  const m = pts.indexOf(mid);
  dp(pts, 0, m);
  dp(pts, m, pts.length - 1);
}

// 칸을 왼쪽에 두고 도는 고리
const paths = new Array(sites.length + 1).fill('');
const rel = (ring) => {
  let s = '';
  let px = 0,
    py = 0;
  ring.forEach((v, i) => {
    const x = vx(v),
      y = vy(v);
    s += i === 0 ? `M${x},${y}` : `l${x - px},${y - py}`;
    px = x;
    py = y;
  });
  return s + 'z';
};
const edgesByLabel = new Map();
const addE = (l, a, b) => {
  if (!l) return;
  if (!edgesByLabel.has(l)) edgesByLabel.set(l, new Map());
  const m = edgesByLabel.get(l);
  if (!m.has(a)) m.set(a, []);
  m.get(a).push(b);
};
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const l = grid[at(x, y)];
    if (!l) continue;
    if (cell(x, y - 1) !== l) addE(l, vid(x + 1, y), vid(x, y));
    if (cell(x, y + 1) !== l) addE(l, vid(x, y + 1), vid(x + 1, y + 1));
    if (cell(x - 1, y) !== l) addE(l, vid(x, y), vid(x, y + 1));
    if (cell(x + 1, y) !== l) addE(l, vid(x + 1, y + 1), vid(x + 1, y));
  }
let pieces = 0,
  ptsTotal = 0;
const allRings = [];
for (const [l, m] of edgesByLabel) {
  for (const [a0, list] of m) {
    while (list.length) {
      const ring = [a0];
      let cur = list.pop();
      let guard = 0;
      while (cur !== a0 && guard++ < 2e6) {
        ring.push(cur);
        const nx = m.get(cur);
        if (!nx || !nx.length) break;
        cur = nx.pop();
      }
      allRings.push([l, ring]);
    }
  }
}
for (const [, ring] of allRings) {
  if (ring.filter((v) => keep.has(v)).length >= 3 || ring.length < 6) continue;
  for (let i = 0; i < 4; i++) keep.add(ring[Math.floor((ring.length * i) / 4)]);
}
for (const [l, ring] of allRings) {
  const kept = ring.filter((v) => keep.has(v));
  if (kept.length >= 3) {
    paths[l] += rel(kept);
    pieces++;
    ptsTotal += kept.length;
  }
}

const zones = sites.map((s) => [s.name, paths[s.label], area[s.label]]);
const small = sites.filter((s) => area[s.label] < 40).map((s) => `${s.name}:${area[s.label]}`);
const biggest = sites
  .slice()
  .sort((a, c) => area[c.label] - area[a.label])
  .slice(0, 12)
  .map((s) => `${s.name}:${area[s.label]}`);
// 나중에 구역을 더 나눌 수 있도록 격자도 남긴다(행 단위 길이 압축, 바다 확장 전)
const rle = [];
for (let y = 0; y < H; y++) {
  let x = 0;
  const row = [];
  while (x < W) {
    const l = label[at(x, y)];
    let n = 1;
    while (x + n < W && label[at(x + n, y)] === l) n++;
    if (l) row.push(x, n, l);
    x += n;
  }
  rle.push(row);
}
fs.writeFileSync(
  `${S}/data/zones-grid.json`,
  JSON.stringify({
    width: W,
    height: H,
    cell: 1,
    rule: { REACH, RIVER, weight: 'level*2.4, 관문 0' },
    sites: sites.map((s) => s.name),
    rows: rle,
  }),
);
const out = {
  zones,
  islands,
  stat: {
    landCells,
    claimed,
    reach: REACH,
    river: RIVER,
    pieces,
    pts: ptsTotal,
    small,
    biggest,
    noZone: zones.filter((z) => !z[1]).map((z) => z[0]),
  },
};
fs.writeFileSync(`${S}/data/zones.json`, JSON.stringify(out));
console.log(
  JSON.stringify(out.stat),
  'islands',
  JSON.stringify(islands),
  'KB',
  Math.round(JSON.stringify(out).length / 1024),
);
