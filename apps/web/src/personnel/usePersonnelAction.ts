import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTRPC } from '../trpc';
import { errorCode } from '../turns/apiError';
import { personnelKeys, usePersonnelApi, type ActionInput, type PersonnelKind } from './contract';
import {
  announcedKey,
  checkAction,
  markAnnounced,
  newRequestId,
  noticeFor,
  readAnnounced,
  recover,
  sendAction,
  type CheckOutcome,
  type Notice,
  type SendOutcome,
} from './request';

export type ActionPhase =
  | { phase: 'idle' }
  | {
      phase: 'sending' | 'busy';
      requestId: string;
      kind: PersonnelKind;
      target: string;
      refusal: Extract<SendOutcome, { type: 'error' }> | null;
    };

const localStore = () => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};
interface Options {
  worldId: string;
  kinds: readonly PersonnelKind[];
  nameOf?: (generalId: number) => string | undefined;
}

// 전송과 접수를 구분한다. 처리 중은 서버가 같은 requestId를 확인한 뒤에만 보인다.
export function usePersonnelAction({ worldId, kinds, nameOf }: Options) {
  const api = usePersonnelApi();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const href = useRouterState({ select: (state) => state.location.href });
  const me = useQuery({ ...trpc.auth.me.queryOptions(), retry: false });
  const userId = me.data?.user?.id;
  const storageKey = userId ? announcedKey(userId, worldId) : null;
  const kindsKey = kinds.join(',');
  const scope = storageKey ? storageKey + ':' + kindsKey : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, []);

  const [scopedState, setState] = useState<{ scope: string | null; value: ActionPhase }>({
    scope: null,
    value: { phase: 'idle' },
  });
  const [scopedNotices, setNotices] = useState<{ scope: string | null; value: Notice[] }>({ scope: null, value: [] });
  const state: ActionPhase = scopedState.scope === scope ? scopedState.value : { phase: 'idle' };
  const notices = scopedNotices.scope === scope ? scopedNotices.value : [];
  // 상태 갱신보다 먼저 연타를 막고, 이전 계정·월드의 늦은 응답은 버린다.
  const active = useRef<{ scope: string; requestId: string } | null>(null);
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;
  const isActive = useCallback(
    (requestId: string) =>
      scope !== null &&
      scopeRef.current === scope &&
      active.current?.scope === scope &&
      active.current.requestId === requestId,
    [scope],
  );
  const toLogin = useCallback(() => void navigate({ to: '/login', search: { next: href } }), [navigate, href]);

  // 개인 예턴 초안과 지도 선택은 건드리지 않는다.
  const refresh = useCallback(() => {
    for (const queryKey of [
      personnelKeys.offers(worldId),
      personnelKeys.officers(worldId),
      personnelKeys.nationTurns(worldId),
    ])
      void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
  }, [queryClient, trpc, worldId]);
  const finish = useCallback(
    (requestId: string, notice: Notice | null) => {
      if (!isActive(requestId) || !storageKey) return;
      active.current = null;
      setState({ scope, value: { phase: 'idle' } });
      const announced = readAnnounced(localStore(), storageKey).includes(requestId);
      markAnnounced(localStore(), storageKey, requestId);
      if (notice && !announced) setNotices({ scope, value: [notice] });
      refresh();
    },
    [isActive, storageKey, scope, refresh],
  );
  const receive = useCallback(
    (requestId: string, kind: PersonnelKind, outcome: CheckOutcome) => {
      if (!isActive(requestId)) return;
      if (outcome.type === 'lost' || outcome.type === 'absent') return;
      if (outcome.type === 'error') {
        active.current = null;
        setState({ scope, value: { phase: 'idle' } });
        if (outcome.code === 'UNAUTHORIZED') toLogin();
        else setNotices({ scope, value: [{ tone: 'error', text: outcome.message }] });
        return;
      }
      if (outcome.type === 'state' && outcome.state.status !== 'pending') {
        finish(
          requestId,
          noticeFor(kind, outcome.state, (id) => nameRef.current?.(id)),
        );
        return;
      }
      setState((current) => {
        if (current.scope !== scope || current.value.phase === 'idle' || current.value.requestId !== requestId)
          return current;
        if (current.value.phase === 'busy') return current;
        return {
          scope,
          value: {
            ...current.value,
            // 접수 확인 뒤에 늦게 온 전송 결과로 보내는 중으로 되돌리지 않는다.
            phase: 'busy',
          },
        };
      });
    },
    [isActive, scope, finish, toLogin],
  );
  const submit = useCallback(
    async (action: ActionInput, target: string) => {
      if (!scope || active.current?.scope === scope || !kindsKey.split(',').includes(action.kind)) return;
      const requestId = newRequestId();
      active.current = { scope, requestId };
      const started = generation.current;
      const current = () => generation.current === started && isActive(requestId);
      setNotices({ scope, value: [] });
      setState({ scope, value: { phase: 'sending', requestId, kind: action.kind, target, refusal: null } });
      const outcome = await sendAction(api, worldId, requestId, action, current);
      if (!current()) return;
      if (outcome.type === 'error' && outcome.code !== 'UNAUTHORIZED') {
        // mutation의 오류는 접수 전 거부 또는 이미 끝난 엔진 거절일 수 있다.
        // 새 조회로 기록을 확인한 뒤 미접수 거부와 완료 안내를 나눈다.
        setState((previous) => {
          if (previous.scope !== scope || previous.value.phase === 'idle' || previous.value.requestId !== requestId)
            return previous;
          return { scope, value: { ...previous.value, refusal: outcome } };
        });
      } else receive(requestId, action.kind, outcome);
    },
    [scope, kindsKey, isActive, api, worldId, receive],
  );

  // mutation은 접수 뒤에도 최대 5초 기다린다. 병행 조회로 접수를 확인하고 초기 NOT_FOUND는 기다린다.
  const polling = state.phase === 'idle' ? null : state;
  const request = useQuery({
    queryKey: [...personnelKeys.request(worldId, polling?.requestId ?? ''), userId, Boolean(polling?.refusal)],
    queryFn: () => checkAction(api, worldId, polling!.requestId),
    enabled: polling !== null,
    refetchInterval: 1_000,
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (polling && request.data)
      receive(
        polling.requestId,
        polling.kind,
        request.data.type === 'absent' && polling.refusal ? polling.refusal : request.data,
      );
  }, [polling, request.data, receive]);

  // 계정별로 새로 읽는다. 같은 QueryClient로 다시 붙여도 과거의 빈 recent를 재사용하지 않는다.
  const recent = useQuery({
    queryKey: [...personnelKeys.recent(worldId), userId],
    queryFn: () => api.recent({ worldId }),
    enabled: scope !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const recovered = useRef<string | null>(null);
  useEffect(() => {
    if (!scope || !storageKey || recovered.current === scope || recent.isFetching || active.current?.scope === scope)
      return;
    if (recent.isError) {
      recovered.current = scope;
      if (errorCode(recent.error) === 'UNAUTHORIZED') toLogin();
      return;
    }
    if (!recent.data) return;
    recovered.current = scope;
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
      setNotices({ scope, value: found });
      refresh();
    }
    if (pending) {
      active.current = { scope, requestId: pending.state.requestId };
      setState({
        scope,
        value: {
          phase: 'busy',
          requestId: pending.state.requestId,
          kind: pending.kind,
          target: '',
          refusal: null,
        },
      });
    }
  }, [
    recent.data,
    recent.isFetching,
    recent.isError,
    recent.error,
    scope,
    storageKey,
    kindsKey,
    state.phase,
    toLogin,
    refresh,
  ]);
  return {
    state,
    notices,
    busy: state.phase !== 'idle',
    busyLabel: state.phase === 'sending' ? '보내는 중' : '처리 중',
    busyTarget: state.phase === 'idle' ? null : state.target,
    submit,
    dismissNotices: () => setNotices({ scope, value: [] }),
  };
}
