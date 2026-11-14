// 거점 모형 고르기 (INT-27, D-094·D-095). Rodin 등으로 만든 GLB 모형을 거점 종류·단계에 맞춰 고른다.
// 단계 0~4는 원작의 거점 종류 코드이고 5~9가 크기다(D-092). 모형이 아직 없는 단계는 다음 후보로 대신한다.
import type { PublicGeography } from '@opensamguk/shared';

type SiteKind = PublicGeography['sites'][number]['kind'];

/** 거점에 쓸 모형 이름 후보(앞이 우선). 파일은 `<이름>-lod<0|1|2>.glb`이다. */
export function modelCandidates(kind: SiteKind, level: number | undefined): string[] {
  if (kind === 'PASS') return ['pass'];
  if (kind === 'PORT') return ['port', 'houses'];
  if (kind === 'FIELD') return ['camp'];
  const step = level ?? 5;
  if (step >= 9) return ['city-9', 'capital'];
  if (step === 8) return ['capital'];
  if (step === 7) return ['city-7', 'capital'];
  if (step === 6) return ['city-6', 'city-5', 'houses'];
  if (step === 5) return ['city-5', 'houses'];
  if (step === 4) return ['nomad-camp', 'camp'];
  if (step === 2 || step === 3) return ['camp'];
  if (step === 1) return ['water-fort', 'camp'];
  return ['houses'];
}

/** 받아 둔 모형 가운데 이 거점에 쓸 것. 하나도 없으면 null(임시 상자 모형을 쓴다). */
export function pickModel(kind: SiteKind, level: number | undefined, available: ReadonlySet<string>): string | null {
  return modelCandidates(kind, level).find((name) => available.has(name)) ?? null;
}

/** 거점 한 변이 화면에서 몇 px인지로 거리 단계를 고른다. 크게 보이면 자세한 모형(0)이다. */
export function lodForPixels(px: number): 0 | 1 | 2 {
  if (px > 140) return 0;
  if (px > 45) return 1;
  return 2;
}

/**
 * 모형이 영지 칸 한 칸(한 변 TILE)을 얼마나 채우는지(사용자 2026-11-14: 크기는 1칸 안).
 * 클수록 칸을 꽉 채운다. 경 96%, 특 90%, 대 84%, 중 78%, 소 72%, 진·수 60%.
 */
export function tileFill(kind: SiteKind, level: number | undefined): number {
  if (kind === 'PASS') return 0.85;
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
export const TIER_LOD: Record<ZoomTier, 0 | 1 | 2> = { 1: 2, 2: 2, 3: 1, 4: 0 };
export const TIER_LABEL_SCALE: Record<ZoomTier, number> = { 1: 0.9, 2: 1, 3: 1.4, 4: 2 };

export const MODEL_NAMES = [
  'city-9',
  'capital',
  'city-7',
  'city-6',
  'city-5',
  'pass',
  'camp',
  'houses',
  'port',
  'water-fort',
  'nomad-camp',
] as const;
