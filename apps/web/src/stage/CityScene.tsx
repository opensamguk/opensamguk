// 성 화면과 진영 화면의 바탕(D-106). 사용자 2026-11-15:
// "성이 중간에 있고, 그 성 바깥에 9*9 정도의 땅이 있다고 생각하자. 성 등급에 따라 땅 크기나 갯수가 달라지는거야. 성벽을 두르지 말고.",
// "중간 성 아이콘은 지금 전체 지도 아이콘 그거 그냥 쓰자", "경, 특, 대, 중, 소, 현. 이렇게 가지.",
// "성 안에 지을 수 있는 건물과 성 밖에 지을 수 있는 건물, 그리고 성이 차지하는 크기도 다르게 하자"(→ 성은 작게, 땅은 넓게), "이대로 가자".
// 2026-11-16 슬롯 방식으로 바꿈(기획 docs/design/castle-panorama-plan.md, 사용자 "슬롯 방식으로 가자", "작업 시작해"):
// 서버 땅 슬롯 하나가 3×3칸 받침 하나이고, 성 안 슬롯은 성벽 안, 성 밖 슬롯은 성벽 밖 둘레 길 너머에 놓는다.
// 성벽(성가퀴, 치, 성문, 문루)은 castleGeometry가 칸 단위 상자로 계산해 캔버스에 그린다.
// 1440×900 설계 좌표를 캔버스(object-fit: cover)와 SVG(viewBox slice)에 같이 써서 화면에 꽉 채운다.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { CITY_LAND, cityGrade, cityLandSlots, type CityGrade } from '@opensamguk/shared';
import { WALL_ART_CELL, wallArt, type WallArt } from './castleArt';
import {
  CELL,
  WALL_SIZE,
  castleLayout,
  depthOrder,
  isBackWall,
  wallChunks,
  type BoxKind,
  type CastleLayout,
  type Chunk,
} from './castleGeometry';
import { castleStyle, modelCandidates, type SiteKind } from '../map3d/siteModels';
import { SLOT_DIAMOND, artLevel, lotArt, slotArt } from './slotArt';
import {
  advance,
  facing,
  groupOf,
  pathLength,
  personBand,
  personInFront,
  populate,
  terrainOf,
  walkerAt,
  type Actor,
  type LifeSlot,
  type Walker,
} from './cityLife';
import { ANIMALS, buildLine, loadTalk, talkTo, type TalkContext, type TalkPack } from './cityTalk';
import { battleFolk, drawConditions } from './cityEffects';

const W = 1440;
const H = 900;
const CX = 720;
const CY = 420;

// 등급표(성 한 변, 둘레 줄 수, 그림 채움 비율)와 등급 고르기는 서버 건설 규칙과 같은 공유 정본을 쓴다(D-107).
export { CITY_LAND, cityGrade, type CityGrade } from '@opensamguk/shared';

/** 지도 자료의 거점 종류 문자열을 거점 그림 고르기 종류로 바꾼다. 모르는 값은 도시로 본다. */
export function asSiteKind(kind: string | null | undefined): SiteKind {
  return kind === 'PASS' || kind === 'PORT' || kind === 'FIELD' ? kind : 'CITY';
}

/** home.get의 land(아군 성 건설 정보, D-107). 재야, 적 성, 거점 밖이면 서버가 null을 준다. */
export interface LandBuilding {
  slotId: string;
  building: string;
  remainingTurns: number;
  score: number;
}
export interface LandSlot {
  id: string;
  zone: 'inside' | 'outside';
  i: number;
  j: number;
  building: LandBuilding | null;
  /** 지금 건물의 시설 상한(서버 facilityCapacity). 빈 자리는 null. */
  capacity?: number | null | undefined;
}
export interface LandSpec {
  key: string;
  name: string;
  zone: 'inside' | 'outside';
  gold: number;
  wood: number;
  turns: number;
  unique: boolean;
  slots: ReadonlyArray<{ slotId: string; failure: { code: string; message: string } | null }>;
}
export interface CityLand {
  cityKey: number;
  /** 거점 양식(서버 castleStyle). */
  style?: string | undefined;
  grade: CityGrade | null;
  core: number;
  slots: readonly LandSlot[];
  buildings: readonly LandSpec[];
  /** 거점 승격(INT-30, D-108). 서버 cityLandInfo의 upgrade. 옛 서버면 없다. */
  upgrade?: LandUpgrade | null | undefined;
}

/** 국가 명령 증축과 감축의 거부 이유. */
export interface ScaleFailure {
  code: string;
  message: string;
}
/** 서버 home.land.upgrade(claude-nation-done.txt 계약, 2026-11-18, D-109). */
export interface LandUpgrade {
  enabled: boolean;
  /** 조회 장수가 수뇌(관직 5~12)인지. */
  isChief: boolean;
  /** 같은 도시, 같은 명령을 이 횟수만큼 연속 실행하면 끝난다. */
  turns: number;
  expand: {
    nextLevel: number | null;
    nextGrade: CityGrade | null;
    cost: number;
    canStart: boolean;
    failure: ScaleFailure | null;
  };
  shrink: {
    previousLevel: number | null;
    previousGrade: CityGrade | null;
    refund: number;
    canStart: boolean;
    failure: ScaleFailure | null;
    /** 감축으로 사라질 건물과 공사(감축 전 좌표). */
    demolished: ReadonlyArray<{ slotId: string; building: string }>;
  };
  /** 이 도시 증축, 감축을 준비 중인 직책들. 남은 횟수는 마지막 실행도 센다. */
  preparing: ReadonlyArray<{ commandKey: string; officerLevel: number; remainingTurns: number }>;
}

/** 건물 종류 키와 시설 아이콘 이름. 아이콘이 없는 건물은 이름 표식으로 그린다. */
const ICON_OF: Readonly<Record<string, string>> = {
  grand_market: 'grand',
  black_market: 'black',
  smith: 'forge',
  bronze_terrace: 'sparrow',
};
export function facilityIcon(building: string): string | null {
  const path = `apps/web/src/art/city/facilities/icons/${ICON_OF[building] ?? building}.webp`;
  return hasPublicImage(path) ? publicImageUrl(path) : null;
}
export const buildingName = (land: CityLand, key: string) =>
  land.buildings.find((spec) => spec.key === key)?.name ?? key;

const art = (source: string) => {
  const path = `apps/web/src/art/${source}`;
  return hasPublicImage(path) ? publicImageUrl(path) : null;
};

/** 전체 지도와 같은 순서로 고른 거점 그림 가운데 승인 목록에 있는 첫 그림. */
export function castleSprite(
  kind: SiteKind,
  level: number | undefined,
  place?: { name?: string | undefined; region?: number | undefined },
): string | null {
  for (const name of modelCandidates(kind, level, place)) {
    const url = art(`city/scene/castles/${name}.webp`);
    if (url) return url;
  }
  return null;
}

const diamond = (x: number, y: number, hw: number, hh: number) =>
  `${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}`;

