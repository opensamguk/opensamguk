// 거점 그림 고르기 (INT-27, D-097). Codex가 그린 거점 그림을 거점 종류·단계·지역에 맞춰 고른다. 3D 모형(GLB)은 쓰지 않는다.
// 단계 0~4는 원작의 거점 종류 코드이고 5~9가 크기다(D-092). 모형이 아직 없는 단계는 다음 후보로 대신한다.
import { EAST_SPRITES, REGION_GROUPS, TRIBE_SPRITES, type PublicGeography } from '@opensamguk/shared';

export type SiteKind = PublicGeography['sites'][number]['kind'];

// 양식 판정 표(지역 무리, 종족, 동이 나라 이름)는 규칙과 함께 쓰려고 shared로 옮겼다(INT-29 지역 고유 건물, 2026-11-17).
export { EAST_SPRITES, REGION_GROUPS, TRIBE_SPRITES, castleStyle } from '@opensamguk/shared';
/** 동이 그림의 크기별 판(큰 것부터). 5(소)는 이름 그대로인 기본 판이다. */
const EAST_SIZES = [9, 8, 7, 6] as const;
// 지역 그림이 있는 기준 그림. 현 마을(houses)도 지역마다 다르다(사용자 2026-11-15 "현도 지역마다 다르게 수정했던가?").
const SIZE_SPRITES = ['city-9', 'capital', 'city-7', 'city-6', 'city-5', 'houses'] as const;

/** 거점에 쓸 그림·모형 이름 후보(앞이 우선). 종족·동이 그림, 지역 무리 그림, 기준 그림 순이다. */
export function modelCandidates(
  kind: SiteKind,
  level: number | undefined,
  place?: { name?: string | undefined; region?: number | undefined },
): string[] {
  const base = baseCandidates(kind, level);
  if (kind !== 'CITY' || !place) return base;
  const special = (place.name && (TRIBE_SPRITES[place.name] ?? EAST_SPRITES.get(place.name))) || null;
  // 동이 나라도 중(6)·대(7) 거점은 크기별 판을 먼저 쓴다(사용자 2026-11-15 "한반도쪽이나 왜는 크기별 아이콘이 없네?").
  // 없으면 한 단계씩 작은 판, 마지막에 소 판(이름 그대로).
  const sized = special?.startsWith('east-')
    ? EAST_SIZES.filter((size) => size <= (level ?? 5)).map((size) => `${special}-${size}`)
    : [];
  if (special) return [...sized, special, ...(special === 'east-eupru' ? ['east-okjeo-ye'] : []), ...base];
  const group = place.region === undefined ? undefined : REGION_GROUPS[place.region];
  if (!group || group === 'central') return base;
  return [
    ...base.filter((name) => (SIZE_SPRITES as readonly string[]).includes(name)).map((name) => `${group}-${name}`),
    ...base,
  ];
}

function baseCandidates(kind: SiteKind, level: number | undefined): string[] {
  if (kind === 'PASS') return ['pass'];
  if (kind === 'PORT') return ['port', 'houses'];
  if (kind === 'FIELD') return ['battlefield', 'camp'];
  const step = level ?? 5;
  if (step >= 9) return ['city-9', 'capital'];
  if (step === 8) return ['capital'];
  if (step === 7) return ['city-7', 'capital'];
  if (step === 6) return ['city-6', 'city-5', 'houses'];
  if (step === 5) return ['city-5', 'houses'];
  if (step === 4) return ['nomad-camp', 'camp'];
  // D-096: 현(2, 원작 진)은 현성(부속 현)이라 마을 그림, 수(1)는 나루·수채 그림.
  if (step === 2 || step === 3) return ['houses', 'camp'];
  if (step === 1) return ['water-fort', 'port', 'camp'];
  return ['houses'];
}

/** 받아 둔 모형 가운데 이 거점에 쓸 것. 하나도 없으면 null(임시 상자 모형을 쓴다). */
export function pickModel(
  kind: SiteKind,
  level: number | undefined,
  available: ReadonlySet<string>,
  place?: { name?: string | undefined; region?: number | undefined },
): string | null {
  return modelCandidates(kind, level, place).find((name) => available.has(name)) ?? null;
}

