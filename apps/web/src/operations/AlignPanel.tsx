import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTRPC } from '../trpc';
import { errorCode, retryUnlessClientError, serverMessage } from '../turns/apiError';
import type { ArgNames } from '../turns/args';
import type { TurnDraftState } from '../turns/useTurnDraft';
import { DisabledReason } from '../ui/DisabledReason';
import type { SlotView, SuggestionWarning } from './contract';
import styles from './Operations.module.css';
import { EMPTY_SLOT_TITLE, outsideWarnings, slotLabel, suggestionDiff, suggestionOps } from './timeline';

// 메인 30칸 편집기와 같은 초안 훅 상태에서 이 패널이 읽는 몫. 제안은 edit({ put })로 넣고 저장은 편집기의 [저장](submit)으로만 한다.
export type AlignDraft = Pick<TurnDraftState, 'draft' | 'pending' | 'notice' | 'saving' | 'edit'> & {
  server: Pick<TurnDraftState['server'], 'data'>;
};

interface Props {
  worldId: string;
  operationId: string;
  draft: AlignDraft;
  names: ArgNames;
}

function SlotText({ slot, names }: { slot: SlotView; names: ArgNames }) {
  const label = slotLabel(slot, names);
  if (label.kind !== 'empty') return <>{label.text}</>;
  return (
    <span className={styles.muted} title={EMPTY_SLOT_TITLE}>
      {label.text}
    </span>
  );
}

function WarningList({ warnings, withSlot }: { warnings: SuggestionWarning[]; withSlot: boolean }) {
  return (
    <ul className={styles.warnings}>
      {warnings.map((w, i) => (
        <li key={`${w.slot}-${w.code}-${i}`} className={styles.warn} data-code={w.code}>
          {withSlot ? `${w.slot + 1}번 칸. ` : null}
          {w.reason}
        </li>
      ))}
    </ul>
  );
}

