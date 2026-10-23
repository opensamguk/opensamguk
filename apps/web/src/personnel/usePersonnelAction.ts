import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTRPC } from '../trpc';
import { errorCode } from '../turns/apiError';
import { personnelKeys, usePersonnelApi, type ActionInput, type PersonnelKind } from './contract';
import {
  announcedKey,
  markAnnounced,
  newRequestId,
  noticeFor,
  readAnnounced,
  recover,
  sendAction,
  type Notice,
} from './request';

export type ActionPhase =
  | { phase: 'idle' }
  // 보내는 중이거나 엔진이 끝내기를 기다리는 중. 버튼은 막고 처리 중을 보인다.
  | { phase: 'busy'; requestId: string; kind: PersonnelKind; target: string; polling: boolean };

const localStore = () => (typeof window === 'undefined' ? undefined : window.localStorage);

interface Options {
  worldId: string;
  // 이 화면이 맡은 종류. 다시 접속했을 때 personnel.recent에서 이 종류만 되살린다.
  kinds: readonly PersonnelKind[];
  nameOf?: (generalId: number) => string | undefined;
}

// 한 화면(메인 제안 상자, 인사부)의 즉시 행동 하나를 접수부터 결과까지 다룬다.
// 한 행위자의 인사 접수는 하나뿐이라(T2-05) 화면도 한 번에 하나만 보낸다.
export function usePersonnelAction({ worldId, kinds, nameOf }: Options) {
  const api = usePersonnelApi();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const href = useRouterState({ select: (state) => state.location.href });
  const me = useQuery({ ...trpc.auth.me.queryOptions(), retry: false });
  const userId = me.data?.user?.id;
  const storageKey = userId ? announcedKey(userId, worldId) : null;

  const [state, setState] = useState<ActionPhase>({ phase: 'idle' });
  const [notices, setNotices] = useState<Notice[]>([]);
  // 같은 버튼을 빠르게 두 번 눌러도 두 번째는 보내지 않는다. 상태 갱신보다 먼저 막는다.
  const busy = useRef(false);
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;

  const toLogin = useCallback(() => void navigate({ to: '/login', search: { next: href } }), [navigate, href]);

  // 결과를 받은 뒤 다시 받는 조회. 개인 예턴(turns.get)과 지도 선택은 건드리지 않는다.
  const refresh = useCallback(() => {
    for (const queryKey of [
      personnelKeys.offers(worldId),
      personnelKeys.officers(worldId),
      personnelKeys.nationTurns(worldId),
    ])
      void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
  }, [queryClient, trpc, worldId]);

  // 끝난 접수. 거절이어도 제안·직책 상태가 바뀌었을 수 있으므로 다시 받는다.
  const finish = useCallback(
    (requestId: string, notice: Notice | null) => {
      if (storageKey) markAnnounced(localStore(), storageKey, requestId);
      busy.current = false;
      setState({ phase: 'idle' });
      if (notice) setNotices([notice]);
      refresh();
    },
    [storageKey, refresh],
  );

  const submit = useCallback(
    async (action: ActionInput, target: string) => {
      if (busy.current) return;
      busy.current = true;
      const requestId = newRequestId();
      setNotices([]);
      setState({ phase: 'busy', requestId, kind: action.kind, target, polling: false });
      const outcome = await sendAction(api, worldId, requestId, action);
      if (outcome.type === 'error') {
        if (outcome.code === 'UNAUTHORIZED') return toLogin();
        busy.current = false;
        setState({ phase: 'idle' });
        setNotices([{ tone: 'error', text: outcome.message }]);
        return;
      }
      if (outcome.type === 'lost' || outcome.state.status === 'pending') {
        setState({ phase: 'busy', requestId, kind: action.kind, target, polling: true });
        return;
      }
      finish(
        requestId,
        noticeFor(action.kind, outcome.state, (id) => nameRef.current?.(id)),
      );
    },
    [api, worldId, toLogin, finish],
  );

  // pending이면 personnel.request를 1초마다 묻는다.
  const polling = state.phase === 'busy' && state.polling ? state : null;
  const request = useQuery({
    queryKey: personnelKeys.request(worldId, polling?.requestId ?? ''),
    queryFn: () => api.request({ worldId, requestId: polling!.requestId }),
    enabled: polling !== null,
    refetchInterval: 1_000,
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (!polling) return;
    if (request.isError) {
      const code = errorCode(request.error);
      if (code === 'UNAUTHORIZED') toLogin();
      else if (code === 'NOT_FOUND') {
        // 두 번 보낸 요청이 서버에 닿지 않았다. 다시 누를 수 있게 연다.
        busy.current = false;
        setState({ phase: 'idle' });
        setNotices([{ tone: 'error', text: '요청이 서버에 닿지 않았습니다. 연결을 확인하고 다시 누르세요.' }]);
      }
      return;
    }
    const record = request.data;
    if (!record || record.state.status === 'pending') return;
    finish(
      polling.requestId,
      noticeFor(polling.kind, record.state, (id) => nameRef.current?.(id)),
    );
  }, [polling, request.data, request.isError, request.error, toLogin, finish]);

  // 새로 고치거나 다시 접속하면 personnel.recent로 대기 중이거나 이미 끝난 접수를 되살린다. 화면을 열 때 한 번만 본다.
  const recent = useQuery({
    queryKey: personnelKeys.recent(worldId),
    queryFn: () => api.recent({ worldId }),
    enabled: storageKey !== null,
    retry: false,
    staleTime: Infinity,
  });
  const recovered = useRef(false);
  const kindsKey = kinds.join(',');
  useEffect(() => {
    if (recovered.current || !storageKey) return;
    if (recent.isError) {
      recovered.current = true;
      if (errorCode(recent.error) === 'UNAUTHORIZED') toLogin();
      return;
    }
    if (!recent.data) return;
    recovered.current = true;
    const { pending, unannounced } = recover(
      recent.data,
      kindsKey.split(',') as PersonnelKind[],
      readAnnounced(localStore(), storageKey),
    );
    const found = unannounced
      .map((record) => {
        markAnnounced(localStore(), storageKey, record.state.requestId);
        return noticeFor(record.kind, record.state, (id) => nameRef.current?.(id));
      })
      .filter((notice): notice is Notice => notice !== null);
    if (found.length > 0) {
      setNotices(found);
      refresh();
    }
    if (pending && !busy.current) {
      busy.current = true;
      setState({
        phase: 'busy',
        requestId: pending.state.requestId,
        kind: pending.kind,
        target: '',
        polling: true,
      });
    }
  }, [recent.data, recent.isError, recent.error, storageKey, kindsKey, toLogin, refresh]);

  return {
    state,
    notices,
    busy: state.phase === 'busy',
    // 지금 처리 중인 대상(버튼 하나만 처리 중으로 보이게). 다시 접속해 되살린 접수는 대상을 모른다.
    busyTarget: state.phase === 'busy' ? state.target : null,
    submit,
    dismissNotices: () => setNotices([]),
  };
}
