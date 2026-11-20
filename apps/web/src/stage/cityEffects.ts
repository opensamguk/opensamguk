// 성 화면 상황 효과(시안 castle-panorama의 상황 덧칠, 메뚜기, 불길, 화살, 연기, 전투 병사를 옮김, 2026-11-17).
// 상황은 CityScene의 conditions로 받는다. 전투 병사는 성문 밖 길에서 성문으로 몰려온다.
import type { CastleLayout } from './castleGeometry';

type Proj = (i: number, j: number, z?: number) => [number, number];
export const FACTION = { us: '#2a56b8', them: '#b8321e' } as const;
const TINT: Readonly<Record<string, string>> = {
  flood: 'rgba(60,120,200,0.14)',
  plague: 'rgba(110,130,70,0.14)',
  cold: 'rgba(235,245,255,0.18)',
  battle: 'rgba(200,60,30,0.10)',
  ruin: 'rgba(40,30,20,0.22)',
  typhoon: 'rgba(90,100,120,0.16)',
  quake: 'rgba(120,100,70,0.10)',
};
/** 전투, 폐허 때 불타는 건물(시안과 같은 종류). */
const BURN = new Set(['farm', 'granary', 'ironworks', 'palisade', 'military_farm', 'house', 'market', 'tavern']);

interface FolkLike {
  i: number;
  j: number;
  band: 'behind' | 'inside' | 'front';
  img: HTMLImageElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  size: number;
  banner?: string | undefined;
}

/** 성문 밖에서 몰려오는 적과 성벽 안 아군 궁병(시안 battleUnits). 첫 성문 쪽에 그린다. */
export function battleFolk(
  layout: CastleLayout,
  tick: number,
  load: (url: string) => HTMLImageElement | null,
  art: (source: string) => string | null,
): FolkLike[] {
  if (!layout.wall) return [];
  const out: FolkLike[] = [];
  const side = layout.gateSides[0] ?? 'R';
  const g = layout.gate + 0.5;
  const far = layout.inner + 1;
  // 성문 쪽 축으로 바꾼다: u는 성벽에서 바깥으로 멀어지는 거리, v는 벽을 따라가는 자리.
  const at = (u: number, v: number): [number, number] =>
    side === 'R' ? [far + u, v] : side === 'L' ? [v, far + u] : side === 'BR' ? [v, -1 - u] : [-1 - u, v];
  const T = tick * 0.012;
  const unit = (
    file: string,
    cols: number,
    row: number,
    u: number,
    v: number,
    rate: number,
    banner: string,
    size = 0.5,
  ) => {
    const url = art(`city/battle/${file}.webp`);
    const img = url ? load(url) : null;
    if (!img) return;
    const cell = img.width / cols;
    const [i, j] = at(u, v);
    const f = Math.floor(tick / rate + u * 3 + v) % cols;
    out.push({ i, j, band: 'front', img, sx: f * cell, sy: row * cell, sw: cell, sh: cell, size, banner });
  };
  // 그림 줄: 0 SE, 3 NW. 적은 성문을 향해(바깥에서 안으로) 걸으니 성문 쪽 방향 줄을 쓴다.
  const toward = side === 'R' || side === 'L' ? 3 : 0;
  for (let n = 0; n < 8; n++) {
    const prog = (T + n * 0.6) % 6;
    const u = 7 - prog;
    if (u > 0.6) unit('spear-walk', 4, toward, u, g - 0.6 + (n % 3) * 0.6, 4, FACTION.them);
    else unit('spear-attack', 4, toward, 0.4 + (n % 2) * 0.3, g - 0.6 + (n % 3) * 0.6, 3, FACTION.them);
  }
  for (let n = 0; n < 4; n++) unit('archer-shoot', 4, toward, 2.5 + (n % 2) * 0.6, g - 3 + n * 1.8, 5, FACTION.them);
  for (let n = 0; n < 2; n++)
    unit('ladder-run', 4, toward, 3.5 - ((T * 0.8 + n * 0.5) % 3), g + 2.5 + n * 1.4, 3, FACTION.them);
  unit('ram-push', 2, toward, 6.6 - Math.min((T * 0.4) % 9, 6.2), g, 6, FACTION.them, 0.65);
  return out;
}

