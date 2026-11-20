// 제안함의 명령 제안(상신) 칸 (D-100). 받은 제안은 권한자가 국가 예턴 칸을 정해 승인하거나 사유를 적어 거절하고,
// 보낸 제안은 상태와 답을 보며 기다리는 것만 거둔다. 받은 목록 조회는 메뉴 배지(useInboxCount)와 같은 키다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useWorldMap, useWorldSummary } from '../game/queries';
import { serverMessage } from '../turns/apiError';
import type { ArgNames } from '../turns/args';
import { useTRPC } from '../trpc';
import { toProposalItem, toServerSlot, type ServerProposal } from './contract';
import { ProposalList } from './ProposalList';

export function ProposalBox({
  worldId,
  generalName,
}: {
  worldId: string;
  // 답한 장수 이름. 제안함이 이미 받은 장수 목록에서 찾는다. 모르면 번호로 적는다.
  generalName: (id: number) => string | undefined;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const summary = useWorldSummary(worldId);
  const map = useWorldMap(worldId);
  const ended = summary.data?.status === 'ENDED';
  const received = useQuery(
    trpc.proposals.list.queryOptions(
      { worldId, box: 'received', status: 'PENDING' },
      { retry: false, refetchInterval: ended ? false : 30_000 },
    ),
  );
  const sent = useQuery(trpc.proposals.list.queryOptions({ worldId, box: 'sent' }, { retry: false }));
  // 승인은 승인자의 국가 예턴 칸을 고치므로 국가 예턴 조회도 다시 받는다.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.proposals.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.nationTurns.pathKey() });
  };
  const respond = useMutation({ ...trpc.proposals.respond.mutationOptions(), onSettled: refresh });
  const cancel = useMutation({ ...trpc.proposals.cancel.mutationOptions(), onSettled: refresh });

  const names: ArgNames = useMemo(
    () => ({
      city: (key: number) => map.data?.cities.find((city) => city.key === key)?.name,
      nation: (id: number) => map.data?.nations.find((nation) => nation.id === id)?.name,
      general: generalName,
    }),
    [map.data, generalName],
  );
  // args는 재귀 JSON 타입이라 그대로 비교하면 타입 검사가 너무 깊어진다. 필요한 칸만 적은 ServerProposal로 읽는다.
  const rows = (data: unknown) => (data ?? []) as ServerProposal[];
  const receivedItems = rows(received.data).map((row) => toProposalItem(row, names, generalName));
  const sentItems = rows(sent.data).map((row) => toProposalItem(row, names, generalName));
  const nowTick = summary.data?.nowTick ?? 0;
  const failure = respond.error ?? cancel.error;

  if (receivedItems.length === 0 && sentItems.length === 0 && !received.isError && !sent.isError) return null;
  return (
    <>
      {failure ? <p role="alert">{serverMessage(failure) ?? '제안에 답하지 못했습니다. 다시 시도하세요.'}</p> : null}
      {receivedItems.length > 0 ? (
        <ProposalList
          box="received"
          items={receivedItems}
          nowTick={nowTick}
          onApprove={(proposalId, slot) =>
            respond.mutate({ proposalId, decision: 'approve', slot: toServerSlot(slot) })
          }
          onReject={(proposalId, reason) =>
            respond.mutate({ proposalId, decision: 'reject', ...(reason ? { reason } : {}) })
          }
        />
      ) : null}
      {received.isError ? <p>받은 명령 제안을 불러오지 못했습니다.</p> : null}
      {sentItems.length > 0 ? (
        <ProposalList
          box="sent"
          items={sentItems}
          nowTick={nowTick}
          onCancel={(proposalId) => cancel.mutate({ proposalId })}
        />
      ) : null}
      {sent.isError ? <p>보낸 명령 제안을 불러오지 못했습니다.</p> : null}
    </>
  );
}

// 제안함이 비었는지 셀 때 쓴다. 받은 제안 조회는 ProposalBox, 메뉴 배지와 같은 키라 한 번만 받는다.
export function useOpenProposalCount(worldId: string, enabled: boolean) {
  const trpc = useTRPC();
  const received = useQuery({
    ...trpc.proposals.list.queryOptions({ worldId, box: 'received', status: 'PENDING' }),
    enabled,
    retry: false,
  });
  const sent = useQuery({ ...trpc.proposals.list.queryOptions({ worldId, box: 'sent' }), enabled, retry: false });
  return {
    pending: enabled && (received.isPending || sent.isPending),
    count: (received.data?.length ?? 0) + (sent.data?.length ?? 0),
  };
}