/** 땅 칸 목록. 성 칸은 빼고, 칸마다 화면 가운데 좌표와 타일 번호를 준다. */
export function landCells(n: number, core: number) {
  const r = (n - 1) / 2;
  const cr = (core - 1) / 2;
  const cells: Array<{ i: number; j: number; tile: number }> = [];
  for (let i = -r; i <= r; i++)
    for (let j = -r; j <= r; j++) {
      if (core > 0 && Math.abs(i) <= cr && Math.abs(j) <= cr) continue;
      cells.push({ i, j, tile: Math.abs(Math.round(i * 7 + j * 3)) % 3 });
    }
  return cells;
}

// ---------- 슬롯 방식 전경(기획 docs/design/castle-panorama-plan.md) ----------
// 서버 땅 슬롯 하나 = 3×3칸 받침 하나. 길, 성벽, 성문은 castleGeometry가 계산하고 캔버스에 그린다.
// 누르는 자리와 건물 표식은 같은 설계 좌표(1440×900)의 SVG를 위에 겹친다.
const STONE = { top: '#d8d3c6', j: '#b2ab9b', i: '#878171', edge: '#4b473f' };
const TINT: Partial<Record<BoxKind, { top: string; j: string; i: string }>> = {
  roof: { top: '#7d6a5c', j: '#5e4e43', i: '#4a3d34' },
  tower: { top: '#d6c3a5', j: '#b99f7c', i: '#937c5f' },
};
const GROUND = { grass: '#5d6b3a', dirt: '#a8875a', paving: '#b9ad95', lotOut: '#6f7a40', lotIn: '#c8b48c' };

interface View {
  cw: number;
  ox: number;
  oy: number;
}
/** 땅 전체(성벽 높이 포함)가 설계 화면에 들도록 칸 폭과 원점을 정한다. */
function fitView(layout: CastleLayout, top: number): View {
  const { i0, i1, j0, j1 } = layout.bounds;
  const spanX = (i1 - j0 - (i0 - j1)) / 2;
  const spanY = (i1 + j1 - (i0 + j0)) / 4;
  const cw = Math.min(150, 1360 / spanX, (H - 140) / (spanY + top / CELL));
  const midX = ((i0 - j1 + (i1 - j0)) / 2) * (cw / 2);
  const midY = ((i0 + j0 + (i1 + j1)) / 2) * (cw / 4);
  return { cw, ox: W / 2 - midX, oy: H / 2 - midY + ((top / CELL) * cw) / 2 - 20 };
}
const proj =
  (v: View) =>
  (i: number, j: number, z = 0): [number, number] => [
    v.ox + ((i - j) * v.cw) / 2,
    v.oy + ((i + j) * v.cw) / 4 - (z * v.cw) / CELL,
  ];

