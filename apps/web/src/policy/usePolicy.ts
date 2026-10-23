import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTRPC } from '../trpc';
import { errorCode, retryUnlessClientError, serverMessage } from '../turns/apiError';
import type { PolicyKey, PolicyRejection, PolicyResponse } from './types';

// 엔진이 방침 입력을 집행할 때까지 다시 묻는 간격.
const PENDING_POLL_MS = 2_000;

// 처리 중인 방침이 있을 때만 다시 묻는다. 확정되면 멈춘다.
export function policyPollMs(data: Pick<PolicyResponse, 'pending'> | undefined): number | false {
  return data?.pending ? PENDING_POLL_MS : false;
}

// 지금 방침 조회. 예턴 편집기의 빈 칸 표시와 방침 고르기가 같은 쿼리를 나눠 쓴다.
export function usePolicyQuery(worldId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.general.policy.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: (query) => policyPollMs(query.state.data),
  });
}

export type PolicyChangeError = { kind: 'auth' } | { kind: 'error'; message: string };

export function setPolicyErrorMessage(error: unknown): PolicyChangeError {
  const code = errorCode(error);
  if (code === 'UNAUTHORIZED') return { kind: 'auth' };
  if (code === 'CONFLICT')
    return { kind: 'error', message: '먼저 고른 방침을 아직 처리하는 중입니다. 처리된 뒤에 다시 고르세요.' };
  return {
    kind: 'error',
    message: serverMessage(error) ?? '방침을 보내지 못했습니다. 연결을 확인하고 다시 고르세요.',
  };
}

// 방침 바꾸기는 예턴 저장과 따로 고르는 즉시 보낸다 (T2-13 방침 바꾸기 처리).
// applied를 받으면 그 응답으로 바로 확정한다. pending이면 고른 값을 처리 중으로 두고 general.policy를 다시 읽는다.
// 장수 정보 칸의 방침 이름은 useHomePolicySync가 확정된 current를 따라 맞춘다.
export function usePolicyChange(worldId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const key = trpc.general.policy.queryKey({ worldId });
  const [asked, setAsked] = useState<PolicyKey | null>(null);
  const [error, setError] = useState<PolicyChangeError | null>(null);

  const mutation = useMutation({
    ...trpc.general.setPolicy.mutationOptions(),
    onSuccess: (outcome, input) => {
      if (outcome.status === 'applied') queryClient.setQueryData(key, outcome.policy);
      else {
        // 다시 읽은 값이 올 때까지 고른 방침을 처리 중으로 둔다. 그래야 고르기 칸이 잠깐 옛 값으로 돌아가지 않는다.
        queryClient.setQueryData(key, (prev) => (prev ? { ...prev, pending: input.policy } : prev));
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (err) => {
      setError(setPolicyErrorMessage(err));
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const choose = (policy: PolicyKey) => {
    setError(null);
    setAsked(policy);
    mutation.mutate({ worldId, policy });
  };

  return { choose, asked, error, sending: mutation.isPending, sendingPolicy: mutation.variables?.policy ?? null };
}

// 확정된 방침(current)이 바뀌면 그때 home.get을 다시 읽어 장수 정보 칸의 방침 이름을 맞춘다.
// applied 응답이든, pending 뒤 다시 읽기로 엔진 적용을 확인했든 같은 시점이다. 캐시의 이름이 이미 같으면 다시 읽지 않는다.
// 예턴 조회와 초안은 건드리지 않는다.
export function useHomePolicySync(worldId: string, current: PolicyKey | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const seen = useRef(current);
  useEffect(() => {
    const before = seen.current;
    seen.current = current;
    if (current === undefined || before === undefined || before === current) return;
    const homeKey = trpc.home.get.queryKey({ worldId });
    const home = queryClient.getQueryData(homeKey);
    if (home && home.general.policy.key !== current)
      void queryClient.invalidateQueries({ queryKey: homeKey, exact: true });
  }, [current, queryClient, trpc, worldId]);
}

export type PolicyView = {
  // 고르기 칸에 보일 값. 보내는 중이거나 엔진이 처리 중이면 고른 값, 아니면 확정된 값이다.
  selected: PolicyKey;
  processing: boolean;
  // 이번에 고른 방침이 확정됐다. 마지막 입력이 거절됐으면 current가 같아도 확정이 아니다.
  confirmed: boolean;
  rejected: PolicyRejection | null;
};

// 서버의 lastRejected는 내 가장 최근 방침 입력이 거절됐을 때만 오고, 그 뒤 입력이 적용되면 null이 된다.
// 그래서 거절된 방침이 지금 current와 같아도 실제 거절이므로 그대로 보인다.
export function policyView(
  data: PolicyResponse,
  change: { asked: PolicyKey | null; sending: boolean; sendingPolicy: PolicyKey | null },
): PolicyView {
  const processing = change.sending || data.pending !== null;
  const selected = (change.sending ? change.sendingPolicy : null) ?? data.pending ?? data.current;
  const rejected = processing ? null : data.lastRejected;
  return {
    selected,
    processing,
    confirmed: !processing && rejected === null && change.asked !== null && change.asked === data.current,
    rejected,
  };
}
