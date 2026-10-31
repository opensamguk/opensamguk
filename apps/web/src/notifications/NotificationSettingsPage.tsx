import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import messagesIconUrl from '../art/icons/messages.png';
import { retryUnlessClientError } from '../game/errors';
import { errorCode, serverMessage } from '../turns/apiError';
import { DisabledReason } from '../ui/DisabledReason';
import { ErrorState, LoadingState } from '../ui/States';
import { api, notificationKey, type NotificationEvent, type NotificationResponse } from './contract';
import styles from './NotificationSettingsPage.module.css';

const SAVE_FAILED = '알림 설정을 저장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.';
export const GONE_TEXT = '웹훅이 더 이상 받지 않습니다. 주소를 다시 등록해 주세요.';

// 서버가 준 고정 안내 문장만 보인다(T2-20 결과 분류별 문장). 디스코드 응답·주소는 서버가 싣지 않는다.
// 응답을 못 받았으면 화면 문장을 쓴다. 오류 객체는 콘솔·오류 보고에 남기지 않는다.
export function failureText(error: unknown): string {
  return serverMessage(error) ?? SAVE_FAILED;
}

function useNotification() {
  return useQuery({
    queryKey: notificationKey,
    queryFn: () => api.notification.get.query(),
    retry: retryUnlessClientError,
  });
}

// /settings/notifications: 계정 단위 알림 설정 (T2-21). 월드와 무관하다.
export function NotificationSettingsPage() {
  return (
    <main className={styles.page}>
      {/* 먹 띠 제목 (INT-20) */}
      <header className={styles.header}>
        <span className={styles.brand}>오픈삼국</span>
        <h1>알림 설정</h1>
        <Link to="/" className={styles.back}>
          로비로
        </Link>
      </header>
      <NotificationSettings />
    </main>
  );
}

export function NotificationSettings() {
  const query = useNotification();
  if (query.data) return <Settings data={query.data} refetch={() => void query.refetch()} />;
  if (query.isError) return <ErrorState title="알림 설정을 불러오지 못했습니다" onRetry={() => void query.refetch()} />;
  return <LoadingState />;
}

