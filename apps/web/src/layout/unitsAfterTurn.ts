import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTRPC } from '../trpc';

// 내 턴이 실행되면(home.get의 다음 턴 시각이 바뀌면) 예턴의 부곡 칸 선택지(내 부곡, 국가 부곡)를 다시 받는다.
// 다음 턴 시각을 이미 새로 받은 뒤에 부르므로, 턴 커밋 전 스냅샷을 읽은 부곡 응답이 남지 않는다.
// 실시간 알림(turn.result)이 같은 일을 먼저 했어도 한 번 더 받을 뿐이다. 첫 값과 다른 월드로 옮긴 것은 턴 진행이 아니다.
export function useUnitsAfterTurn(worldId: string, nextTurnAt: string | null) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const last = useRef<{ worldId: string; at: string | null } | undefined>(undefined);
  useEffect(() => {
    const previous = last.current;
    last.current = { worldId, at: nextTurnAt };
    if (!previous || previous.worldId !== worldId || nextTurnAt === null || previous.at === nextTurnAt) return;
    void queryClient.invalidateQueries({ queryKey: trpc.campaign.get.queryKey({ worldId }) });
    void queryClient.invalidateQueries({ queryKey: trpc.campaign.nationUnits.queryKey({ worldId }) });
  }, [worldId, nextTurnAt, queryClient, trpc]);
}
