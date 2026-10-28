import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { publicFailure } from '../auth/credentials';
import { useTRPC, useTRPCClient } from '../trpc';
import styles from './SanctionNotice.module.css';

const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' });

// 계정 확인 중에는 이전 계정의 사유를 표시하지 않는다.
export function SanctionNotice({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const identity = useQuery({
    ...trpc.auth.me.queryOptions(),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  if (identity.isFetching) return null;
  if (identity.isError)
    return (
      <section className={styles.notice} aria-label="제재 상태 확인">
        <p role="alert">계정 정보를 확인하지 못했습니다.</p>
        <button type="button" onClick={() => void identity.refetch()}>
          다시 확인
        </button>
      </section>
    );
  const viewerId = identity.data?.user?.id;
  return viewerId ? <ViewerNotice key={viewerId} viewerId={viewerId} worldId={worldId} /> : null;
}

function ViewerNotice({ viewerId, worldId }: { viewerId: string; worldId: string }) {
  const client = useTRPCClient(),
    trpc = useTRPC(),
    queryClient = useQueryClient(),
    router = useRouter();
  const queryKey = ['sanction-notice', viewerId, worldId] as const;
  const mine = useQuery({
    queryKey,
    staleTime: 0,
    retry: false,
    placeholderData: () => undefined,
    queryFn: async ({ signal }) => {
      // 같은 HTTP 배치의 서버 세션으로 본인과 제재를 함께 확인한다.
      const [identity, items] = await Promise.all([
        client.auth.me.query(undefined, { signal }),
        client.sanction.mine.query(undefined, { signal }),
      ]);
      if (identity.user?.id !== viewerId) {
        void queryClient.invalidateQueries({ queryKey: trpc.auth.me.queryKey() });
        void router.invalidate();
        throw new Error('계정이 바뀌었습니다. 다시 확인하세요.');
      }
      return { viewerId, items };
    },
  });
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const failure = publicFailure(event.action.error);
        if (failure?.code === 'FORBIDDEN' && failure.reason === null)
          void queryClient.invalidateQueries({ queryKey: ['sanction-notice', viewerId, worldId] });
      }),
    [queryClient, viewerId, worldId],
  );
  const sanctions = mine.data?.viewerId === viewerId ? mine.data.items.filter((item) => item.worldId === worldId) : [];
  const expiry = sanctions
    .flatMap((item) => (item.expiresAt ? [Date.parse(item.expiresAt)] : []))
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (expiry === undefined || !Number.isFinite(expiry)) return;
    const timeout = window.setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: ['sanction-notice', viewerId, worldId] }),
      Math.min(2_147_483_647, Math.max(30_000, expiry - Date.now() + 1000)),
    );
    return () => window.clearTimeout(timeout);
  }, [expiry, mine.dataUpdatedAt, queryClient, viewerId, worldId]);
  if (mine.isFetching || mine.isPending) return null;
  if (mine.isError)
    return (
      <section className={styles.notice} aria-label="제재 상태 확인">
        <p role="alert">제재 상태를 확인하지 못했습니다.</p>
        <button type="button" disabled={mine.isFetching} onClick={() => void mine.refetch()}>
          다시 확인
        </button>
      </section>
    );
  if (!sanctions.length) return null;
  return (
    <section className={styles.notice} aria-label="이 월드의 이용 제한" role="status" aria-live="polite">
      <h2>이 월드의 이용이 제한됐습니다</h2>
      {sanctions.map((item, index) => (
        <dl key={index}>
          <dt>사유</dt>
          <dd>{item.reason}</dd>
          <dt>기한</dt>
          <dd>
            {item.expiresAt ? (
              <time dateTime={item.expiresAt} title={item.expiresAt}>
                {date.format(new Date(item.expiresAt))} (한국 시각)
              </time>
            ) : (
              '기한 없음'
            )}
          </dd>
        </dl>
      ))}
      <p>이 월드에서는 변경 요청을 보낼 수 없습니다. 조회와 다른 월드는 계속 이용할 수 있습니다.</p>
      <button type="button" disabled={mine.isFetching} onClick={() => void mine.refetch()}>
        제재 상태 다시 확인
      </button>
    </section>
  );
}