function drawScene(
  ctx: CanvasRenderingContext2D,
  layout: CastleLayout,
  order: readonly Chunk[],
  view: View,
  ground: HTMLImageElement | null,
  art: { meta: WallArt; back: HTMLImageElement; front: HTMLImageElement } | null,
  lots: readonly SlotDraw[] = [],
  folk: readonly FolkDraw[] = [],
  tex: GroundTex = {},
  flags: { frames: HTMLCanvasElement[]; tick: number } | null = null,
  scaffold = false,
) {
  const S = proj(view);
  ctx.setTransform(ctx.canvas.width / W, 0, 0, ctx.canvas.height / H, 0, 0);
  // 바닥 재질은 위에서 본 이음 무늬라 칸 좌표(아이소)로 비틀어 깐다. 재질 한 장이 2 x 2칸.
  const [ox, oy] = S(0, 0);
  const iso = (img: HTMLImageElement | null | undefined) => {
    if (!img) return null;
    const pat = ctx.createPattern(img, 'repeat');
    if (!pat) return null;
    const u = 2 / img.width;
    pat.setTransform(
      new DOMMatrix([(view.cw / 2) * u, (view.cw / 4) * u, (-view.cw / 2) * u, (view.cw / 4) * u, ox, oy]),
    );
    return pat;
  };
  const field = iso(tex.field);
  ctx.fillStyle = field ?? GROUND.grass;
  ctx.fillRect(0, 0, W, H);
  if (tex.scenery) {
    // 먼 경치 띠: 화면 위쪽에 깔고 아래 4분의 1은 들판으로 흐려진다(그림이 그렇게 그려져 있다).
    const h = (W * tex.scenery.height) / tex.scenery.width;
    ctx.drawImage(fadedScenery(tex.scenery), 0, Math.min(0, S(layout.bounds.i0, layout.bounds.j0)[1] - h * 0.7), W, h);
  } else if (ground && !field) {
    const k = Math.max(W / ground.width, H / ground.height);
    ctx.drawImage(ground, (W - ground.width * k) / 2, (H - ground.height * k) / 2, ground.width * k, ground.height * k);
  }
  const quad = (i0: number, i1: number, j0: number, j1: number, fill: string | CanvasPattern, stroke?: string) => {
    const pts = [S(i0, j0), S(i1, j0), S(i1, j1), S(i0, j1)];
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  // 슬롯 그림: 받침 마름모(그림 가로 80%, 아래 꼭짓점 높이 85%)를 3 x 3칸 마름모에 맞춘다.
  const slotImage = (img: HTMLImageElement, a: number, b: number) => {
    const [lx] = S(a, b + 3);
    const [, by] = S(a + 3, b + 3);
    const k = (3 * view.cw) / (SLOT_DIAMOND.width * img.width);
    ctx.drawImage(
      img,
      lx - SLOT_DIAMOND.left * img.width * k,
      by - SLOT_DIAMOND.bottom * img.height * k,
      img.width * k,
      img.height * k,
    );
  };
  // 길: 땅 범위 전체를 흙길로 깔고 성 안은 포석. 그 위에 슬롯 받침.
  const { i0, i1, j0, j1 } = layout.bounds;
  quad(i0, i1, j0, j1, iso(tex.road) ?? GROUND.dirt);
  if (layout.wall) quad(-1, layout.inner + 1, -1, layout.inner + 1, iso(tex.paving) ?? GROUND.paving);
  // 슬롯 바닥: 바닥 층 그림이 있으면 그것, 없으면 색 받침. 바닥은 건물, 성벽보다 먼저 모두 깐다.
  const byId = new Map(lots.map((lot) => [lot.id, lot]));
  for (const s of layout.slots) {
    const lot = byId.get(s.id);
    if (lot?.ground) slotImage(lot.ground, s.a, s.b);
    else
      quad(s.a, s.a + 3, s.b, s.b + 3, s.zone === 'inside' ? GROUND.lotIn : GROUND.lotOut, 'rgb(255 240 205 / 0.35)');
  }
  // 건물 층: 성벽 뒤 성 밖 → 뒤쪽 벽 → 성 안 → 앞쪽 벽 → 성벽 앞 성 밖. 띠 안에서는 칸 순서(a + b)로.
  // 사람은 슬롯 앞쪽 변을 넘었으면 그 건물 뒤에 그린다(칸 좌표로 가림, 시안 depthOrder와 같은 방법).
  const person = (f: FolkDraw) => {
    const [x, y] = S(f.i, f.j);
    const size = f.size * view.cw;
    ctx.drawImage(f.img, f.sx, f.sy, f.sw, f.sh, x - size / 2, y - size * 0.85, size, size);
    if (f.banner) {
      ctx.fillStyle = '#3a2a1a';
      ctx.fillRect(x + size * 0.12, y - size * 0.95, Math.max(1, size * 0.03), size * 0.3);
      ctx.fillStyle = f.banner;
      ctx.fillRect(x + size * 0.15, y - size * 0.95, size * 0.2, size * 0.13);
    }
  };
  const band = (which: SlotDraw['band']) => {
    const things = lots.filter((l) => l.band === which && l.building).sort((u, v) => u.a + u.b - (v.a + v.b));
    const head: FolkDraw[] = [];
    const after: FolkDraw[][] = things.map(() => []);
    for (const f of folk.filter((p) => p.band === which).sort((p, q) => p.i + p.j - (q.i + q.j))) {
      let at = -1;
      things.forEach((t, k) => {
        if (f.pad === t.id || personInFront(f, t)) at = k;
      });
      (at < 0 ? head : after[at]!).push(f);
    }
    head.forEach(person);
    things.forEach((lot, k) => {
      ctx.globalAlpha = lot.dim ? 0.6 : 1;
      slotImage(lot.building!, lot.a, lot.b);
      ctx.globalAlpha = 1;
      // 태수부 앞 세력 깃발 둘(깃대 밑동을 그림의 깃대 자리에 맞춘다)
      if (lot.id === PALACE_ID && flags && flags.frames.length) {
        const img = lot.building!;
        const [lx] = S(lot.a, lot.b + 3);
        const [, by] = S(lot.a + 3, lot.b + 3);
        const k = (3 * view.cw) / (SLOT_DIAMOND.width * img.width);
        const x0 = lx - SLOT_DIAMOND.left * img.width * k;
        const y0 = by - SLOT_DIAMOND.bottom * img.height * k;
        FLAG_POLES.forEach(([fx, fy], n) => {
          const f = flags.frames[Math.floor(flags.tick / 3 + n) % flags.frames.length]!;
          const w = view.cw * 0.6;
          const h = (w * f.height * 0.85) / f.width;
          const px = x0 + fx * img.width * k;
          const py = y0 + fy * img.height * k;
          ctx.drawImage(f, 0, 0, f.width, f.height * 0.85, px - w * 0.3, py - h, w, h);
        });
      }
      after[k]!.forEach(person);
    });
  };
  // 성벽: 칸 단위 조각을 겹침 정렬로 그린다. 뒤쪽 벽, 앞쪽 벽 순서(건물 표식은 SVG에서 맨 위).
  const face = (ch: Chunk) => {
    const [a0, a1, b0, b1, z0, z1] = ch.c;
    const o = ch.o;
    const fills = TINT[o[6]] ?? STONE;
    ctx.lineWidth = Math.max(0.5, view.cw / CELL);
    ctx.strokeStyle = STONE.edge;
    const poly = (pts: Array<[number, number]>, fill: string, edges: Array<[number, number]>) => {
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      for (const [u, v] of edges) {
        ctx.moveTo(pts[u]![0], pts[u]![1]);
        ctx.lineTo(pts[v]![0], pts[v]![1]);
      }
      ctx.stroke();
    };
    if (b1 === o[3]) {
      const e: Array<[number, number]> = [
        [0, 1],
        [3, 2],
      ];
      if (a0 === o[0]) e.push([0, 3]);
      if (a1 === o[1]) e.push([1, 2]);
      poly([S(a0, b1, z1), S(a1, b1, z1), S(a1, b1, z0), S(a0, b1, z0)], fills.j, e);
    }
    if (a1 === o[1]) {
      const e: Array<[number, number]> = [
        [0, 1],
        [3, 2],
      ];
      if (b0 === o[2]) e.push([0, 3]);
      if (b1 === o[3]) e.push([1, 2]);
      poly([S(a1, b0, z1), S(a1, b1, z1), S(a1, b1, z0), S(a1, b0, z0)], fills.i, e);
    }
    const e: Array<[number, number]> = [];
    if (b0 === o[2]) e.push([0, 1]);
    if (b1 === o[3]) e.push([3, 2]);
    if (a0 === o[0]) e.push([0, 3]);
    if (a1 === o[1]) e.push([1, 2]);
    poly([S(a0, b0, z1), S(a1, b0, z1), S(a1, b1, z1), S(a0, b1, z1)], fills.top, e);
  };
  band('behind');
  if (art) {
    // 칠한 성벽 그림층: 칸 (0, 0) 위 꼭짓점에 맞춰 뒤쪽 벽, 앞쪽 벽 순서로 놓는다.
    const [x0, y0] = S(0, 0);
    const k = view.cw / WALL_ART_CELL;
    const wall = (layer: WallArt['back'], img: HTMLImageElement) =>
      ctx.drawImage(img, x0 + layer.x * k, y0 + layer.y * k, layer.w * k, layer.h * k);
    wall(art.meta.back, art.back);
    if (scaffold) drawScaffold(ctx, S, layout, view, 'back');
    band('inside');
    wall(art.meta.front, art.front);
    if (scaffold) drawScaffold(ctx, S, layout, view, 'front');
  } else {
    for (const ch of order) if (isBackWall(layout, ch.c)) face(ch);
    if (scaffold) drawScaffold(ctx, S, layout, view, 'back');
    band('inside');
    for (const ch of order) if (!isBackWall(layout, ch.c)) face(ch);
    if (scaffold) drawScaffold(ctx, S, layout, view, 'front');
  }
  band('front');
  return order.length;
}

/**
 * 승격 공사 중인 성벽에 씌우는 대나무 비계(INT-30, D-108). 성벽 바깥 면을 따라 반 칸마다 기둥, 가로대 셋, 한 칸 걸러 빗대.
 * 뒤쪽 두 변(lo 쪽)은 뒤쪽 벽 바로 뒤에, 앞쪽 두 변(hi 쪽)은 앞쪽 벽 바로 뒤에 그린다.
 */
function drawScaffold(
  ctx: CanvasRenderingContext2D,
  S: (i: number, j: number, z?: number) => [number, number],
  layout: CastleLayout,
  view: View,
  part: 'back' | 'front',
) {
  if (!layout.wall || !layout.grade) return;
  const { lo, hi } = layout.wall;
  const top = WALL_SIZE[layout.grade].height * 1.25;
  const rails = [0.45, 0.85, 1.2].map((r) => (r * top) / 1.25);
  const gap = 0.3;
  // 변마다 (기둥 자리 함수, 처음, 끝). 뒤쪽은 i = lo, j = lo 면, 앞쪽은 i = hi + 1, j = hi + 1 면.
  const out = part === 'back' ? lo - gap : hi + 1 + gap;
  const sides: Array<(t: number) => [number, number]> = [(t) => [out, t], (t) => [t, out]];
  const k = view.cw / CELL;
  ctx.save();
  ctx.lineCap = 'round';
  for (const at of sides) {
    const ts: number[] = [];
    for (let t = lo; t <= hi + 1 + 1e-6; t += 0.5) ts.push(t);
    const line = (a: [number, number], b: [number, number], width: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, width * k);
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
    };
    for (const z of rails)
      for (const [w, c] of [
        [9, 'rgba(60,40,20,.55)'],
        [5.5, '#c49a55'],
      ] as const)
        line(S(...at(ts[0]!), z), S(...at(ts[ts.length - 1]!), z), w, c);
    ts.forEach((t, n) => {
      const [i, j] = at(t);
      line(S(i, j, 0), S(i, j, top), 11, 'rgba(60,40,20,.6)');
      line(S(i, j, 0), S(i, j, top), 7, '#b98d4c');
      const next = ts[n + 1];
      if (next !== undefined && n % 2 === 0) line(S(i, j, rails[0]!), S(...at(next), rails[2]!), 4.5, '#a77c3f');
    });
  }
  ctx.restore();
}

