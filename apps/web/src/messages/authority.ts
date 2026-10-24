import type { AppRouter } from '@opensamguk/server/router';
import { hashKey, useQuery, useQueryClient, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { useTRPC, type Trpc } from '../trpc';

// 메시지·공지 화면의 권한 경계 (계획 T2-10 "실제 API 연결 보완").
// 국가·외교 범위와 공지 고치기는 서버가 현재 소속·직책으로 정한다. 화면은 home.get에서 그 값이 바뀐 것만 알아채고
// 권한에 따라 답이 달라지는 키를 비운 뒤 서버에 다시 묻는다. 무엇을 보여 줄지는 서버 응답(unread의 null, canEdit)이 정한다.
// epoch는 권한 값이 정해지거나 바뀌거나 사라질 때마다 오른다. 비동기 요청은 시작할 때 epoch를 잡아 두고 응답이 왔을 때
// epoch가 다르면 캐시와 화면에 넣지 않는다. 늦게 온 예전 국가의 응답이 새 권한의 화면을 되살리지 않게 하려는 것이다.

type Home = inferRouterOutputs<AppRouter>['home']['get'];

export interface Authority {
  nationId: number | null;
  officerLevel: number;
}

interface State {
  epoch: number;
  authority: Authority | null;
}

const EMPTY: State = { epoch: 0, authority: null };
const states = new Map<string, State>();
const listeners = new Set<() => void>();

function read(worldId: string): State {
  return states.get(worldId) ?? EMPTY;
}

function write(worldId: string, authority: Authority | null) {
  states.set(worldId, { epoch: read(worldId).epoch + 1, authority });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function authorityEpoch(worldId: string): number {
  return read(worldId).epoch;
}

// 화면이 읽는 권한 상태. ready가 false면 이 탭에서 아직 home.get을 새로 받지 않았거나 서버가 권한을 거뒀으므로
// 권한에 딸린 칸과 캐시에 남은 메시지·공지를 그리지 않는다.
export function useAuthority(worldId: string) {
  const state = useSyncExternalStore(
    subscribe,
    () => read(worldId),
    () => EMPTY,
  );
  return { ready: state.authority !== null, epoch: state.epoch, nationId: state.authority?.nationId ?? null };
}

// 권한에 따라 답이 달라지는 키. 첫 값을 정하거나 권한을 거둘 때는 이 월드의 메시지·공지 키를 모두 비운다.
// 다른 세션이나 이전 마운트 때 남은 캐시를 믿지 않으려는 것이다.
function messagingKeys(trpc: Trpc, worldId: string, all: boolean): QueryKey[] {
  const keys: QueryKey[] = [
    trpc.message.unread.queryKey({ worldId }),
    trpc.message.recipients.queryKey({ worldId }),
    trpc.notice.nation.get.queryKey({ worldId }),
    trpc.message.list.infiniteQueryKey({ worldId, scope: 'NATION' }),
    trpc.message.list.infiniteQueryKey({ worldId, scope: 'DIPLOMACY' }),
  ];
  if (!all) return keys;
  return [
    ...keys,
    trpc.message.list.infiniteQueryKey({ worldId, scope: 'PRIVATE' }),
    trpc.message.list.infiniteQueryKey({ worldId, scope: 'WORLD' }),
    trpc.notice.world.list.queryKey({ worldId }),
  ];
}

// data를 비운다. query.reset()(resetQueries도 이것을 부른다)은 진행 중인 요청을 조용히 취소하고 signal을 abort한 뒤
// 처음 상태로 돌리므로 따로 취소하지 않는다. 비운 뒤 epoch를 올리므로 ready인 화면은 새 응답 전 빈 상태만 본다.
// refetch가 false면 비우기만 한다. 권한을 거둘 때 resetQueries를 쓰면 아직 켜져 있는 관찰자가 곧바로 다시 물어
// 거둔 뒤의 캐시를 다시 채우기 때문이다.
function clearKeys(queryClient: QueryClient, keys: QueryKey[], refetch: boolean) {
  for (const queryKey of keys) {
    if (refetch) void queryClient.resetQueries({ queryKey });
    else for (const query of queryClient.getQueryCache().findAll({ queryKey })) query.reset();
  }
}

// 서버가 확정한 권한 오류. 로그인이 풀렸거나(UNAUTHORIZED) 이 월드에 내 장수가 없으면(NOT_FOUND) 메시지·공지를 볼 수 없다.
// 연결 실패처럼 코드가 없는 오류는 권한 회수로 보지 않는다. 그동안에도 화면과 초안을 그대로 쓴다.
const DENIED = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND']);

// 게임 화면 한 탭에 하나만 둔다. GameLayout에 늘 붙어 있는 메시지 단추(MessageDock.tsx)가 부른다.
// 권한 값은 React effect가 아니라 home.get query의 cache 알림에서 바로 정한다. 새 home 응답이 캐시에 들어온 순간
// epoch가 오르므로, 그 뒤에 끝나는 예전 요청의 응답은 화면이 다시 그려지기 전이라도 막힌다.
// 믿는 응답은 서버가 다시 성공했는지로 고른다. 마운트할 때와 서버가 권한을 거둘 때 그때의 성공 횟수(dataUpdateCount)를 적어 두고
// 그보다 나중의 서버 성공만 쓴다. 시각을 비교하지 않으므로 같은 밀리초에 온 새 성공도 믿고, 거절 뒤 연결 실패가 오류를 덮어써도
// 예전 값으로 돌아가지 않는다. setQueryData로 넣은 값은 서버 응답이 아니라서 보지 않는다.
// 로그아웃·로그인이 queryClient.clear()로 home query를 지우면 Watch가 내려가기 전이라도 바로 권한을 거둔다.
// 그 사이 끝나는 예전 요청의 응답은 epoch가 달라 막히고, 새로 만들어진 home query의 서버 성공이 와야 다시 믿는다.
//
// 구독은 useLayoutEffect에서 건다. useQuery의 마운트 조회는 관찰자를 구독하는 순간(useSyncExternalStore 구독, passive
// effect)에 시작한다. React는 한 commit의 layout effect를 모두 끝낸 뒤 passive effect를 돌리므로, 같은 commit에 마운트된
// 어떤 home.get 관찰자의 첫 조회도 이 구독과 기준 횟수를 잡기 전에는 시작하지 않는다. 그래서 첫 서버 성공을 놓치지 않는다.
export function useAuthorityWatch(worldId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // 화면의 다른 home.get 관찰자와 같은 query다. 마운트할 때 한 번 새로 받는다.
  useQuery({
    ...trpc.home.get.queryOptions({ worldId }),
    refetchOnMount: 'always',
    retry: retryUnlessClientError,
  });

  useLayoutEffect(() => {
    const cache = queryClient.getQueryCache();
    const homeHash = hashKey(trpc.home.get.queryKey({ worldId }));
    let tracked: Query | undefined = cache.get(homeHash);
    // 이 마운트 전에 받은 값과 오류는 쓰지 않는다.
    let minSuccess = (tracked?.state.dataUpdateCount ?? 0) + 1;
    let seenErrors = tracked?.state.errorUpdateCount ?? 0;

    const sync = (query: Query) => {
      if (query !== tracked) {
        // 캐시를 비워 query가 새로 만들어졌다. 새 query의 첫 서버 성공부터 쓴다.
        tracked = query;
        minSuccess = 1;
        seenErrors = 0;
      }
      const state = query.state;
      if (state.errorUpdateCount > seenErrors) {
        seenErrors = state.errorUpdateCount;
        if (state.status === 'error' && DENIED.has(errorCode(state.error) ?? '')) {
          minSuccess = state.dataUpdateCount + 1;
          if (read(worldId).authority === null) return;
          clearKeys(queryClient, messagingKeys(trpc, worldId, true), false);
          write(worldId, null);
          return;
        }
      }
      if (state.status !== 'success' || state.dataUpdateCount < minSuccess) return;
      const general = (state.data as Home | undefined)?.general;
      if (!general) return;
      const previous = read(worldId).authority;
      if (previous && previous.nationId === general.nationId && previous.officerLevel === general.officerLevel) return;
      clearKeys(queryClient, messagingKeys(trpc, worldId, previous === null), true);
      write(worldId, { nationId: general.nationId, officerLevel: general.officerLevel });
    };

    const unsubscribe = cache.subscribe((event) => {
      // 이 월드의 home.get만 본다. 다른 query가 지워지거나 바뀌어도 권한은 그대로다.
      if (event.query.queryHash !== homeHash) return;
      if (event.type === 'removed') {
        // 캐시 비우기로 home query가 사라졌다. 남은 권한 값을 믿지 않고 바로 거둔다. 다른 메시지·공지 query도 같이
        // 지워졌으므로 비울 것은 없다. 새 query의 첫 서버 성공부터 다시 쓴다.
        if (event.query === tracked) tracked = undefined;
        write(worldId, null);
        return;
      }
      if (event.type !== 'updated') return;
      const action = event.action;
      if ((action.type === 'success' && !action.manual) || action.type === 'error') sync(event.query);
    });
    // 내려가면 권한 값을 지운다. 다시 마운트하면 새로 받은 값으로 처음부터 정한다.
    return () => {
      unsubscribe();
      write(worldId, null);
    };
  }, [queryClient, trpc, worldId]);
}