/**
 * 모형이 영지 칸 한 칸(한 변 TILE)을 얼마나 채우는지(사용자 2026-11-14: 크기는 1칸 안).
 * 클수록 칸을 꽉 채운다. 경 96%, 특 90%, 대 84%, 중 78%, 소 72%, 현·수 60%.
 */
export function tileFill(kind: SiteKind, level: number | undefined): number {
  // 관문은 소 도시(72%)보다 작게(사용자 2026-11-14: "관의 크기가 너무 큰데?"). 바위 덩이가 커서 85%면 중 도시보다 커 보였다.
  if (kind === 'PASS') return 0.6;
  if (kind === 'PORT') return 0.6;
  if (kind === 'FIELD') return 0.55;
  const step = level ?? 5;
  const byLevel = [0.5, 0.6, 0.6, 0.6, 0.72, 0.72, 0.78, 0.84, 0.9, 0.96];
  return byLevel[Math.min(Math.max(Math.round(step), 0), 9)] ?? 0.72;
}

/**
 * 지역 색(사용자 2026-11-14: 지역별로 무늬·색을 다르게). 같은 모형에 은은하게 곱하는 색이다.
 * 삼10 지도 지역 번호: 1 사례, 2 예주, 3 기주, 4 연주, 5 서주, 6 청주, 7 형주, 8 양주(강남), 9 익주(파촉),
 * 10 남중, 11 양주(서량), 12 병주, 13 유주, 14 교주, 15 한반도·왜, 16 이민족.
 */
const REGION_TINT: Record<number, string> = {
  1: '#ffffff',
  2: '#fff3e2',
  3: '#f4e2c2',
  4: '#f7ead4',
  5: '#eef0fb',
  6: '#edf4ee',
  7: '#eef6e4',
  8: '#f3f7ff',
  9: '#f7dfd2',
  10: '#e6f0d8',
  11: '#f1ddb8',
  12: '#ebe2d0',
  13: '#e5eaf2',
  14: '#f3eacd',
  15: '#e7eadf',
  16: '#efe3cf',
};

/** 지역 번호의 모형 색(모르는 지역은 흰색, 곧 원래 색). */
export function regionTint(region: number | undefined): string {
  return (region !== undefined && REGION_TINT[region]) || '#ffffff';
}

/**
 * 화면 확대 단계(사용자 2026-11-14). 화면에 보이는 지도 폭(지도 단위)으로 정해 화면 크기와 상관없이 같은 느낌이다.
 * 1 확대 안 함(천하 전체) · 2 중간(몇 개 주) · 3 어느 정도(성 4~5개) · 4 크게(성 하나가 크게).
 */
export type ZoomTier = 1 | 2 | 3 | 4;
export function zoomTier(viewWidth: number): ZoomTier {
  if (viewWidth <= 70) return 4;
  if (viewWidth <= 200) return 3;
  if (viewWidth <= 600) return 2;
  return 1;
}

/** 단계별 모형 거리 단계(0 자세함 ~ 2 단순)와 이름판 배율. */
export const TIER_LABEL_SCALE: Record<ZoomTier, number> = { 1: 0.9, 2: 1, 3: 1.4, 4: 2 };

export const MODEL_NAMES = [
  'city-9',
  'capital',
  'city-7',
  'city-6',
  'city-5',
  'pass',
  'pass-h',
  'pass-v',
  'camp',
  'houses',
  'port',
  'water-fort',
  'nomad-camp',
  'battlefield',
  'flag-castle',
  'flag-pennant',
  ...Object.values(TRIBE_SPRITES),
  ...new Set(EAST_SPRITES.values()),
  ...[...new Set(EAST_SPRITES.values())].flatMap((east) => EAST_SIZES.map((size) => `${east}-${size}`)),
  ...[...new Set(Object.values(REGION_GROUPS))]
    .filter((group) => group !== 'central')
    .flatMap((group) => SIZE_SPRITES.map((size) => `${group}-${size}`)),
];
