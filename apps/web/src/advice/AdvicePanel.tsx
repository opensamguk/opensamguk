import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { QueryError } from '../game/QueryState';
import { useWorldEnded } from '../game/queries';
import { useTRPC } from '../trpc';
import { errorCode, retryUnlessClientError, serverMessage } from '../turns/apiError';
import type { TurnDraftState } from '../turns/useTurnDraft';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { LoadingState } from '../ui/States';
import { Tag, type TagTone } from '../ui/Tag';
import styles from './AdvicePanel.module.css';
import {
  adviceItemKey,
  localStore,
  putBlockedReason,
  putLabel,
  readExpanded,
  replaceText,
  SOURCE_LABEL,
  STALE_TEXT,
  writeExpanded,
  type AdviceItem,
} from './model';

const TONE: Record<AdviceItem['source'], TagTone> = { operation: 'accent', notice: 'info', ai: 'muted' };

type Notice = { kind: 'ok' | 'stale' | 'error'; text: string } | null;

// 메인 명령 목록 칸의 군사 조언 (T3-08). 편집기와 같은 칸이라 지도에서 도시를 골라도 다시 만들지 않는다.
// 넣기는 turns.edit의 put으로 1번 칸에 바로 저장한다. 저장하지 않은 초안은 덮거나 대신 저장하지 않는다.
export function AdvicePanel({ worldId, draft }: { worldId: string; draft: TurnDraftState }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const headingId = useId();
  const bodyId = useId();
  const ended = useWorldEnded(worldId);
  const advice = useQuery({ ...trpc.advice.get.queryOptions({ worldId }), retry: retryUnlessClientError });
  const commands = useQuery({ ...trpc.commands.list.queryOptions({ worldId }), staleTime: Infinity });
  const commandName = (key: string) => commands.data?.find((c) => c.key === key)?.name ?? key;

  const [stored, setStored] = useState<boolean | null>(() => readExpanded(localStore(), worldId));
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState<{ key: string; revision: number } | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<string | null>(null);
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  const data = advice.data;
  const serverRevision = draft.server.data?.revision;
  const first = draft.server.data?.slots[0];
  const basisRevision = data?.basis.revision;

  // 예턴 목록이 바뀌면(저장·턴 실행·다른 탭) 조언도 새로 받는다.
  const seenRevision = useRef(serverRevision);
  useEffect(() => {
    if (serverRevision === undefined || seenRevision.current === serverRevision) return;
    seenRevision.current = serverRevision;
    void queryClient.invalidateQueries({ queryKey: trpc.advice.get.queryKey({ worldId }) });
  }, [serverRevision, queryClient, trpc, worldId]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.turns.get.queryKey({ worldId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.advice.get.queryKey({ worldId }) }),
    ]);

  const edit = useMutation({
    ...trpc.turns.edit.mutationOptions(),
    onSuccess: async (result) => {
      setConfirming(null);
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
        setNotice({ kind: 'ok', text: '1칸에 넣고 저장했습니다.' });
      } else setNotice({ kind: 'stale', text: STALE_TEXT });
      await refresh();
    },
    onError: async (error) => {
      setConfirming(null);
      const code = errorCode(error);
      setNotice({
        kind: 'error',
        text:
          code === 'UNAUTHORIZED'
            ? '다시 로그인해야 저장할 수 있습니다.'
            : (serverMessage(error) ?? '넣지 못했습니다. 연결을 확인하고 다시 시도하세요.'),
      });
      await refresh();
    },
  });

  const blocked = putBlockedReason({
    ended,
    saving: draft.saving,
    pending: draft.pending !== null,
    hasDraft: draft.draft !== null,
    serverRevision: first ? serverRevision : undefined,
    basisRevision: basisRevision ?? -1,
    fetching: advice.isFetching,
    putting: edit.isPending,
  });

  const put = (item: AdviceItem) => {
    if (!data || blocked !== null) return;
    setNotice(null);
    edit.mutate({
      worldId,
      revision: data.basis.revision,
      op: { put: { from: 0, to: 0, commandKey: item.commandKey, args: item.args } },
    });
  };

  const onPutClick = (item: AdviceItem) => {
    if (!data || !first || blocked !== null) return;
    if (first.commandKey !== 'rest') setConfirming({ key: adviceItemKey(item), revision: data.basis.revision });
    else put(item);
  };

  const cancelConfirmation = (key: string) => {
    restoreButton.current = key;
    setConfirming(null);
  };

  const expanded = stored ?? data?.expandedByDefault ?? false;
  const toggle = () => {
    const next = !expanded;
    setStored(next);
    writeExpanded(localStore(), worldId, next);
    // 최근 작전 변경은 SSE kind가 없어, 사용자가 다시 펼칠 때 조언을 새로 받는다.
    if (next) void queryClient.invalidateQueries({ queryKey: trpc.advice.get.queryKey({ worldId }) });
  };

  return (
    <section
      className={styles.panel}
      aria-labelledby={headingId}
      data-testid="military-advice"
      data-expanded={expanded}
    >
      <div className={styles.head}>
        <h3 id={headingId} className={styles.title}>
          군사 조언
        </h3>
        {data ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={toggle}
          >
            {expanded ? '접기' : '펼치기'}
          </button>
        ) : null}
      </div>
      <div id={bodyId} hidden={!expanded && data !== undefined}>
        {advice.isError ? (
          <QueryError error={advice.error} notFound="조언을 찾을 수 없습니다" onRetry={() => void advice.refetch()} />
        ) : !data ? (
          <LoadingState>조언을 불러오는 중</LoadingState>
        ) : (
          <>
            {data.items.length === 0 ? <p className={styles.muted}>지금 추천할 예턴이 없습니다</p> : null}
            <ol className={styles.list}>
              {data.items.map((item) => {
                const key = adviceItemKey(item);
                const asking = confirming?.key === key && confirming.revision === data.basis.revision;
                return (
                  <li key={key} className={styles.row} data-advice-source={item.source} data-testid="advice-item">
                    <div className={styles.what}>
                      <Tag tone={TONE[item.source]}>{SOURCE_LABEL[item.source]}</Tag>
                      <span className={styles.command}>
                        {item.commandName}
                        {item.argsLabel ? ` · ${item.argsLabel}` : ''}
                      </span>
                      {item.nation ? <NationBadge name={item.nation.name} color={item.nation.color} /> : null}
                    </div>
                    <p className={styles.reason}>{item.reason}</p>
                    <div className={styles.action}>
                      {asking ? (
                        <div
                          role="alertdialog"
                          aria-label="1칸 바꾸기 확인"
                          className={styles.confirm}
                          onKeyDown={(event) => {
                            if (event.key !== 'Escape') return;
                            event.stopPropagation();
                            cancelConfirmation(key);
                          }}
                        >
                          <p>{replaceText(first?.name ?? '', item.commandName)}</p>
                          <div className={styles.buttons}>
                            <button
                              type="button"
                              className={styles.primary}
                              disabled={blocked !== null}
                              onClick={() => put(item)}
                            >
                              바꿔 넣기
                            </button>
                            <button
                              ref={cancelButton}
                              type="button"
                              className={styles.secondary}
                              onClick={() => cancelConfirmation(key)}
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      ) : blocked !== null ? (
                        <DisabledReason reason={blocked}>{putLabel(item)}</DisabledReason>
                      ) : (
                        <button
                          ref={(button) => {
                            if (!button || restoreButton.current !== key) return;
                            restoreButton.current = null;
                            button.focus();
                          }}
                          type="button"
                          className={styles.primary}
                          onClick={() => onPutClick(item)}
                        >
                          {putLabel(item)}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {data.skipped.length > 0 ? (
              <div className={styles.skipped}>
                <p className={styles.muted}>지금 넣을 수 없는 지시</p>
                <ul className={styles.skippedList}>
                  {data.skipped.map((skip, i) => (
                    <li
                      key={`${skip.source}-${skip.commandKey}-${i}`}
                      data-advice-source={skip.source}
                      data-testid="advice-skipped"
                    >
                      {SOURCE_LABEL[skip.source]} · {commandName(skip.commandKey)} ({skip.message})
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {notice ? (
              <p
                role={notice.kind === 'error' ? 'alert' : 'status'}
                className={notice.kind === 'ok' ? styles.ok : styles.warn}
              >
                {notice.text}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
