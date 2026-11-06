import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../trpc';

// 인사 기능이 있는 월드인지. 서버 general.mine.creationRules.personnelEnabled가 정본이다 (PR377).
// 키가 없거나(구형 서버) 아직 불러오는 중이면 꺼진 것으로 보아 인사 조회를 부르지 않는다. 없는 기능에 412를 받지 않는다.
export function usePersonnelEnabled(worldId: string): boolean {
  const trpc = useTRPC();
  const mine = useQuery({ ...trpc.general.mine.queryOptions({ worldId }), retry: false });
  return mine.data?.creationRules.personnelEnabled === true;
}
