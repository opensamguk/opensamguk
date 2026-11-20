import type { QueryKey } from '@tanstack/react-query';
import type { Trpc } from '../trpc';

// 월드 상태나 모드가 바뀔 때(liveRefresh의 board) 한 번 다시 받는 조회. 게임 레이아웃이 어느 화면에서든 부른다.
// - 지도, 도시, 국가: 종료 직후 지도가 결과 칸과 다른 소유국을 보여 주지 않게 한다.
// - 명령 제안(상신, D-100): 서버는 끝난 월드의 대기 제안을 만료로 센다. 제안함을 열지 않은 화면의 메뉴 배지와
//   열어 둔 제안함 모두 주기 조회가 멈추기 전에 마지막 상태를 받는다.
export function boardKeys(trpc: Trpc, worldId: string): QueryKey[] {
  return [trpc.world.map.queryKey({ worldId }), trpc.city.pathKey(), trpc.nation.pathKey(), trpc.proposals.pathKey()];
}