// 먼 경치 아래 40%를 투명하게 흐려 들판 재질과 선 없이 잇는다(그림마다 한 번만 만든다).
const FADED = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
function fadedScenery(img: HTMLImageElement): HTMLCanvasElement {
  const hit = FADED.get(img);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const x = c.getContext('2d')!;
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'destination-in';
  const g = x.createLinearGradient(0, 0, 0, img.height);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.6, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, img.width, img.height);
  FADED.set(img, c);
  return c;
}

/** 바닥 재질(들판, 흙길, 성 안 포석)과 먼 경치. */
interface GroundTex {
  field?: HTMLImageElement | null;
  road?: HTMLImageElement | null;
  paving?: HTMLImageElement | null;
  scenery?: HTMLImageElement | null;
}
/** 바탕(지형)과 계절에 맞는 바닥 재질, 먼 경치 그림 주소. */
export function groundArt(terrain: string, season: string) {
  const tex = (name: string) => art(`city/ground-tex/${name}.webp`);
  const field =
    terrain === 'dry'
      ? tex('ground-grass-dry')
      : terrain === 'nanzhong'
        ? tex('ground-laterite')
        : terrain === 'forest'
          ? tex('ground-forest-floor')
          : season === 'winter' && terrain === 'steppe'
            ? tex('ground-snow')
            : tex(`ground-grass-${season}`);
  // 먼 경치 지형 8가지. 중원 들판(기본)은 강가 경치.
  const view = ['coast', 'dry', 'forest', 'mountain', 'nanzhong', 'paddy', 'river', 'steppe'].includes(terrain)
    ? terrain
    : 'river';
  return {
    field,
    road: tex(terrain === 'dry' || terrain === 'steppe' ? 'ground-sand' : 'ground-road'),
    paving: tex('ground-paving'),
    scenery: art(`city/scenery/${view}-${season}.webp`),
  };
}

/** 캔버스에 그릴 사람, 동물 하나(그림 장의 한 칸). size는 칸 폭에 대한 크기. */
interface FolkDraw {
  i: number;
  j: number;
  band: 'behind' | 'inside' | 'front';
  img: HTMLImageElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  size: number;
  /** 이 슬롯 안에서 일하는 사람(공사 일꾼, 농부)은 그 건물 앞에 그린다. */
  pad?: string | undefined;
  /** 전투 병사 깃발 색. */
  banner?: string | undefined;
}

/** 캔버스에 그릴 슬롯 하나(바닥 층, 건물 층 그림과 그리는 띠). */
interface SlotDraw {
  id: string;
  a: number;
  b: number;
  band: 'behind' | 'inside' | 'front';
  ground: HTMLImageElement | null;
  building: HTMLImageElement | null;
  /** 공사 중이면 흐리게. */
  dim: boolean;
}

/** 슬롯이 성벽 뒤(먼저 그림), 성 안, 성벽 앞(나중에 그림) 가운데 어디인가. */
export function slotBand(
  layout: CastleLayout,
  s: { zone: 'inside' | 'outside'; a: number; b: number },
): SlotDraw['band'] {
  if (s.zone === 'inside') return 'inside';
  if (!layout.wall) return 'front';
  const far = layout.inner + 1;
  return s.a >= far || s.b >= far ? 'front' : 'behind';
}

// 슬롯 그림은 주소마다 한 번만 불러 둔다.
const IMAGE_CACHE = new Map<string, HTMLImageElement>();
function loadImage(url: string, done: () => void): HTMLImageElement | null {
  const hit = IMAGE_CACHE.get(url);
  if (hit) return hit.complete && hit.naturalWidth ? hit : null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = done;
  img.src = url;
  IMAGE_CACHE.set(url, img);
  return null;
}

/** 확대, 옮기기를 맞춤 화면에 얹는다. */
const zoomed = (fit: View, z: { k: number; dx: number; dy: number }): View => ({
  cw: fit.cw * z.k,
  ox: W / 2 + (fit.ox - W / 2) * z.k + z.dx,
  oy: H / 2 + (fit.oy - H / 2) * z.k + z.dy,
});
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;

const NO_CONDS: readonly string[] = [];
/** 성마다 그린 지물(castle-walls/city-<거점 번호>/landmark.webp). 없으면 null. */
const landmarkArt = (siteKey: number) => art(`city/castle-walls/city-${siteKey}/landmark.webp`);
const PALACE_ID = 'palace';
/** 등급별 태수부 그림 단계(시안 PALACE와 같다). */
const PALACE_LEVEL: Readonly<Record<CityGrade, 1 | 2 | 3>> = { 현: 1, 소: 1, 중: 2, 대: 2, 특: 3, 경: 3 };
/** 태수부 그림(받침 그림 규격)의 깃대 밑동 두 곳, 그림 한 변에 대한 비율(guide/palace.png의 빨간 점). */
const FLAG_POLES: ReadonlyArray<readonly [number, number]> = [
  [0.3636, 0.6699],
  [0.6356, 0.6699],
];
/** 깃발 그림(4칸 띠)을 세력 색으로 칠한 틀들. 밝고 빛깔 없는 천만 원색에 천 밝기를 곱해 주름을 남긴다(시안 flagFrames). */
const FLAG_CACHE = new Map<string, HTMLCanvasElement[]>();
function flagFrames(img: HTMLImageElement, color: string): HTMLCanvasElement[] {
  const key = `${img.src}|${color}`;
  const hit = FLAG_CACHE.get(key);
  if (hit) return hit;
  const fw = Math.floor(img.width / 4);
  const [cr, cg, cb] = [1, 3, 5].map((o) => parseInt(color.slice(o, o + 2), 16) || 0) as [number, number, number];
  const out: HTMLCanvasElement[] = [];
  for (let n = 0; n < 4; n++) {
    const c = document.createElement('canvas');
    c.width = fw;
    c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(img, n * fw, 0, fw, img.height, 0, 0, fw, img.height);
    const data = x.getImageData(0, 0, fw, img.height);
    const d = data.data;
    for (let q = 0; q < d.length; q += 4) {
      const r = d[q]!;
      const g = d[q + 1]!;
      const b = d[q + 2]!;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (d[q + 3]! > 0 && mx > 110 && mx - mn < 60) {
        const k = Math.min(1, (0.3 * r + 0.59 * g + 0.11 * b) / 215);
        const lift = Math.max(0, k - 0.92) * 255;
        d[q] = Math.min(255, cr * k + lift);
        d[q + 1] = Math.min(255, cg * k + lift);
        d[q + 2] = Math.min(255, cb * k + lift);
      }
    }
    x.putImageData(data, 0, 0);
    out.push(c);
  }
  FLAG_CACHE.set(key, out);
  return out;
}
const DEFAULT_TALK: TalkContext = { ruler: '주공', taesu: '태수', enemy: '적', generals: [] };
/** 사람 그림 파일. 아직 그림이 없는 사람은 비슷한 그림을 빌린다(시안 sheetFor). */
const PEOPLE_FILE: Readonly<Record<string, string>> = {
  villager: 'villager-walk',
  woman: 'woman-walk',
  soldier: 'soldier-walk',
  porter: 'porter-walk',
  cart: 'cart-move',
  farmer: 'farmer-act',
  worker: 'worker-act',
  child: 'villager-walk',
  elder: 'villager-walk',
  scholar: 'villager-walk',
  clerk: 'villager-walk',
  peddler: 'porter-walk',
  fisher: 'porter-walk',
  hunter: 'porter-walk',
  herder: 'porter-walk',
};
function sheetUrl(kind: string, group: string): string | null {
  if ((ANIMALS as readonly string[]).includes(kind)) return art(`city/animals/${kind}-walk.webp`);
  const file = PEOPLE_FILE[kind] ?? 'villager-walk';
  return art(`city/people/${group}/${file}.webp`) ?? art(`city/people/han/${file}.webp`);
}
const ROW: Readonly<Record<string, number>> = { SE: 0, SW: 1, NE: 2, NW: 3 };
// 수레 그림은 위 줄 [SE 2장, SW 2장], 아래 줄 [NE 2장, NW 2장](2026-11-16 사용자: "수레꾼이 왜 뒤로 가냐?")
const CART: Readonly<Record<string, readonly [number, number]>> = { SE: [0, 0], SW: [0, 2], NE: [1, 0], NW: [1, 2] };

