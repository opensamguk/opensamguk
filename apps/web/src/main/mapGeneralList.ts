import type { WorldMap } from '../game/types';
import { displayName } from '../game/names';

// 지도 풍선에 쓰는 거점별 장수 (world.map generals, INT-26). 공개 필드(이름·소속·얼굴·사람 여부)만 온다.
// 첩보 기능 월드는 서버가 공백지와 본국 거점의 장수만 보낸다. 그래서 빈 목록은 `없음`이 아니라 `모름`일 수 있다.
export type MapGeneral = WorldMap['generals'][number];

// 풍선 하나에 얼굴과 이름을 다 쓰는 장수 수. 나머지는 `외 N명`으로 센다.
export const TOOLTIP_GENERAL_LIMIT = 5;

export function generalsByCity(generals: readonly MapGeneral[] | undefined): Map<number, MapGeneral[]> {
  const byCity = new Map<number, MapGeneral[]>();
  for (const general of generals ?? []) {
    const list = byCity.get(general.cityKey);
    if (list) list.push(general);
    else byCity.set(general.cityKey, [general]);
  }
  return byCity;
}

// 사람 장수를 먼저, 그다음 서버 순서(id 오름차순)로 limit명까지 보인다.
export function tooltipGenerals(
  generals: readonly MapGeneral[],
  limit = TOOLTIP_GENERAL_LIMIT,
): { shown: MapGeneral[]; rest: number } {
  const ordered = [...generals.filter((g) => g.isHuman), ...generals.filter((g) => !g.isHuman)];
  return { shown: ordered.slice(0, limit), rest: Math.max(0, ordered.length - limit) };
}

// 읽기 이름·SVG title에 쓰는 장수 글자. 예: `장수 3명: 조조, 순욱, 하후돈 NPC`.
export function generalsText(generals: readonly MapGeneral[], limit = TOOLTIP_GENERAL_LIMIT): string | null {
  if (generals.length === 0) return null;
  const { shown, rest } = tooltipGenerals(generals, limit);
  const names = shown.map((g) => `${displayName(g.name)}${g.isHuman ? '' : ' NPC'}`).join(', ');
  return `장수 ${generals.length}명: ${names}${rest > 0 ? ` 외 ${rest}명` : ''}`;
}
