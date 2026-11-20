import type { QueryKey } from '@tanstack/react-query';
import type { Trpc } from '../trpc';

// 월드 상태나 모드가 바뀔 때(liveRefresh의 board) 한 번 다시 받는 조회. 게임 레이아웃이 어느 화면에서든 부른다.
// - 지도, 도시, 국가: 종료 직후 지도가 결과 칸과 다른 소유국을 보여 주지 않게 한다.
// - 이 월드의 명령 제안 목록(상신, D-100): 서버는 끝난 월드의 대기 제안을 만료로 센다. 받은 목록과 보낸 목록만
//   다시 받는다(명령 후보와 다른 월드 캐시는 그대로). 종료와 겹친 응답의 표시는 화면이 따로 막는다(useInboxCount,
//   ProposalBox의 ended 처리).
export function boardKeys(trpc: Trpc, worldId: string): QueryKey[] {
  return [
    trpc.world.map.queryKey({ worldId }),
    trpc.city.pathKey(),
    trpc.nation.pathKey(),
    trpc.proposals.list.queryKey({ worldId }),
  ];
}
