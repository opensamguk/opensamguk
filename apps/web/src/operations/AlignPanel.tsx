import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorCode, retryUnlessClientError, serverMessage } from '../turns/apiError';
import { describeArgs, type ArgNames } from '../turns/args';
import { toTurn } from '../turns/draft';
import type { TurnDraftState } from '../turns/useTurnDraft';
import { DisabledReason } from '../ui/DisabledReason';
import { operationApi, operationQueryKey, type SlotView } from './contract';
import styles from './Operations.module.css';
import { suggestionDiff, suggestionOps } from './timeline';

interface Props {
  worldId: string;
  operationId: string;
  // 메인 30칸 편집기와 같은 초안 훅 상태. 제안은 이 훅의 edit({ put })로 넣고 저장은 편집기의 [저장](submit)으로만 한다.
  draft: TurnDraftState;
  names: ArgNames;
}

const slotText = (slot: SlotView, names: ArgNames) => {
  const args = describeArgs(toTurn(slot).args, names);
  return args ? `${slot.name} ${args}` : slot.name;
};

// "내 예턴을 작전에 맞추기". 제안과 지금 예턴의 차이를 칸별로 보여 주고 확인해야 초안에 넣는다 (T2-12 화면 절, 검토 R62-6).
export function AlignPanel({ worldId, operationId, draft, names }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const suggest = useQuery({
    queryKey: operationQueryKey('suggest', { worldId, id: operationId }),
    queryFn: () => operationApi.suggest.query({ worldId, id: operationId }),
    enabled: open,
    staleTime: 0,
    retry: retryUnlessClientError,
  });

  // 저장 충돌(STALE)이면 최신 30칸 기준으로 제안을 다시 받아 비교를 보인다. 고치던 초안은 편집기가 보관한다.
  const stale = draft.notice?.kind === 'stale';
  useEffect(() => {
    if (!stale) return;
    setOpen(true);
    void queryClient.invalidateQueries({ queryKey: operationQueryKey('suggest', { worldId, id: operationId }) });
  }, [stale, queryClient, worldId, operationId]);

  // 저장하면 판정이 바뀐다. 작전 상세를 다시 받는다.
  const saved = draft.notice?.kind === 'saved';
  useEffect(() => {
    if (saved) void queryClient.invalidateQueries({ queryKey: operationQueryKey('get', { worldId, id: operationId }) });
  }, [saved, queryClient, worldId, operationId]);

  const unsaved = draft.draft?.ops.length ?? 0;
  const blocked = draft.saving
    ? '저장하는 중입니다.'
    : draft.pending
      ? '먼저 편집기의 충돌 안내에서 다시 적용할지 고르세요.'
      : !draft.server.data
        ? '예턴을 불러온 뒤에 맞출 수 있습니다.'
        : null;

  const put = () => {
    if (!suggest.data || blocked !== null) return;
    const ops = suggestionOps(suggest.data);
    for (const op of ops) draft.edit(op);
    setApplied(ops.length);
    setConfirming(false);
    setOpen(false);
  };

  const rows = suggest.data ? suggestionDiff(suggest.data) : [];
  const putBlocked = blocked ?? (!suggest.data ? '제안을 받은 뒤에 넣을 수 있습니다.' : null);

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
          다른 곳에서 예턴이 바뀌었습니다. 최신 예턴 기준으로 비교를 다시 받았습니다. 아래 편집기에서 내 편집을 다시
          적용하거나 버린 뒤 저장하세요.
        </p>
      ) : null}
      {applied !== null ? (
        <p role="status" className={styles.ok}>
          {applied === 0
            ? '바꿀 칸이 없었습니다.'
            : `제안 ${applied}칸을 초안에 넣었습니다. 아래 편집기에서 확인하고 저장하세요.`}
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
          ) : !suggest.data ? (
            <p className={styles.muted}>제안을 계산하는 중…</p>
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
                  <th scope="col">사전 검사</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.slot} data-slot={row.slot + 1}>
                    <td className="num">{row.slot + 1}</td>
                    <td>{slotText(row.before, names)}</td>
                    <td>{slotText(row.after, names)}</td>
                    <td>{row.warning ? <span className={styles.warn}>경고: {row.warning}</span> : '가능'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.muted}>작전 밖 칸은 그대로 둡니다. 넣은 뒤 아래 편집기에서 [저장]해야 반영됩니다.</p>

          {confirming ? (
            <div className={styles.confirm} role="alertdialog" aria-label="초안 덮기 확인">
              <p>
                저장하지 않은 편집 {unsaved}건이 있습니다. 제안 칸 {rows.length}개가 그 자리를 덮습니다. 나머지 편집은
                그대로 남습니다.
              </p>
              <div className={styles.buttons}>
                <button type="button" className={styles.primary} onClick={put}>
                  덮고 넣기
                </button>
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
                  onClick={() => (unsaved > 0 && rows.length > 0 ? setConfirming(true) : put())}
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
