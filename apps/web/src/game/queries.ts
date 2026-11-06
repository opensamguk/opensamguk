import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { worldUnits, type WorldUnits } from '../battleSim/unitChoices';
import { useTRPC } from '../trpc';
import { retryUnlessClientError } from './errors';
import { summaryPollMs } from './worldWatch';

// 게임 화면은 모두 /w/$worldId 아래에 있다.
export function useWorldId(): string {
  return useParams({ from: '/w/$worldId' }).worldId;
}

// 같은 쿼리 키를 쓰므로 위쪽 띠·왼쪽 요약·메인이 요청 하나를 나눠 쓴다.
// 주기 조회는 위쪽 띠(watch) 한 곳에서만 켠다. 관찰자마다 켜면 같은 주기에 요청이 겹친다.
export function useWorldSummary(worldId: string, watch = false) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.world.summary.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: watch ? (query) => summaryPollMs(query.state.data, query.state.error) : false,
  });
}

// 끝난 판이면 예턴·장수 화면의 주기 조회도 멈춘다. 같은 world.summary 캐시를 읽기만 한다.
export function useWorldEnded(worldId: string): boolean {
  return useWorldSummary(worldId).data?.status === 'ENDED';
}

export function useHome(worldId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.home.get.queryOptions({ worldId }), retry: retryUnlessClientError });
}

export function useWorldMap(worldId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.world.map.queryOptions({ worldId }), retry: retryUnlessClientError, staleTime: 30_000 });
}

// 월드 병종표·능력치 규칙 (T4-85 resources.worldRules). 전투 시뮬레이터와 명령 병종 칸이 같은 캐시를 쓴다 (T4-86).
// 조회 캐시의 구조 공유로 내용이 같으면 unitSet 참조가 그대로라 다시 받아도 Worker를 끝내지 않는다.
export function useWorldRules(worldId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.resources.worldRules.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    staleTime: 30_000,
  });
}

// 명령 병종 칸과 예턴 표의 병종 이름 (T4-86). 불러오는 중·오류면 빈 목록과 이유다. 병종 없는 명령·표·저장은 막지 않는다.
export function useWorldUnits(worldId: string): { units: WorldUnits; note: string | null } {
  const rules = useWorldRules(worldId);
  const unitSet = rules.data?.unitSet;
  const units = useMemo(() => worldUnits(unitSet), [unitSet]);
  const note = unitSet
    ? null
    : rules.isError
      ? '이 월드의 병종표를 불러오지 못했습니다. 병종 없는 명령은 그대로 넣을 수 있습니다.'
      : '병종표를 불러오는 중입니다.';
  return { units, note };
}
