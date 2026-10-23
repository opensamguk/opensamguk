import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { serverMessage } from '../turns/apiError';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { ErrorState } from '../ui/States';
import { authorityEpoch, useAuthority } from './authority';
import { BODY_MAX, BODY_TOO_LONG, bodyLength, type NationNotice } from './contract';
import { readDraft, useDraft, writeDraft } from './drafts';
import { formatTime } from './MessagePanel';
import { useNationNotice } from './queries';
import styles from './NationNotice.module.css';

const seenKey = (notice: Pick<NationNotice, 'nationId' | 'revision'>) => `${notice.nationId}:${notice.revision}`;

// 국가 공지 팝업. 바뀐 공지(unseen)를 첫 접속 때 한 번 띄운다 (T2-09 국가 공지 읽음, 검토 R63-3R).
// 닫을 때는 팝업을 열 때 담아 둔 nationId·revision을 보낸다. 그사이 SSE나 ready 재조회로 캐시가 바뀌어도 캐시 값을 보내지 않는다.
// markSeen을 부를 때와 응답을 받을 때의 권한 epoch가 같으면 응답을 따른다. unseen이 아직 true면(그사이 새 공지, 또는 다른 국가로
// 옮김) 그 응답 본문으로 한 번 더 띄우고 null이면(재야) 띄우지 않는다. epoch가 바뀌었으면 응답은 버리고, 권한이 바뀔 때 비운
// notice.nation.get을 새로 받은 값으로 다음 팝업을 정한다. 무엇을 띄울지는 늘 서버의 unseen이 정한다.
export function NationNoticePopup({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const authority = useAuthority(worldId);
  const notice = useNationNotice(worldId);
  const { mutateAsync: markSeen } = useMutation(trpc.notice.nation.markSeen.mutationOptions());
  const [shown, setShown] = useState<NationNotice | null>(null);
  const [closing, setClosing] = useState(false);
  // 읽음 처리에 실패한 판은 이 탭에서 다시 띄우지 않는다. 다음 접속 때 다시 뜬다.
  const failed = useRef(new Set<string>());
  const data = authority.ready ? notice.data : undefined;

  // 서버가 권한을 거둬 ready가 꺼지면 띄운 공지도 거둔다. 국가를 옮기는 것만으로는 ready가 꺼지지 않으므로
  // 그때 띄운 판은 남아 닫을 때 그 판을 보낸다.
  if (!authority.ready && shown) setShown(null);

  // 이 render가 본 epoch다. effect가 실행될 때 epoch가 이미 바뀌었으면 그 render의 data는 예전 권한의 값이라 띄우지 않는다.
  // 새 epoch로 다시 그려진 render의 effect가 새 data로 정한다.
  const renderEpoch = authority.epoch;
  useEffect(() => {
    if (renderEpoch !== authorityEpoch(worldId)) return;
    if (shown || closing || !data?.unseen || failed.current.has(seenKey(data))) return;
    setShown(data);
  }, [closing, data, renderEpoch, shown, worldId]);

  const close = async () => {
    if (!shown) return;
    const { nationId, revision } = shown;
    const epoch = authorityEpoch(worldId);
    const queryKey = trpc.notice.nation.get.queryKey({ worldId });
    setShown(null);
    setClosing(true);
    try {
      const result = await markSeen({ worldId, nationId, revision });
      if (authorityEpoch(worldId) !== epoch) return;
      // 읽음 처리 전에 시작한 공지 재조회는 읽기 전 값을 가져올 수 있다. 그 요청을 취소하고 서버가 준 읽음 뒤 값을 넣는다.
      await queryClient.cancelQueries({ queryKey });
      if (authorityEpoch(worldId) !== epoch) return;
      queryClient.setQueryData(queryKey, result);
      if (result?.unseen) setShown(result);
    } catch {
      failed.current.add(`${nationId}:${revision}`);
    } finally {
      setClosing(false);
    }
  };

  return shown ? <NoticeDialog notice={shown} onClose={() => void close()} /> : null;
}

function NoticeDialog({ notice, onClose }: { notice: NationNotice; onClose: () => void }) {
  const titleId = useId();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className={styles.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        data-testid="nation-notice-popup"
        data-nation-id={notice.nationId}
        data-revision={notice.revision}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          // 단추가 하나뿐이라 초점을 그 단추에 묶어 둔다.
          if (event.key === 'Tab') {
            event.preventDefault();
            button.current?.focus();
          }
        }}
      >
        <h2 id={titleId} className={styles.title}>
          국가 공지
        </h2>
        <NoticeMeta notice={notice} />
        <p className={styles.body}>{notice.body}</p>
        <div className={styles.actions}>
          <button ref={button} type="button" className={styles.primary} onClick={onClose}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

function NoticeMeta({ notice }: { notice: NationNotice }) {
  if (!notice.updatedAt && !notice.updatedBy) return null;
  return (
    <p className={styles.meta}>
      {notice.updatedBy ? <span>{notice.updatedBy}</span> : null}
      {notice.updatedAt ? <time dateTime={notice.updatedAt}>{formatTime(notice.updatedAt)}</time> : null}
    </p>
  );
}

// 메인 국가 정보 칸의 공지. 서버가 준 canEdit이 true일 때만 고친다. 고치는 중인 글은 drafts.ts에 소속 국가별로 두어
// 재조회로 지워지지 않고, 국가를 옮기면 예전 국가의 초안이 새 국가로 가지 않는다.
export function NationNoticeBox({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const authority = useAuthority(worldId);
  const notice = useNationNotice(worldId);
  const draftKey = `notice:edit:${worldId}:${authority.nationId ?? 'none'}`;
  const [draft, setDraft] = useDraft<string | null>(draftKey, null);
  const set = useMutation(trpc.notice.nation.set.mutationOptions());
  const fieldId = useId();

  if (notice.isError)
    return <ErrorState title="국가 공지를 불러오지 못했습니다" onRetry={() => void notice.refetch()} />;
  const data = authority.ready ? notice.data : undefined;
  if (!data) return null;
  const editing = draft !== null && data.canEdit;
  const length = draft === null ? 0 : bodyLength(draft);
  const error = set.isError
    ? (serverMessage(set.error) ?? '저장하지 못했습니다. 연결을 확인하고 다시 저장하세요.')
    : null;

  const save = async () => {
    if (draft === null || set.isPending || length > BODY_MAX) return;
    const epoch = authorityEpoch(worldId);
    const body = draft;
    try {
      const result = await set.mutateAsync({ worldId, body });
      if (readDraft<string | null>(draftKey, null) === body) writeDraft(draftKey, null);
      // 응답 전에 권한이 바뀌었으면 새 권한의 공지 칸에 예전 응답을 넣지 않는다.
      if (authorityEpoch(worldId) !== epoch) return;
      queryClient.setQueryData(trpc.notice.nation.get.queryKey({ worldId }), result);
    } catch {
      if (authorityEpoch(worldId) !== epoch) set.reset();
    }
  };

  return (
    <section className={styles.box} aria-label="국가 공지" data-testid="nation-notice">
      <div className={styles.boxHead}>
        <h3 className={styles.boxTitle}>국가 공지</h3>
        {editing ? null : data.canEdit ? (
          <button type="button" className={styles.secondary} onClick={() => setDraft(data.body)}>
            고치기
          </button>
        ) : (
          <DisabledReason reason="군주와 참모만 고칠 수 있습니다.">고치기</DisabledReason>
        )}
      </div>
      {!editing ? (
        <>
          {data.body ? <p className={styles.body}>{data.body}</p> : <p className={styles.empty}>공지가 없습니다.</p>}
          <NoticeMeta notice={data} />
        </>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={fieldId} className={styles.label}>
            <span>공지 내용</span>
            <span aria-hidden="true">
              {length}/{BODY_MAX}
            </span>
          </label>
          <textarea
            id={fieldId}
            className={styles.textarea}
            rows={4}
            value={draft ?? ''}
            onChange={(event) => setDraft(event.target.value)}
          />
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            {length > BODY_MAX ? (
              <DisabledReason reason={BODY_TOO_LONG}>저장</DisabledReason>
            ) : (
              <button type="submit" className={styles.primary} disabled={set.isPending}>
                {set.isPending ? '저장하는 중' : '저장'}
              </button>
            )}
            <button
              type="button"
              className={styles.secondary}
              disabled={set.isPending}
              onClick={() => {
                set.reset();
                setDraft(null);
              }}
            >
              취소
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