// 내 예턴을 작전에 맞추기. 제안과 지금 예턴의 차이를 칸별로 보여 주고 확인해야 초안에 넣는다 (T2-12 화면 절, 검토 R62-6).
export function AlignPanel({ worldId, operationId, draft, names }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const suggest = useQuery({
    ...trpc.operation.suggest.queryOptions({ worldId, id: operationId }),
    enabled: open,
    staleTime: 0,
    retry: retryUnlessClientError,
  });

  // 저장 충돌(STALE)이면 최신 30칸 기준으로 제안을 다시 받아 비교를 보인다. 고치던 초안은 편집기가 보관한다.
  // 다시 받기 전 제안이 캐시에 남으므로 그때의 응답 횟수를 적어 두고, 새 응답이 올 때까지 넣기를 막는다.
  // 횟수는 제안마다 따로 세므로 어느 작전의 것인지 함께 적고 같은 작전일 때만 비교한다.
  const stale = draft.notice?.kind === 'stale';
  const [refreshFrom, setRefreshFrom] = useState<{ worldId: string; operationId: string; count: number } | null>(null);
  useEffect(() => {
    if (!stale) return;
    const queryKey = trpc.operation.suggest.queryKey({ worldId, id: operationId });
    setOpen(true);
    setRefreshFrom({ worldId, operationId, count: queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0 });
    void queryClient.invalidateQueries({ queryKey });
  }, [stale, queryClient, trpc, worldId, operationId]);
  const dataUpdates =
    queryClient.getQueryState(trpc.operation.suggest.queryKey({ worldId, id: operationId }))?.dataUpdateCount ?? 0;
  const waitingRefresh =
    refreshFrom !== null &&
    refreshFrom.worldId === worldId &&
    refreshFrom.operationId === operationId &&
    dataUpdates <= refreshFrom.count;
  const refreshing = suggest.isFetching || (waitingRefresh && !suggest.isError);

  // 저장하면 판정이 바뀐다. 작전 상세를 다시 받는다.
  const saved = draft.notice?.kind === 'saved';
  useEffect(() => {
    if (saved)
      void queryClient.invalidateQueries({ queryKey: trpc.operation.get.queryKey({ worldId, id: operationId }) });
  }, [saved, queryClient, trpc, worldId, operationId]);

  const data = suggest.data;
  const rows = data ? suggestionDiff(data) : [];
  const outside = data ? outsideWarnings(data) : [];
  const unsaved = draft.draft?.ops.length ?? 0;
  // 다시 받는 중이거나 받지 못했으면 캐시에 남은 이전 제안을 넣지 않는다.
  const blocked = draft.saving
    ? '저장하는 중입니다.'
    : draft.pending
      ? '먼저 편집기의 충돌 안내에서 다시 적용할지 고르세요.'
      : !draft.server.data
        ? '예턴을 불러온 뒤에 맞출 수 있습니다.'
        : data && refreshing
          ? '최신 예턴 기준 제안을 다시 받는 중입니다. 받은 뒤에 넣을 수 있습니다.'
          : data && suggest.isError
            ? '제안을 다시 받지 못해 넣을 수 없습니다. 미리보기를 닫고 다시 여세요.'
            : null;
  // noop이면 서버가 준 이유로 막는다. noop이 없고 changed가 비었을 때만 같은 예턴이라고 적는다.
  const putBlocked =
    blocked ??
    (!data
      ? '제안을 받은 뒤에 넣을 수 있습니다.'
      : data.noop !== null
        ? data.noop.reason
        : rows.length === 0
          ? '바꿀 칸이 없습니다.'
          : null);

  const put = () => {
    if (!data || putBlocked !== null) return;
    const ops = suggestionOps(data);
    for (const op of ops) draft.edit(op);
    setApplied(ops.length);
    setConfirming(false);
    setOpen(false);
  };

  return (
    <section className={styles.align} aria-label="작전에 맞추기" data-testid="align-panel">
      <div className={styles.buttons}>
        {open ? null : (
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              setApplied(null);
              setOpen(true);
            }}
          >
            내 예턴을 작전에 맞추기
          </button>
        )}
      </div>
      {stale ? (
        <p role="alert" className={styles.warn}>
          다른 곳에서 예턴이 바뀌었습니다.{' '}
          {refreshing
            ? '최신 예턴 기준 제안을 다시 받는 중입니다. 받기 전에는 초안에 넣을 수 없습니다.'
            : suggest.isError
              ? '최신 예턴 기준 제안을 다시 받지 못했습니다.'
              : '최신 예턴 기준으로 비교를 다시 받았습니다.'}{' '}
          아래 편집기에서 내 편집을 다시 적용하거나 버린 뒤 저장하세요.
        </p>
      ) : null}
      {applied !== null ? (
        <p role="status" className={styles.ok}>
          제안 {applied}칸을 초안에 넣었습니다. 아래 편집기에서 확인하고 저장하세요.
        </p>
      ) : null}

      {open ? (
        <div className={styles.preview} data-testid="align-preview">
          <h3>바뀌는 칸</h3>
          {suggest.isError ? (
            <p role="alert" className={styles.warn}>
              {errorCode(suggest.error) === undefined
                ? '제안을 받지 못했습니다. 연결을 확인하고 다시 여세요.'
                : (serverMessage(suggest.error) ?? '제안을 받지 못했습니다.')}
            </p>
          ) : !data ? (
            <p className={styles.muted}>제안을 계산하는 중…</p>
          ) : null}
          {data && refreshing && !suggest.isError ? (
            <p role="status" className={styles.muted}>
              최신 예턴 기준 제안을 다시 받는 중입니다. 아래는 이전 제안이라 넣을 수 없습니다.
            </p>
          ) : null}
          {suggest.isError || !data ? null : data.noop !== null ? (
            <p role="status" className={styles.warn} data-noop={data.noop.code}>
              {data.noop.reason}
            </p>
          ) : rows.length === 0 ? (
            <p>지금 예턴이 이미 작전 제안과 같습니다.</p>
          ) : (
            <table className={styles.diff}>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    칸
                  </th>
                  <th scope="col">지금</th>
                  <th scope="col">제안</th>
                  <th scope="col">지금 상태 검사</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.slot} data-slot={row.slot + 1}>
                    <td className="num">{row.slot + 1}</td>
                    <td>
                      <SlotText slot={row.before} names={names} />
                    </td>
                    <td>
                      <SlotText slot={row.after} names={names} />
                    </td>
                    <td>
                      {row.warnings.length > 0 ? (
                        <WarningList warnings={row.warnings} withSlot={false} />
                      ) : (
                        <span className={styles.muted}>지금 상태 경고 없음</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!suggest.isError && outside.length > 0 ? (
            <div data-testid="align-outside-warnings">
              <p>바뀌지 않는 칸에도 경고가 있습니다.</p>
              <WarningList warnings={outside} withSlot />
            </div>
          ) : null}
          <p className={styles.muted}>
            경고는 지금 상태로 본 검사라 실행할 때 다시 검사합니다. 작전 밖 칸은 그대로 둡니다. 넣은 뒤 아래 편집기에서
            [저장]해야 반영됩니다.
          </p>

          {confirming ? (
            <div className={styles.confirm} role="alertdialog" aria-label="초안 덮기 확인">
              <p>
                저장하지 않은 편집 {unsaved}건이 있습니다. 제안 칸 {rows.length}개가 그 자리를 덮습니다. 나머지 편집은
                그대로 남습니다.
              </p>
              <div className={styles.buttons}>
                {putBlocked !== null ? (
                  <DisabledReason reason={putBlocked}>덮고 넣기</DisabledReason>
                ) : (
                  <button type="button" className={styles.primary} onClick={put}>
                    덮고 넣기
                  </button>
                )}
                <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>
                  취소
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.buttons}>
              {putBlocked !== null ? (
                <DisabledReason reason={putBlocked}>초안에 넣기</DisabledReason>
              ) : (
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => (unsaved > 0 ? setConfirming(true) : put())}
                >
                  초안에 넣기
                </button>
              )}
              <button type="button" className={styles.secondary} onClick={() => setOpen(false)}>
                미리보기 닫기
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
