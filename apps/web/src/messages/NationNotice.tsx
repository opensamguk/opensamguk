import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { serverMessage } from '../turns/apiError';
import { DisabledReason } from '../ui/DisabledReason';
import { ErrorState } from '../ui/States';
import { api, noticeKeys, type NationNotice } from './contract';
import { useDraft } from './drafts';
import { formatTime } from './MessagePanel';
import { useNationNotice } from './queries';
import styles from './NationNotice.module.css';

const NOTICE_MAX = 1_000;
const seenKey = (notice: NationNotice) => `${notice.nationId}:${notice.revision}`;

// 국가 공지 팝업. 바뀐 공지(unseen)를 첫 접속 때 한 번 띄운다 (T2-09 국가 공지 읽음, 검토 R63-3R).
// 닫을 때는 팝업을 열 때 담아 둔 nationId·revision을 보낸다. 그사이 SSE나 ready 재조회로 캐시가 바뀌어도 캐시 값을 보내지 않는다.
// 응답의 unseen이 아직 true면(그사이 새 공지, 또는 다른 국가로 옮김) 그 응답 본문으로 한 번 더 띄운다. null이면(재야) 띄우지 않는다.
export function NationNoticePopup({ worldId }: { worldId: string }) {
  const queryClient = useQueryClient();
  const notice = useNationNotice(worldId);
  const [shown, setShown] = useState<NationNotice | null>(null);
  const [closing, setClosing] = useState(false);
  // 읽음 처리에 실패한 판은 이 탭에서 다시 띄우지 않는다. 다음 접속 때 다시 뜬다.
  const failed = useRef(new Set<string>());
  const data = notice.data;

  useEffect(() => {
    if (shown || closing || !data?.unseen || failed.current.has(seenKey(data))) return;
    setShown(data);
  }, [closing, data, shown]);

  const close = async () => {
    if (!shown) return;
    const { nationId, revision } = shown;
    setShown(null);
    setClosing(true);
    try {
      const result = await api.notice.nation.markSeen.mutate({ worldId, nationId, revision });
      queryClient.setQueryData(noticeKeys.nation(worldId), result);
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

// 메인 국가 정보 칸의 공지. 군주·참모(canEdit)만 고친다. 고치는 중인 글은 drafts.ts에 두어 재조회로 지워지지 않는다.
export function NationNoticeBox({ worldId }: { worldId: string }) {
  const queryClient = useQueryClient();
  const notice = useNationNotice(worldId);
  const [draft, setDraft] = useDraft<string | null>(`notice:edit:${worldId}`, null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  if (notice.isError)
    return <ErrorState title="국가 공지를 불러오지 못했습니다" onRetry={() => void notice.refetch()} />;
  const data = notice.data;
  if (!data) return null;

  const save = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.notice.nation.set.mutate({ worldId, body: draft });
      queryClient.setQueryData(noticeKeys.nation(worldId), result);
      setDraft(null);
    } catch (caught) {
      setError(serverMessage(caught) ?? '저장하지 못했습니다. 연결을 확인하고 다시 저장하세요.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.box} aria-label="국가 공지" data-testid="nation-notice">
      <div className={styles.boxHead}>
        <h3 className={styles.boxTitle}>국가 공지</h3>
        {draft !== null ? null : data.canEdit ? (
          <button type="button" className={styles.secondary} onClick={() => setDraft(data.body)}>
            고치기
          </button>
        ) : (
          <DisabledReason reason="군주와 참모만 고칠 수 있습니다.">고치기</DisabledReason>
        )}
      </div>
      {draft === null ? (
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
              {draft.length}/{NOTICE_MAX}
            </span>
          </label>
          <textarea
            id={fieldId}
            className={styles.textarea}
            rows={4}
            maxLength={NOTICE_MAX}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={saving}>
              {saving ? '저장하는 중' : '저장'}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={saving}
              onClick={() => {
                setError(null);
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
