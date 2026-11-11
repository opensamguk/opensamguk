import { hashKey, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useLayoutEffect, useState } from 'react';
import { isNotFound, retryUnlessClientError } from '../game/errors';
import { useHome } from '../game/queries';
import { NoGeneral } from '../game/QueryState';
import type { MapCity } from '../game/types';
import { useAuthority } from '../messages/authority';
import { useTRPC } from '../trpc';
import { ErrorState, LoadingState } from '../ui/States';
import { IntelRecordsPanel } from './IntelRecordList';

// 기록 화면의 첩보 기록 탭(T4-13 §1.2·§1.3). 기능 켜짐·소속 판정은 서버 응답이 정한다.
// 기록은 국가 몫이라 메시지와 같은 권한 경계(messages/authority.ts)를 쓴다. 권한 값이 정해지기 전에는 묻지도 그리지도 않고,
// 소속이 바뀌거나 서버가 권한을 거두면 그 경계가 이 키를 비운다. 로그인·로그아웃은 queryClient.clear()가 비운다.
export function IntelRecordsTab({
  worldId,
  cities,
}: {
  worldId: string;
  cities: readonly Pick<MapCity, 'key' | 'name' | 'nationId'>[];
}) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const home = useHome(worldId);
  const authority = useAuthority(worldId);
  const fetched = useFetchedThisMount(trpc.intel.records.queryKey({ worldId }));
  const records = useQuery({
    // abortOnUnmount가 없으면 tRPC가 signal을 null로 넘겨 마지막 관찰자가 내려가도 진행 중인 예전 조회가 살아남는다.
    // 그러면 다시 연 탭의 refetchOnMount가 그 조회에 합류하고, 그 답의 success 알림을 이번 마운트의 답으로 오인한다.
    // 켜 두면 TanStack이 signal을 소비한 조회를 마지막 관찰자가 내려갈 때 취소하고, 다시 연 탭은 새 요청을 보낸다.
    ...trpc.intel.records.queryOptions({ worldId }, { trpc: { abortOnUnmount: true } }),
    enabled: authority.ready,
    retry: retryUnlessClientError,
    refetchOnMount: 'always',
  });

  if (home.isError && isNotFound(home.error)) return <NoGeneral worldId={worldId} />;
  if (!authority.ready) {
    if (home.isError) return <ErrorState title="불러오지 못했습니다" onRetry={() => void home.refetch()} />;
    return <LoadingState />;
  }
  if (records.isError) {
    if (isNotFound(records.error)) return <NoGeneral worldId={worldId} />;
    return <ErrorState title="불러오지 못했습니다" onRetry={() => void records.refetch()} />;
  }
  if (records.isPending || !fetched) return <LoadingState />;
  return (
    <IntelRecordsPanel
      data={records.data}
      ronin={authority.nationId === null}
      cities={cities}
      onSelectCity={(city) => void navigate({ to: '/w/$worldId', params: { worldId }, search: { city } })}
      onReload={() => void records.refetch()}
      reloading={records.isFetching}
    />
  );
}

// 이 마운트 뒤에 서버가 이 키에 성공으로 답했는지. 탭을 다시 열면 캐시에 남은 기록이 있어 isPending이 false이고
// refetchOnMount 응답이 오기 전까지 그 기록이 그려진다. 그 기록은 예전 소속이나 예전 마운트의 답일 수 있으므로 믿지 않는다.
// isFetchedAfterMount는 쓰지 않는다. 권한 경계가 마운트 중에 키를 비우면 dataUpdateCount가 0부터 다시 세어져
// 마운트 때 횟수를 넘을 때까지 새 답도 막기 때문이다. 대신 cache 알림에서 서버 성공(setQueryData가 아닌 것)을 직접 본다.
// 구독은 useLayoutEffect에서 건다. useQuery의 마운트 조회는 passive effect에서 시작하므로 첫 응답을 놓치지 않는다
// (messages/authority.ts의 같은 설명). 캐시 비우기로 query가 지워지면 다시 서버 성공을 기다린다.
function useFetchedThisMount(queryKey: QueryKey): boolean {
  const queryClient = useQueryClient();
  const hash = hashKey(queryKey);
  // 성공을 본 키를 적는다. 월드가 바뀌면 키가 달라지므로 따로 되돌리지 않아도 새 키의 성공을 기다린다.
  const [fetchedHash, setFetchedHash] = useState<string | null>(null);
  useLayoutEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash !== hash) return;
        if (event.type === 'removed') setFetchedHash(null);
        else if (event.type === 'updated' && event.action.type === 'success' && !event.action.manual)
          setFetchedHash(hash);
      }),
    [queryClient, hash],
  );
  return fetchedHash === hash;
}
