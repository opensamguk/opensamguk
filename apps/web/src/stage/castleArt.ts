// 칠한 성벽 그림층. 양식마다, 등급마다 뒤쪽 벽, 앞쪽 벽 두 장(1칸 256px).
// 만드는 법: D:/codex-artifacts/int29-castle-slots-20261116/castletest3.py wall/<양식> <등급> _ layers web-layers/<양식>
// 그 다음 tools/art/stage-castle-walls.py가 이미지 저장소로 옮기고 자리표 castleWallMeta.json을 쓴다.
// x, y는 칸 (0, 0)의 위 꼭짓점에서 그림 왼쪽 위까지(256px 칸 기준). 이미지 저장소 public/art/city/castle-walls/<양식>.
// 사용자 2026-11-17: "지역별로 새로 만든건 전부 웹에 넣어." 아직 그리지 않은 양식은 중원 성벽을 쓴다.
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import type { CityGrade } from '@opensamguk/shared';
import wallMeta from './castleWallMeta.json';

export const WALL_ART_CELL = 256;
const FILE: Readonly<Record<CityGrade, string>> = {
  현: 'hyeon',
  소: 'so',
  중: 'jung',
  대: 'dae',
  특: 'teuk',
  경: 'gyeong',
};
type Layer = { x: number; y: number; w: number; h: number };
const META = wallMeta as unknown as Readonly<
  Record<string, Readonly<Partial<Record<CityGrade, { back: Layer; front: Layer }>>>>
>;

export interface WallArt {
  style: string;
  back: Layer & { url: string };
  front: Layer & { url: string };
}

function styleArt(style: string, grade: CityGrade): WallArt | null {
  const m = META[style]?.[grade];
  if (!m) return null;
  const path = (part: 'back' | 'front') =>
    `apps/web/src/art/city/castle-walls/${style}/wall-${FILE[grade]}-${part}.webp`;
  if (!hasPublicImage(path('back')) || !hasPublicImage(path('front'))) return null;
  return {
    style,
    back: { ...m.back, url: publicImageUrl(path('back')) },
    front: { ...m.front, url: publicImageUrl(path('front')) },
  };
}

/**
 * 등급과 양식의 칠한 성벽 그림층. 성마다 따로 그린 성벽(사용자 2026-11-17 "250곳 모두 고유")이 있으면 그것,
 * 없으면 그 양식, 그것도 없으면 중원, 그것도 없으면 null(상자 성벽으로 그린다).
 * 성마다 그림은 castle-walls/city-<거점 번호>/에 그 성 등급 한 벌만 있다.
 */
export function wallArt(grade: CityGrade | null, style = 'central', siteKey?: number): WallArt | null {
  if (!grade) return null;
  const own = siteKey === undefined ? null : styleArt(`city-${siteKey}`, grade);
  return own ?? styleArt(style, grade) ?? (style === 'central' ? null : styleArt('central', grade));
}
