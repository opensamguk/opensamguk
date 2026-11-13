import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { QueryError } from '../game/QueryState';
import { useTRPC, useTRPCClient } from '../trpc';
import { serverMessage } from '../turns/apiError';
import { EmptyState, LoadingState } from '../ui/States';
import styles from './Diplomacy.module.css';

const STATUS_LABEL = {
  PROPOSED: '승인 대기',
  ACTIVE: '승인됨',
  CANCELLED: '취소됨',
  REPLACED: '후속 문서로 대체됨',
} as const;
const ACTION_LABEL = { accept: '승인', decline: '거절', withdraw: '회수' } as const;
type Action = keyof typeof ACTION_LABEL;
type Draft = { target: string; previousId?: number; brief: string; detail: string; requestId: string };
const newDraft = (): Draft => ({ target: '', brief: '', detail: '', requestId: crypto.randomUUID() });

export function DiplomaticDocuments({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const query = useInfiniteQuery({
    queryKey: [...trpc.diplomaticDocuments.list.queryKey({ worldId }), 'pages'],
    queryFn: ({ pageParam, signal }) =>
      client.diplomaticDocuments.list.query(
        { worldId, ...(pageParam === null ? {} : { beforeId: pageParam }) },
        { signal },
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.nextBeforeId,
    retry: retryUnlessClientError,
    refetchInterval: 10_000,
  });
  const send = useMutation(trpc.diplomaticDocuments.send.mutationOptions());
  const respond = useMutation(trpc.diplomaticDocuments.respond.mutationOptions());
  const [draft, setDraft] = useState(newDraft);
  const [decision, setDecision] = useState<{ id: number; action: Action } | null>(null);
  const [reason, setReason] = useState('');
  const first = query.data?.pages[0];
  if (query.isPending) return <LoadingState />;
  if (!first)
    return (
      <QueryError error={query.error} notFound="외교 문서를 찾을 수 없습니다" onRetry={() => void query.refetch()} />
    );
  const items = query.data?.pages.flatMap(({ items }) => items) ?? [];
  const busy = send.isPending || respond.isPending;
  const failure = send.error ?? respond.error;
  const update = (patch: Partial<Draft>) => setDraft((old) => ({ ...old, ...patch, requestId: crypto.randomUUID() }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send.mutate(
      {
        worldId,
        requestId: draft.requestId,
        toNationId: Number(draft.target),
        previousId: draft.previousId,
        brief: draft.brief,
        detail: draft.detail,
      },
      {
        onSuccess: () => {
          setDraft(newDraft());
          void query.refetch();
        },
      },
    );
  }

  return (
    <>
      {first.canWrite ? (
        <form className={`${styles.composer} ${styles.documentForm}`} aria-label="외교 문서 작성" onSubmit={submit}>
          <h2>{draft.previousId === undefined ? '새 외교 문서' : `#${draft.previousId} 후속 문서`}</h2>
          <label>
            받는 국가
            <select
              value={draft.target}
              disabled={busy || draft.previousId !== undefined}
              required
              onChange={(event) => update({ target: event.target.value })}
            >
              <option value="">국가 선택</option>
              {first.targets.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            요약
            <textarea
              required
              maxLength={2000}
              rows={2}
              value={draft.brief}
              disabled={busy}
              onChange={(event) => update({ brief: event.target.value })}
            />
          </label>
          <label>
            비공개 본문
            <textarea
              maxLength={20_000}
              rows={4}
              value={draft.detail}
              disabled={busy}
              onChange={(event) => update({ detail: event.target.value })}
            />
          </label>
          <div className={styles.buttons}>
            <button className={styles.primary} disabled={busy || !draft.target || !draft.brief.trim()}>
              문서 보내기
            </button>
            {draft.previousId === undefined ? null : (
              <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDraft(newDraft())}>
                후속 작성 취소
              </button>
            )}
          </div>
        </form>
      ) : null}
      {failure ? <p role="alert">{serverMessage(failure) ?? '외교 문서를 처리하지 못했습니다.'}</p> : null}
      {items.length === 0 ? <EmptyState title="외교 문서가 없습니다" /> : null}
      <div className={styles.cards}>
        {items.map((item) => {
          const incoming = item.toNationId === first.nationId;
          const target = incoming ? item.fromNationId : item.toNationId;
          const canReplace =
            ['ACTIVE', 'PROPOSED'].includes(item.status) &&
            first.targets.some(({ id }) => id === target) &&
            !items.some((successor) => successor.previousId === item.id && successor.status !== 'CANCELLED');
          return (
            <article key={item.id} className={styles.card} aria-label={`외교 문서 #${item.id}`}>
              <h3>
                #{item.id} {item.fromNationName} → {item.toNationName}
              </h3>
              <div>
                {STATUS_LABEL[item.status]} · 보낸 장수 {item.senderName}
              </div>
              {item.responderName ? <div>처리 장수 {item.responderName}</div> : null}
              {item.previousId === null ? null : <div>이전 문서 #{item.previousId}</div>}
              <p className={styles.documentText}>{item.brief}</p>
              {item.detail ? (
                <details>
                  <summary>비공개 본문</summary>
                  <p className={styles.documentText}>{item.detail}</p>
                </details>
              ) : null}
              {item.responseReason ? <p className={styles.documentText}>{item.responseReason}</p> : null}
              {first.canWrite ? (
                <div className={styles.buttons}>
                  {item.status === 'PROPOSED'
                    ? (incoming ? (['accept', 'decline'] as const) : (['withdraw'] as const)).map((action) => (
                        <button
                          key={action}
                          type="button"
                          className={styles.secondary}
                          disabled={busy}
                          onClick={() => {
                            setReason('');
                            setDecision({ id: item.id, action });
                          }}
                        >
                          {ACTION_LABEL[action]}
                        </button>
                      ))
                    : null}
                  {canReplace ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => setDraft({ ...newDraft(), target: String(target), previousId: item.id })}
                    >
                      후속 문서 쓰기
                    </button>
                  ) : null}
                </div>
              ) : null}
              {decision?.id === item.id ? (
                <div className={styles.buttons}>
                  <span>
                    문서 #{item.id} {ACTION_LABEL[decision.action]} 여부를 확인하세요.
                  </span>
                  {decision.action === 'decline' ? (
                    <label>
                      거절 사유
                      <textarea
                        rows={2}
                        maxLength={2000}
                        value={reason}
                        disabled={busy}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    onClick={() =>
                      respond.mutate(
                        { worldId, ...decision, reason: decision.action === 'decline' ? reason : undefined },
                        {
                          onSuccess: () => {
                            setDecision(null);
                            void query.refetch();
                          },
                        },
                      )
                    }
                  >
                    {ACTION_LABEL[decision.action]} 확인
                  </button>
                  <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDecision(null)}>
                    취소
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {query.hasNextPage ? (
        <button
          type="button"
          className={styles.secondary}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          이전 문서 더 보기
        </button>
      ) : null}
    </>
  );
}
