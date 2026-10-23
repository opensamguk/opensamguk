import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '../trpc';
import { errorCode, retryUnlessClientError, serverMessage } from '../turns/apiError';
import { policyProcedures, type PolicyKey, type PolicyResponse } from './contract';

// 엔진이 방침 입력을 집행할 때까지 다시 묻는 간격.
const PENDING_POLL_MS = 2_000;

// 지금 방침 조회. 예턴 편집기의 빈 칸 표시와 방침 고르기가 같은 쿼리를 나눠 쓴다.
export function usePolicyQuery(worldId: string) {
  const api = policyProcedures(useTRPC());
  return useQuery({
    ...api.policy.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: (query) => (query.state.data?.pending ? PENDING_POLL_MS : false),
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
export function usePolicyChange(worldId: string) {
  const trpc = useTRPC();
  const api = policyProcedures(trpc);
  const queryClient = useQueryClient();
  const key = api.policy.queryKey({ worldId });
  const [asked, setAsked] = useState<PolicyKey | null>(null);
  const [error, setError] = useState<PolicyChangeError | null>(null);

  const mutation = useMutation({
    ...api.setPolicy.mutationOptions(),
    onSuccess: (outcome, input) => {
      if (outcome.status === 'applied') queryClient.setQueryData(key, outcome.policy);
      else {
        // 다시 읽은 값이 올 때까지 고른 방침을 처리 중으로 둔다. 그래야 고르기 칸이 잠깐 옛 값으로 돌아가지 않는다.
        queryClient.setQueryData<PolicyResponse>(key, (prev) => (prev ? { ...prev, pending: input.policy } : prev));
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (err) => {
      setError(setPolicyErrorMessage(err));
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) }),
  });

  const choose = (policy: PolicyKey) => {
    setError(null);
    setAsked(policy);
    mutation.mutate({ worldId, policy });
  };

  return { choose, asked, error, sending: mutation.isPending, sendingPolicy: mutation.variables?.policy ?? null };
}

export type PolicyView = {
  // 고르기 칸에 보일 값. 보내는 중이거나 엔진이 처리 중이면 고른 값, 아니면 확정된 값이다.
  selected: PolicyKey;
  processing: boolean;
  // 이번에 고른 방침이 확정됐다.
  confirmed: boolean;
  rejected: { policy: PolicyKey; reason: string } | null;
};

export function policyView(
  data: PolicyResponse,
  change: { asked: PolicyKey | null; sending: boolean; sendingPolicy: PolicyKey | null },
): PolicyView {
  const processing = change.sending || data.pending !== null;
  const selected = (change.sending ? change.sendingPolicy : null) ?? data.pending ?? data.current;
  const rejected =
    !processing && data.lastRejected && data.lastRejected.policy !== data.current ? data.lastRejected : null;
  return {
    selected,
    processing,
    confirmed: !processing && change.asked !== null && change.asked === data.current,
    rejected,
  };
}
