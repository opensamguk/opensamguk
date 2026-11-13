import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';
import { ErrorState } from '../ui/States';

const titles = { 2: '종사', 3: '군사', 4: '태수' } as const;
const decisions = {
  secret: '비밀 정보 열람에 필요한 소속 기간 미달',
  vacant: '공석',
  npc: 'NPC 재직',
  absent: '사람 재직자 부재',
};
const statuses = { pending: '대기', approved: '임명', rejected: '거부', withdrawn: '철회', cancelled: '취소' };

export function CityOfficeVolunteers({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  type Action =
    | { action: 'request'; officerLevel: 2 | 3 | 4 }
    | { action: 'approve' | 'reject' | 'withdraw'; generalId: number; quarter: number };
  const pending = useRef<{ requestId: string; action: Action } | null>(null);
  const query = useQuery({
    ...trpc.personnel.volunteers.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: 15_000,
  });
  const submit = useMutation(
    trpc.personnel.volunteer.mutationOptions({
      onSuccess(result) {
        if (result.status !== 'pending') pending.current = null;
        return Promise.all([
          client.invalidateQueries({ queryKey: trpc.personnel.pathKey() }),
          client.invalidateQueries({ queryKey: trpc.city.pathKey() }),
        ]);
      },
    }),
  );
  const board = query.data;
  if (query.isError)
    return <ErrorState title="도시 관직 자원을 불러오지 못했습니다" onRetry={() => void query.refetch()} />;
  if (!board) return null;
  const run = (action: Action) => {
    const previous = pending.current;
    const requestId =
      previous && JSON.stringify(previous.action) === JSON.stringify(action) ? previous.requestId : crypto.randomUUID();
    pending.current = { requestId, action };
    submit.mutate({ worldId, requestId, action });
  };
  const pendingOwn = board.requests.some(
    (request) => request.generalId === board.actorId && request.status === 'pending',
  );
  return (
    <section aria-label="도시 관직 자원">
      <h2>도시 관직 자원</h2>
      <p>분기에 한 번 현재 도시의 관직에 자원할 수 있습니다.</p>
      <ul>
        {board.choices.map(({ officerLevel, reason, defaultDecision, defaultReason, requestedThisQuarter }) => (
          <li key={officerLevel}>
            <button
              type="button"
              disabled={submit.isPending || pendingOwn || reason !== null || requestedThisQuarter}
              onClick={() => run({ action: 'request', officerLevel })}
            >
              {titles[officerLevel]} 자원
            </button>{' '}
            {(requestedThisQuarter ? '이번 분기에 이미 자원했습니다.' : reason) ??
              (defaultDecision === 'approve' ? '기한 만료 시 자동 임명' : '기한 만료 시 자동 거부') +
                ' · ' +
                decisions[defaultReason]}
          </li>
        ))}
      </ul>
      {board.requests.length > 0 ? (
        <ul>
          {board.requests.map((request) => (
            <li key={request.generalId + ':' + request.quarter}>
              {request.generalName ?? '장수'} · {request.cityName ?? '도시'} {request.title} ·{' '}
              {statuses[request.status]}
              {request.status === 'pending'
                ? ' · 남은 시간 ' + Math.max(0, (request.dueTick - board.tick) / 10_000).toFixed(2) + '개월'
                : ''}
              {request.resultReason ? ' · ' + request.resultReason : ''}
              {request.status === 'pending' && request.generalId === board.actorId ? (
                <button
                  type="button"
                  disabled={submit.isPending}
                  onClick={() => run({ action: 'withdraw', generalId: request.generalId, quarter: request.quarter })}
                >
                  철회
                </button>
              ) : null}
              {request.status === 'pending' && board.canDecide
                ? (['approve', 'reject'] as const).map((action) => (
                    <button
                      type="button"
                      key={action}
                      disabled={submit.isPending}
                      onClick={() => run({ action, generalId: request.generalId, quarter: request.quarter })}
                    >
                      {action === 'approve' ? '임명' : '거부'}
                    </button>
                  ))
                : null}
            </li>
          ))}
        </ul>
      ) : null}
      {submit.data?.status === 'pending' ? (
        <p role="status">요청을 접수했습니다. 처리 결과를 기다리고 있습니다.</p>
      ) : null}
      {submit.isError ? <p role="alert">{serverMessage(submit.error) ?? '요청을 처리하지 못했습니다.'}</p> : null}
    </section>
  );
}