const inJsdom = () => typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');

export function CityScene({
  cityName,
  kind,
  level,
  place,
  style: styleOverride,
  land: built,
  season = 'spring',
  conditions: conditionsProp = NO_CONDS,
  talkContext = DEFAULT_TALK,
  water = null,
  factionColor = '#2a56b8',
  upgrading = false,
  onOpenCastle,
  onLot,
}: {
  cityName: string;
  kind: SiteKind;
  level: number | undefined;
  place?: { name?: string | undefined; region?: number | undefined; key?: number | undefined } | undefined;
  /** 성 양식을 직접 정한다(개발 확인 판). 없으면 거점 이름과 지역으로 고른다. */
  style?: string | undefined;
  /** 계절(대사와 바탕). */
  season?: 'spring' | 'summer' | 'autumn' | 'winter' | undefined;
  /** 켜진 상황(홍수, 역병, 전투, 풍년 등 cityTalk/common.json의 situations 키). */
  conditions?: readonly string[] | undefined;
  /** 대사 속 이름 자리(군주, 태수, 적 세력, 성 안 장수). */
  talkContext?: TalkContext | undefined;
  /** 세력 색(태수부 깃발). */
  factionColor?: string | undefined;
  /** 승격 공사 중이면 성벽에 비계를 씌운다(INT-30). */
  upgrading?: boolean | undefined;
  /** 수(나루, 수채) 거점의 물가. */
  water?: 'coast' | 'river' | null | undefined;
  /** 서버 건설 정보. 있으면 자리 좌표와 건물을 서버 값으로 그린다. */
  land?: CityLand | null | undefined;
  /** 성벽 안을 누르면 성 안 창을 연다. */
  onOpenCastle?: (() => void) | undefined;
  /** 성 밖 자리를 누르면 그 자리 ID를 넘긴다. 서버 건설 정보가 있을 때만 쓴다. */
  onLot?: ((slotId: string) => void) | undefined;
}) {
  // 부르는 쪽이 그릴 때마다 새 배열을 넘겨도 사람을 다시 세우지 않게 내용으로 묶는다.
  const condKey = conditionsProp.join(',');
  const conditions = useMemo(() => (condKey ? condKey.split(',') : NO_CONDS), [condKey]);
  const grade = cityGrade(kind, level);
  const spec = grade ? CITY_LAND[grade] : null;
  const core = spec?.core ?? 0;
  const slots = useMemo(
    (): readonly LandSlot[] =>
      built ? built.slots : cityLandSlots(kind, level ?? 5).map((slot) => ({ ...slot, building: null })),
    [built, kind, level],
  );
  const layout = useMemo(() => castleLayout(grade, slots), [grade, slots]);
  const top = grade ? WALL_SIZE[grade].height + WALL_SIZE[grade].merlon + 2 * WALL_SIZE[grade].gateTower + 30 : 0;
  const fit = useMemo(() => fitView(layout, top), [layout, top]);
  const [zoom, setZoom] = useState({ k: 1, dx: 0, dy: 0 });
  useEffect(() => setZoom({ k: 1, dx: 0, dy: 0 }), [layout]);
  const view = useMemo(() => zoomed(fit, zoom), [fit, zoom]);
  const order = useMemo(() => depthOrder(wallChunks(layout)).order, [layout]);
  const S = proj(view);
  const groundUrl = art(spec ? 'city/scene/ground/plain-luoyang.webp' : 'city/scene/ground/plain-field.webp');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pieces, setPieces] = useState(0);
  const style = styleOverride ?? castleStyle(place);
  const siteKey = place?.key;
  const wallMeta = useMemo(() => wallArt(grade, style, siteKey), [grade, style, siteKey]);
  // 슬롯마다 그릴 그림 주소. 다 지은 건물은 개발 점수로 고른 단계 그림, 짓는 중이면 공사 터, 성 밖 빈 터는 빈 터 그림.
  const lotUrls = useMemo(
    () =>
      layout.slots
        .map((s) => {
          const row = slots.find((slot) => slot.id === s.id)?.building ?? null;
          const pending = !!row && row.remainingTurns > 0;
          let ground: string | null = null;
          let building: string | null = null;
          if (row && !pending)
            ({ ground, building } = slotArt(
              style,
              row.building,
              artLevel(row.building, row.score, slots.find((slot) => slot.id === s.id)?.capacity ?? null),
            ) ?? {
              ground,
              building,
            });
          else if (pending) building = lotArt('build-out');
          else if (s.zone === 'outside') ground = lotArt('lot-out');
          return { id: s.id, a: s.a, b: s.b, band: slotBand(layout, s), ground, building };
        })
        .concat(
          // 태수부: 성 안 맨 뒤 모서리(사용자 2026-11-17 "성 안을 뒤로 넓힘"). 등급이 오를수록 큰 태수부.
          layout.palace && grade
            ? [
                {
                  id: PALACE_ID,
                  a: layout.palace.a,
                  b: layout.palace.b,
                  band: 'inside' as const,
                  ...(slotArt(style, 'palace', PALACE_LEVEL[grade]) ?? { ground: null, building: null }),
                },
              ]
            : [],
          // 그 성만의 지물(업의 동작대 등): 태수부 옆 마당 칸(사용자 2026-11-17 "각 성의 디자인을 다 다르게").
          layout.palace && siteKey !== undefined && landmarkArt(siteKey)
            ? [
                {
                  id: 'landmark',
                  a: layout.palace.a,
                  b: layout.palace.b + 4,
                  band: 'inside' as const,
                  ground: null,
                  building: landmarkArt(siteKey),
                },
              ]
            : [],
        ),
    [layout, slots, style, grade, siteKey],
  );
  const [loaded, setLoaded] = useState(0);
  // 그림은 한 번만 불러 두고, 확대나 옮기기에는 다시 그리기만 한다.
  const [images, setImages] = useState<{
    ground: HTMLImageElement | null;
    back: HTMLImageElement | null;
    front: HTMLImageElement | null;
  }>({
    ground: null,
    back: null,
    front: null,
  });
  useEffect(() => {
    if (inJsdom()) return;
    let cancelled = false;
    setImages({ ground: null, back: null, front: null });
    const load = (key: 'ground' | 'back' | 'front', url: string | null | undefined) => {
      if (!url) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (!cancelled) setImages((prev) => ({ ...prev, [key]: img }));
      };
      img.src = url;
    };
    load('ground', groundUrl);
    load('back', wallMeta?.back.url);
    load('front', wallMeta?.front.url);
    return () => {
      cancelled = true;
    };
  }, [groundUrl, wallMeta]);
  // 사람과 동물(시안 populate). 건물, 단계, 공사, 상황이 바뀌면 다시 세운다.
  const lifeSlots: LifeSlot[] = useMemo(
    () =>
      layout.slots
        .map((s) => {
          const row = slots.find((slot) => slot.id === s.id)?.building ?? null;
          return {
            id: s.id,
            a: s.a,
            b: s.b,
            zone: s.zone,
            building: row?.building ?? null,
            level: row
              ? artLevel(row.building, row.score, slots.find((slot) => slot.id === s.id)?.capacity ?? null)
              : 0,
            pending: !!row && row.remainingTurns > 0,
          };
        })
        .concat(
          layout.palace && grade
            ? [
                {
                  id: PALACE_ID,
                  a: layout.palace.a,
                  b: layout.palace.b,
                  zone: 'inside' as const,
                  building: 'palace',
                  level: PALACE_LEVEL[grade],
                  pending: false,
                },
              ]
            : [],
        ),
    [layout, slots, grade],
  );
  const terrain = terrainOf(style, water);
  const life = useMemo(
    () => populate(layout, lifeSlots, { style, terrain, conds: conditions }),
    [layout, lifeSlots, style, terrain, conditions],
  );
  const group = groupOf(style);
  const texUrls = useMemo(() => groundArt(terrain, season), [terrain, season]);
  // 대사 꾸러미(양식마다 따로 불러옴)
  const [pack, setPack] = useState<TalkPack | null>(null);
  useEffect(() => {
    let live = true;
    setPack(null);
    void loadTalk(style).then((p) => live && setPack(p));
    return () => {
      live = false;
    };
  }, [style]);
  // 눌러 볼 수 있게 마지막 틀의 사람 자리를 남긴다.
  const hits = useRef<Array<{ x: number; y: number; w: number; h: number; who: Walker | Actor }>>([]);
  const [bubble, setBubble] = useState<{ x: number; y: number; who: string; text: string } | null>(null);
  // 공사가 끝난 건물은 다 지은 뒤 대사를 한 번 띄운다.
  const pendingBefore = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const now = new Map(lifeSlots.filter((s) => s.pending && s.building).map((s) => [s.id, s.building!]));
    if (pack)
      for (const [id, key] of pendingBefore.current)
        if (!now.has(id)) {
          const s = lifeSlots.find((slot) => slot.id === id);
          const line = buildLine(pack, key, 'after');
          if (s && line) {
            const [x, y] = S(s.a + 1.5, s.b + 1.5);
            setBubble({ x, y: y - view.cw, who: line.who, text: line.text });
          }
        }
    pendingBefore.current = now;
  }, [lifeSlots, pack]);
  useEffect(() => {
    if (!bubble) return;
    const t = setTimeout(() => setBubble(null), 3600);
    return () => clearTimeout(t);
  }, [bubble]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || inJsdom()) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * ratio;
    canvas.height = H * ratio;
    const painted =
      wallMeta && images.back && images.front ? { meta: wallMeta, back: images.back, front: images.front } : null;
    const bump = () => setLoaded((n) => n + 1);
    const lots: SlotDraw[] = lotUrls.map((lot) => ({
      ...lot,
      ground: lot.ground ? loadImage(lot.ground, bump) : null,
      building: lot.building ? loadImage(lot.building, bump) : null,
      dim: false,
    }));
    const P = proj(view);
    let tick = 0;
    let frame = 0;
    let last = 0;
    const paint = (time: number) => {
      frame = requestAnimationFrame(paint);
      if (time - last < 33) return; // 초당 30틀
      last = time;
      tick++;
      const folk: FolkDraw[] = [];
      const hitList: typeof hits.current = [];
      for (const w of life.walkers) {
        advance(w, life.net, life.fronts);
        const url = sheetUrl(w.kind, group);
        const img = url ? loadImage(url, bump) : null;
        if (!img) continue;
        const p = walkerAt(w);
        const dir = facing(p.di, p.dj);
        const cart = w.kind === 'cart';
        const cell = img.width / 4;
        // 쉬는 동안은 걷는 그림을 멈춘다
        const moving = w.loop || w.s < pathLength(w.path);
        const f = moving ? Math.floor(tick / (cart ? 6 : 4) + w.s * 10) % (cart ? 2 : 4) : 0;
        const [row, col] = cart ? CART[dir]! : [ROW[dir]!, 0];
        const size = cart ? 0.79 : 0.45;
        folk.push({
          i: p.i,
          j: p.j,
          band: personBand(layout, p),
          img,
          sx: (col + f) * cell,
          sy: row * cell,
          sw: cell,
          sh: cell,
          size,
        });
        const [x, y] = P(p.i, p.j);
        hitList.push({ x, y, w: size * view.cw * 0.5, h: size * view.cw * 0.8, who: w });
      }
      for (const a of life.actors) {
        const url = sheetUrl(a.kind, group);
        const img = url ? loadImage(url, bump) : null;
        if (!img) continue;
        const cell = img.width / 4;
        const f = Math.floor(tick / a.rate) % 4;
        const slot = lifeSlots.find(
          (s) =>
            s.building === a.building ||
            (a.kind === 'farmer' && s.a <= a.i && a.i < s.a + 3 && s.b <= a.j && a.j < s.b + 3),
        );
        folk.push({
          i: a.i,
          j: a.j,
          band: personBand(layout, a),
          img,
          sx: f * cell,
          sy: a.row * cell,
          sw: cell,
          sh: cell,
          size: 0.45,
          pad: slot?.id,
        });
        const [x, y] = P(a.i, a.j);
        hitList.push({ x, y, w: 0.22 * view.cw, h: 0.36 * view.cw, who: a });
      }
      if (conditions.includes('battle')) folk.push(...battleFolk(layout, tick, (u) => loadImage(u, bump), art));
      hits.current = hitList;
      // 개발 모드에서만 화면 확인용으로 사람 자리를 남긴다.
      if (import.meta.env.DEV) (window as unknown as { __cityHits?: unknown }).__cityHits = hitList;
      const tex = {
        field: texUrls.field ? loadImage(texUrls.field, bump) : null,
        road: texUrls.road ? loadImage(texUrls.road, bump) : null,
        paving: texUrls.paving ? loadImage(texUrls.paving, bump) : null,
        scenery: texUrls.scenery ? loadImage(texUrls.scenery, bump) : null,
      };
      const flagUrl = art('city/flags/flag-pennant-strip.webp');
      const flagImg = flagUrl ? loadImage(flagUrl, bump) : null;
      const flags = flagImg ? { frames: flagFrames(flagImg, factionColor), tick } : null;
      setPieces(drawScene(ctx, layout, order, view, images.ground, painted, lots, folk, tex, flags, upgrading));
      drawConditions(ctx, {
        conditions,
        tick,
        view: P,
        cw: view.cw,
        layout,
        lots: lifeSlots,
        W,
        H,
        fire: art('city/fx/act-burning.webp') ? loadImage(art('city/fx/act-burning.webp')!, bump) : null,
      });
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [
    layout,
    order,
    view,
    images,
    wallMeta,
    lotUrls,
    loaded,
    life,
    lifeSlots,
    group,
    conditions,
    texUrls,
    factionColor,
    upgrading,
  ]);
  /** 사람이나 동물을 누르면 말풍선. 시안 talkTo와 같은 고르기. 아무도 없으면 아래(자리 누르기)로 넘긴다. */
  const onPickPerson = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!pack) return;
    const p = toDesign(event.clientX, event.clientY);
    const hit = [...hits.current]
      .reverse()
      .find((h) => Math.abs(p.x - h.x) <= h.w / 2 + 4 && p.y <= h.y + 4 && p.y >= h.y - h.h - 4);
    if (!hit) return;
    event.stopPropagation();
    event.preventDefault();
    const who = hit.who;
    const said = talkTo(
      pack,
      {
        kind: who.kind,
        role: 'role' in who ? who.role : undefined,
        building: 'building' in who ? who.building : undefined,
      },
      {
        season,
        water: !!water,
        conds: conditions,
        ctx: talkContext,
      },
    );
    setBubble({ x: hit.x, y: hit.y - hit.h, who: said.who, text: said.text });
  };
  /** 건물 그림이 있는 슬롯은 아이콘 대신 그림으로 보인다. */
  const painted = new Set(lotUrls.filter((lot) => lot.building).map((lot) => lot.id));

  // 확대(휠, 단추)와 끌어 옮기기. 끈 뒤에는 자리 클릭을 한 번 막는다.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const toDesign = (clientX: number, clientY: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || !r.width) return { x: W / 2, y: H / 2, s: 1 };
    const s = Math.max(r.width / W, r.height / H);
    return { x: (clientX - r.left - (r.width - W * s) / 2) / s, y: (clientY - r.top - (r.height - H * s) / 2) / s, s };
  };
  /** 설계 좌표를 상자 안 화면 좌표(px)로. */
  const toScreen = (x: number, y: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || !r.width) return { left: x, top: y };
    const s = Math.max(r.width / W, r.height / H);
    return { left: x * s + (r.width - W * s) / 2, top: y * s + (r.height - H * s) / 2 };
  };
  const zoomAt = (factor: number, px = W / 2, py = H / 2) =>
    setZoom((z) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z.k * factor));
      const f = k / z.k;
      if (k === ZOOM_MIN) return { k, dx: 0, dy: 0 };
      return { k, dx: px - W / 2 - (px - W / 2 - z.dx) * f, dy: py - H / 2 - (py - H / 2 - z.dy) * f };
    });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const p = toDesign(event.clientX, event.clientY);
      zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || zoom.k === ZOOM_MIN) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    const s = toDesign(0, 0).s;
    d.x = event.clientX;
    d.y = event.clientY;
    setZoom((z) => ({ ...z, dx: z.dx + dx / s, dy: z.dy + dy / s }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      // 끌기가 끝난 직후의 클릭은 자리 누르기로 치지 않는다.
      const stop = (event: Event) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
    }
  };

  const outside = layout.slots.filter((s) => s.zone === 'outside');
  const rowOf = (id: string) => slots.find((slot) => slot.id === id)?.building ?? null;
  const cells = outside
    .map((s) => {
      const [x, y] = S(s.a + 1.5, s.b + 1.5);
      return { id: s.id, a: s.a, b: s.b, x, y, building: rowOf(s.id) };
    })
    .sort((u, v) => u.y - v.y);
  const empty = cells.filter((cell) => !cell.building).length;
  const lw = view.cw * 1.5;
  const lh = lw / 2;
  const press = (run: () => void) => (event: KeyboardEvent<SVGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      run();
    }
  };
  const label = spec
    ? `${cityName} 성 화면: ${grade} 등급, 성 안 자리 ${core * core}칸, 성 밖 땅 ${cells.length}칸`
    : `${cityName}: 성 없는 거점, 땅 ${cells.length}칸`;
  const iconSize = 1.6 * view.cw;
  const insideRows = built ? layout.slots.filter((s) => s.zone === 'inside' && rowOf(s.id)) : [];
  const wallPoly = layout.wall
    ? [S(-1, -1), S(layout.inner + 1, -1), S(layout.inner + 1, layout.inner + 1), S(-1, layout.inner + 1)]
        .map(([x, y]) => `${x},${y}`)
        .join(' ')
    : '';
  const labelY = S(layout.bounds.i1, layout.bounds.j1)[1];
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="city-scene"
      data-grade={grade ?? 'open'}
      data-slots={layout.slots.length}
      data-gates={layout.gateSides.length}
      data-wall-pieces={pieces}
      data-style={style}
      data-wall-art={wallMeta ? wallMeta.style : 'boxes'}
      data-zoom={zoom.k.toFixed(2)}
      ref={boxRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => (drag.current = null)}
      onClickCapture={onPickPerson}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: GROUND.grass,
        touchAction: 'none',
        cursor: zoom.k > ZOOM_MIN ? 'grab' : undefined,
      }}
    >
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, display: 'block' }}
      >
        <style>
          {'[data-focusring]:focus{outline:none}[data-focusring]:focus-visible{stroke:#ffd77a;stroke-width:3}'}
        </style>
        {spec ? (
          <polygon
            role="button"
            tabIndex={0}
            aria-label={`${cityName}성 안 보기`}
            data-testid="city-castle"
            data-focusring=""
            points={wallPoly}
            fill="transparent"
            style={{ cursor: onOpenCastle ? 'pointer' : undefined }}
            onClick={onOpenCastle}
            onKeyDown={press(() => onOpenCastle?.())}
          />
        ) : null}
        {built && onLot ? (
          <g data-testid="city-lots">
            {cells.map((cell) => (
              <polygon
                key={cell.id}
                role="button"
                tabIndex={0}
                aria-label={`성 밖 ${cell.id} ${cell.building ? buildingName(built, cell.building.building) : '빈 터'}`}
                data-slot={cell.id}
                data-focusring=""
                points={diamond(cell.x, cell.y, lw, lh)}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onClick={() => onLot(cell.id)}
                onKeyDown={press(() => onLot(cell.id))}
              />
            ))}
          </g>
        ) : null}
        {built ? (
          <g pointerEvents="none">
            {insideRows.map((s) => {
              const row = rowOf(s.id)!;
              const [x, y] = S(s.a + 1.5, s.b + 1.5);
              const url = painted.has(s.id) ? null : facilityIcon(row.building);
              return (
                <g
                  key={s.id}
                  data-testid="castle-building"
                  data-slot={s.id}
                  data-building={row.building}
                  opacity={row.remainingTurns > 0 ? 0.55 : 1}
                >
                  {url ? (
                    <image href={url} x={x - iconSize / 2} y={y - iconSize * 0.8} width={iconSize} height={iconSize} />
                  ) : null}
                </g>
              );
            })}
            {cells.map((cell) => {
              const row = cell.building;
              if (!row) return null;
              const url = facilityIcon(row.building);
              const name = buildingName(built, row.building);
              const drawn = painted.has(cell.id);
              const pending = row.remainingTurns > 0;
              const u = lw / 2;
              return (
                <g
                  key={cell.id}
                  data-testid="lot-building"
                  data-slot={cell.id}
                  data-building={row.building}
                  data-remaining={row.remainingTurns}
                  opacity={pending ? 0.55 : 1}
                >
                  {drawn ? null : url ? (
                    <image
                      href={url}
                      x={cell.x - iconSize / 2}
                      y={cell.y - iconSize * 0.8}
                      width={iconSize}
                      height={iconSize}
                    />
                  ) : (
                    <>
                      <rect
                        x={cell.x - u * 0.9}
                        y={cell.y - u * 0.8}
                        width={u * 1.8}
                        height={u * 0.75}
                        rx={3}
                        fill="rgb(60 32 14 / 0.9)"
                        stroke="#e8c060"
                        strokeWidth={1.5}
                      />
                      <text
                        x={cell.x}
                        y={cell.y - u * 0.3}
                        textAnchor="middle"
                        fontSize={Math.max(10, u * 0.34)}
                        fontWeight={700}
                        fill="#f5e6c8"
                      >
                        {name}
                      </text>
                    </>
                  )}
                  {pending ? (
                    <g data-testid="lot-remaining">
                      <circle cx={cell.x + u * 0.85} cy={cell.y - u * 0.8} r={Math.max(8, u * 0.22)} fill="#8a1a0c" />
                      <text
                        x={cell.x + u * 0.85}
                        y={cell.y - u * 0.8 + Math.max(4, u * 0.11)}
                        textAnchor="middle"
                        fontSize={Math.max(11, u * 0.3)}
                        fontWeight={700}
                        fill="#fff"
                      >
                        {row.remainingTurns}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </g>
        ) : null}
        <g transform={`translate(${W / 2} ${Math.min(H - 24, labelY + 26)})`} pointerEvents="none">
          <rect x={-120} y={-15} width={240} height={30} fill="rgb(42 18 8 / 0.88)" stroke="#c9a25a" strokeWidth={2} />
          <text x={0} y={5} textAnchor="middle" fontSize={15} fontWeight={700} fill="#f5e6c8">
            {spec ? `${cityName} (${grade}, 빈 터 ${empty})` : `${cityName} (성 없는 거점)`}
          </text>
        </g>
      </svg>
      {bubble ? <SpeechBubble bubble={bubble} toScreen={toScreen} onClose={() => setBubble(null)} /> : null}
      <div
        role="group"
        aria-label="성 화면 확대"
        style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', display: 'grid', gap: 6 }}
      >
        {[
          ['확대', '+', () => zoomAt(1.4)],
          ['축소', '−', () => zoomAt(1 / 1.4)],
          ['맞춤', '⤢', () => setZoom({ k: 1, dx: 0, dy: 0 })],
        ].map(([name, glyph, run]) => (
          <button
            key={name as string}
            type="button"
            aria-label={`성 화면 ${name as string}`}
            onClick={run as () => void}
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              width: 34,
              height: 34,
              font: '700 18px/1 system-ui, sans-serif',
              color: '#f5e6c8',
              background: 'rgb(42 18 8 / 0.85)',
              border: '1px solid #c9a25a',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            {glyph as string}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 사람 머리 위 말풍선. 누르면 닫힌다. */
function SpeechBubble({
  bubble,
  toScreen,
  onClose,
}: {
  bubble: { x: number; y: number; who: string; text: string };
  toScreen: (x: number, y: number) => { left: number; top: number };
  onClose: () => void;
}) {
  const at = toScreen(bubble.x, bubble.y);
  return (
    <div
      role="status"
      data-testid="city-bubble"
      onClick={onClose}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        position: 'absolute',
        left: Math.max(12, at.left - 150),
        top: Math.max(8, at.top - 12),
        transform: 'translateY(-100%)',
        width: 300,
        padding: '8px 12px',
        background: 'rgb(250 240 215 / 0.97)',
        color: '#2b1a0c',
        border: '2px solid #8a6a3a',
        borderRadius: 8,
        font: '14px/1.5 system-ui, sans-serif',
        boxShadow: '0 4px 12px rgb(0 0 0 / 0.35)',
        cursor: 'pointer',
        zIndex: 2,
      }}
    >
      <b style={{ display: 'block', marginBottom: 2 }}>{bubble.who}</b>
      {bubble.text}
    </div>
  );
}

/** 진영 화면: 성 밖에 있는 장수가 선 들판과 진영, 장수 부대(병사 한 명 8방향 그림의 오른쪽 아래 방향). */
export function CampScene({ placeName, crewType }: { placeName: string; crewType: number | null }) {
  const ground = art('city/scene/ground/plain-field.webp');
  const camp = art('battle/objects/camp.webp');
  const unit = crewType == null ? null : art(`battle/units8/${crewType}.webp`);
  const hw = 192;
  const hh = 96;
  // 진영 그림은 256×320, 바닥 마름모가 아래쪽 256×128 칸에 맞는다.
  const campWidth = 2 * hw;
  const campHeight = campWidth * 1.25;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      width="100%"
      height="100%"
      role="img"
      aria-label={`${placeName} 진영 화면`}
      data-testid="camp-scene"
      style={{ display: 'block', background: '#4b5a32' }}
    >
      {ground ? <image href={ground} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid slice" /> : null}
      <polygon points={diamond(CX, CY, 3 * hw, 3 * hh)} fill="none" stroke="#ffd77a" strokeWidth={3} />
      {camp ? <image href={camp} x={CX - hw} y={CY - 0.8 * campHeight} width={campWidth} height={campHeight} /> : null}
      {unit ? (
        // 8방향 그림은 5열×2행(256칸). 둘째 열 첫 줄이 오른쪽 아래를 보고 선 자세다.
        <svg x={CX + hw - 80} y={CY + hh - 150} width={160} height={160} viewBox="256 0 256 256">
          <image href={unit} x={0} y={0} width={1280} height={512} />
        </svg>
      ) : null}
    </svg>
  );
}
