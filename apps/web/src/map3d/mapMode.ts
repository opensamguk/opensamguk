// 전체 지도 모드와 세부(지역) 모드 (INT-29, 사용자 2026-11-15 "전체지도모드랑 세부모드랑 할 수 있는걸 나눌까? 나오는 정보도
// 나누고?" → "이 안대로"). 두 모드는 같은 지도의 확대 단계다. 보이는 지도 폭이 DETAIL_VIEW_WIDTH 이하(확대 3단계,
// siteModels.zoomTier)면 세부다. 명령은 두 모드 모두에서 열리고, 모드에 따라 지도에 보이는 정보와 고르는 단위만 다르다.
// 지연 로드하는 3D 지도 덩어리와 따로 둬서 지도 바탕 화면이 이 값만 먼저 쓴다.

export type MapMode = 'overview' | 'detail';

/** 세부 모드가 되는 보이는 지도 폭(지도 단위). siteModels.zoomTier의 3단계 경계와 같다. */
export const DETAIL_VIEW_WIDTH = 200;
/** 세부 모드로 들어갈 때 보이게 할 지도 폭. 성 몇 개가 한 화면에 든다. */
export const DETAIL_ENTER_WIDTH = 120;

export const mapModeOfTier = (tier: number): MapMode => (tier >= 3 ? 'detail' : 'overview');

export const MAP_MODE_LABEL: Record<MapMode, string> = { overview: '전체 지도', detail: '세부' };

/**
 * 모드별 거점 이름판(고르기 단추) 표시. 전체 지도는 천하 형세를 읽는 곳이라 큰 도시(소 이상)·이민족·관문만,
 * 세부는 현·수까지 모두 보인다. 고른 거점과 내 거점은 어느 모드든 보인다. 전장·나루 이름은 세부에서만(따로 처리).
 */
export function showsSiteLabel(
  mode: MapMode,
  site: { kind: string; level?: number | undefined },
  pinned = false,
): boolean {
  if (mode === 'detail' || pinned) return true;
  if (site.kind === 'PASS') return true;
  if (site.kind === 'CITY') return (site.level ?? 5) >= 4;
  return false;
}

/** 지도 바탕 화면이 지도에 보내는 모드 바꾸기 요청. nonce가 바뀔 때마다 한 번 움직인다. */
export type MapModeRequest = { mode: MapMode; nonce: number };