/** 상황 덧칠과 메뚜기, 불길과 연기, 화살. 장면을 다 그린 뒤 위에 얹는다. */
export function drawConditions(
  ctx: CanvasRenderingContext2D,
  o: {
    conditions: readonly string[];
    tick: number;
    view: Proj;
    cw: number;
    layout: CastleLayout;
    lots: ReadonlyArray<{ a: number; b: number; building: string | null; pending: boolean }>;
    W: number;
    H: number;
    fire: HTMLImageElement | null;
  },
) {
  const cs = new Set(o.conditions);
  if (!cs.size) return;
  const { tick, view: S, cw } = o;
  // 불타는 건물
  if (cs.has('battle') || cs.has('ruin'))
    for (const lot of o.lots
      .filter((l) => l.building && !l.pending && BURN.has(l.building))
      .slice(0, cs.has('ruin') ? 8 : 4)) {
      const [cx, cy] = S(lot.a + 1.5, lot.b + 1.5);
      fireAt(ctx, cx, cy, cw * 1.2, lot.a * 7 + lot.b, tick);
    }
  for (const c of cs) {
    const tint = TINT[c];
    if (tint) {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, o.W, o.H);
    }
  }
  if (cs.has('locust')) {
    ctx.fillStyle = 'rgba(40,35,10,0.75)';
    for (let n = 0; n < 260; n++) {
      const x = (n * 397 + tick * (3 + (n % 5))) % o.W;
      const y = (n * 211 + Math.sin((tick + n) / 9) * 40 + 200) % o.H;
      ctx.fillRect(x, y, 3, 2);
    }
  }
  if (cs.has('battle') && o.layout.wall) {
    // 성벽 너머로 오가는 화살
    const far = o.layout.inner + 1;
    ctx.strokeStyle = 'rgba(40,30,20,0.85)';
    ctx.lineWidth = Math.max(1, cw / 60);
    for (let n = 0; n < 18; n++) {
      const t = (tick * 0.04 + n * 0.37) % 1;
      const out = n % 2 === 0;
      const a = S(far - 0.6, 1 + (n % 9) * (o.layout.inner / 9));
      const b = S(far + 3 + (n % 4), 2 + (n % 5));
      const [x0, y0] = out ? a : b;
      const [x1, y1] = out ? b : a;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * cw * 0.9;
      const dx = (x1 - x0) * 0.02;
      const dy = (y1 - y0) * 0.02 - Math.cos(t * Math.PI) * 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - dx * 2, y - dy * 2);
      ctx.stroke();
    }
  }
}

/** 일렁이는 불꽃과 위로 오르는 연기(시안 drawFire). */
function fireAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, seed: number, tick: number) {
  const k = w / 120;
  for (let n = 0; n < 7; n++) {
    const sx = Math.sin(seed + n * 1.7) * w * 0.4;
    const ph = (tick * 0.35 + n * 1.3 + seed) % (Math.PI * 2);
    const x = cx + sx;
    const y = cy - Math.abs(Math.cos(n)) * 10 * k;
    const hh = (34 + 18 * Math.sin(ph)) * k;
    const ww = (14 + 6 * Math.cos(ph * 1.3)) * k;
    const g = ctx.createRadialGradient(x, y - hh * 0.4, 1, x, y - hh * 0.4, hh);
    g.addColorStop(0, 'rgba(255,240,150,0.95)');
    g.addColorStop(0.4, 'rgba(255,150,30,0.85)');
    g.addColorStop(1, 'rgba(200,40,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y - hh * 0.45, ww, hh, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let n = 0; n < 5; n++) {
    const t = (tick * 0.012 + n * 0.2 + seed * 0.001) % 1;
    const x = cx + Math.sin(n + tick * 0.02) * 20 * k + t * 30 * k;
    const y = cy - 50 * k - t * 260 * k;
    ctx.fillStyle = `rgba(70,65,60,${0.45 * (1 - t)})`;
    ctx.beginPath();
    ctx.arc(x, y, (18 + t * 40) * k, 0, Math.PI * 2);
    ctx.fill();
  }
}