function Settings({ data, refetch }: { data: NotificationResponse; refetch: () => void }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // 등록 전에 고른 종류. 등록하면 setDiscord가 이 값으로 저장한다.
  const [localEvents, setLocalEvents] = useState<NotificationEvent[]>(() => data.eventOptions.map((o) => o.key));

  const apply = useCallback(
    (next: NotificationResponse) => queryClient.setQueryData(notificationKey, next),
    [queryClient],
  );
  // CONFLICT면 최신 상태로 다시 그리고 서버 문장을 띄운다.
  const fail = useCallback(
    (error: unknown) => {
      setNotice({ tone: 'error', text: failureText(error) });
      if (errorCode(error) === 'CONFLICT') refetch();
    },
    [refetch],
  );

  const saver = useEventSaver(data, apply, fail);
  const registered = data.discord;
  const shownEvents = registered ? saver.events : localEvents;

  return (
    <div className={styles.sections}>
      <section className={`${styles.section} ${styles.discord}`} aria-labelledby="discord-title">
        <div className={styles.sectionHead}>
          <img className={styles.icon} src={messagesIconUrl} alt="" width={32} height={32} />
          <h2 id="discord-title">디스코드 웹훅</h2>
        </div>
        {registered ? (
          <Registered
            data={data}
            onRemoved={(next) => {
              apply(next);
              setNotice({ tone: 'ok', text: '웹훅을 해제했습니다.' });
            }}
            onError={fail}
          />
        ) : (
          <p className={styles.muted}>등록한 웹훅이 없습니다.</p>
        )}
        <WebhookForm
          data={data}
          events={shownEvents}
          onSaved={(next) => {
            apply(next);
            setNotice({ tone: 'ok', text: '등록했습니다. 시험 메시지를 보냈습니다.' });
          }}
          onError={fail}
          onStart={() => setNotice(null)}
        />
        {notice ? (
          <p
            className={notice.tone === 'ok' ? styles.ok : styles.error}
            role={notice.tone === 'ok' ? 'status' : 'alert'}
          >
            {notice.text}
          </p>
        ) : null}
      </section>

      <section className={`${styles.section} ${styles.eventsSection}`} aria-labelledby="events-title">
        <h2 id="events-title">받을 알림</h2>
        {registered ? null : <p className={styles.muted}>고른 종류는 웹훅을 등록할 때 함께 저장합니다.</p>}
        <fieldset className={styles.events}>
          <legend className={styles.srOnly}>받을 알림 종류</legend>
          {data.eventOptions.map((option) => {
            const checked = shownEvents.includes(option.key);
            const pending = registered ? saver.pending(option.key) : false;
            return (
              <label key={option.key} className={styles.check}>
                <input
                  type="checkbox"
                  checked={checked}
                  aria-busy={pending || undefined}
                  aria-describedby={pending ? `pending-${option.key}` : undefined}
                  onChange={() =>
                    registered
                      ? saver.toggle(option.key)
                      : setLocalEvents((prev) => toggleEvent(data, prev, option.key))
                  }
                />
                {option.name}
                {pending ? (
                  <span id={`pending-${option.key}`} className={styles.pending}>
                    저장 중
                  </span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
      </section>

      <section className={`${styles.section} ${styles.howto}`} aria-labelledby="howto-title">
        <h2 id="howto-title">웹훅 만드는 법</h2>
        <ol className={styles.steps}>
          <li>디스코드에서 알림을 받을 채널의 설정(톱니바퀴)을 엽니다.</li>
          <li>연동 메뉴에서 웹후크를 고르고 새 웹후크를 만듭니다.</li>
          <li>웹후크 URL 복사를 눌러 위 칸에 붙여 넣고 시험 보내고 저장을 누릅니다.</li>
        </ol>
      </section>
    </div>
  );
}

// eventOptions 순서를 지킨다.
export function toggleEvent(
  data: NotificationResponse,
  current: readonly NotificationEvent[],
  key: NotificationEvent,
): NotificationEvent[] {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return data.eventOptions.map((o) => o.key).filter((k) => next.has(k));
}

const sameEvents = (a: readonly NotificationEvent[], b: readonly NotificationEvent[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

// 체크를 바꾸면 바로 setEvents로 저장한다. 요청은 하나씩 보내고, 앞 요청이 끝났을 때 마지막 상태가 다르면 그 상태로 한 번 더 보낸다.
// 늘 마지막으로 받은 generation을 보낸다. 실패하면 서버 상태로 되돌린다 (T2-20 설정 변경 경합).
export function useEventSaver(
  data: NotificationResponse,
  apply: (next: NotificationResponse) => void,
  fail: (error: unknown) => void,
) {
  const server = data.discord?.events ?? [];
  const [desired, setDesired] = useState<NotificationEvent[] | null>(null);
  const desiredRef = useRef<NotificationEvent[] | null>(null);
  const latest = useRef(data);
  const running = useRef(false);

  useEffect(() => {
    latest.current = data;
  }, [data]);

  const set = (next: NotificationEvent[] | null) => {
    desiredRef.current = next;
    setDesired(next);
  };

  const pump = async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const target = desiredRef.current;
        if (target === null) return;
        const response = await api.notification.setEvents.mutate({
          events: target,
          generation: latest.current.generation,
        });
        latest.current = response;
        apply(response);
        const now = desiredRef.current;
        if (now === null || sameEvents(now, response.discord?.events ?? [])) {
          set(null);
          return;
        }
      }
    } catch (error) {
      set(null);
      fail(error);
    } finally {
      running.current = false;
    }
  };

  const events = desired ?? server;
  return {
    events,
    pending: (key: NotificationEvent) => desired !== null && events.includes(key) !== server.includes(key),
    toggle: (key: NotificationEvent) => {
      set(toggleEvent(latest.current, desiredRef.current ?? latest.current.discord?.events ?? [], key));
      void pump();
    },
  };
}

function Registered({
  data,
  onRemoved,
  onError,
}: {
  data: NotificationResponse;
  onRemoved: (next: NotificationResponse) => void;
  onError: (error: unknown) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const discord = data.discord!;
  const remove = async () => {
    setBusy(true);
    try {
      onRemoved(await api.notification.removeDiscord.mutate({ generation: data.generation }));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <div className={styles.registered}>
      <p data-testid="webhook-registered">
        등록됨 (…{discord.last4})
        {discord.status === 'disabled' ? <span className={styles.badge}>받지 않음</span> : null}
      </p>
      {discord.status === 'disabled' ? (
        <p className={styles.error} role="alert">
          {GONE_TEXT}
        </p>
      ) : null}
      {confirming ? (
        <div role="alertdialog" aria-labelledby="remove-title" className={styles.confirm}>
          <p id="remove-title">웹훅을 해제할까요? 해제하면 알림을 보내지 않습니다.</p>
          <div className={styles.buttons}>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => void remove()}>
              {busy ? '해제하는 중' : '해제'}
            </button>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => setConfirming(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.secondary} onClick={() => setConfirming(true)}>
          해제
        </button>
      )}
    </div>
  );
}

// 주소 입력 칸은 저장이나 실패 뒤 바로 비운다. 주소는 이 칸 밖(화면, 콘솔, query·mutation 캐시)에 남기지 않는다.
// 그래서 useMutation을 쓰지 않고 바로 부른다. useMutation은 보낸 입력을 캐시에 들고 있다.
function WebhookForm({
  data,
  events,
  onSaved,
  onError,
  onStart,
}: {
  data: NotificationResponse;
  events: NotificationEvent[];
  onSaved: (next: NotificationResponse) => void;
  onError: (error: unknown) => void;
  onStart: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const save = async () => {
    const value = url.trim();
    if (!value || busy) return;
    onStart();
    setBusy(true);
    setUrl('');
    try {
      onSaved(await api.notification.setDiscord.mutate({ url: value, events, generation: data.generation }));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor={fieldId}>{data.discord ? '새 웹훅 주소로 다시 등록' : '웹훅 주소'}</label>
      <input
        id={fieldId}
        className={styles.input}
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://discord.com/api/webhooks/…"
        value={url}
        disabled={busy}
        onChange={(event) => setUrl(event.target.value)}
      />
      <div className={styles.buttons}>
        {busy ? (
          <DisabledReason reason="시험 메시지를 보내는 중입니다.">시험 보내는 중</DisabledReason>
        ) : url.trim() ? (
          <button type="submit" className={styles.primary}>
            시험 보내고 저장
          </button>
        ) : (
          <DisabledReason reason="웹훅 주소를 넣으세요.">시험 보내고 저장</DisabledReason>
        )}
      </div>
    </form>
  );
}
