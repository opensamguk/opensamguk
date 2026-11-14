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

export const MODEL_NAMES = ['city-9', 'capital', 'city-7', 'city-6', 'city-5', 'pass', 'camp', 'houses'] as const;
