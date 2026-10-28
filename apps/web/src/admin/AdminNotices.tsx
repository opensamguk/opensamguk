import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { useBlocker, useRouteContext, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { publicFailure, retryAfterSeconds } from '../auth/credentials';
import { useTRPCClient } from '../trpc';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { usePrivateRead } from './usePrivateRead';
import styles from './AdminPages.module.css';

type Inputs = inferRouterInputs<AppRouter>['admin']['notice'];
type Page = inferRouterOutputs<AppRouter>['admin']['notice']['list'];
type Row = Page['items'][number];
type Filter = Omit<Inputs['list'], 'cursor'>;
type Command =
  | { kind: 'create'; input: Inputs['create'] }
  | { kind: 'update'; input: Inputs['update'] }
  | { kind: 'hide'; input: Inputs['hide'] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function AdminNotices() {
  const viewerId = useRouteContext({ from: '/admin' }).adminViewerId,
    client = useTRPCClient(),
    router = useRouter();
  const query = usePrivateRead<Page>(viewerId);
  const [scope, setScope] = useState<'LOBBY' | 'WORLD'>('LOBBY'),
    [worldId, setWorldId] = useState(''),
    [filter, setFilter] = useState<Filter | null>(null),
    [editing, setEditing] = useState<Row | null>(null),
    [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [reason, setReason] = useState(''),
    [confirmHide, setConfirmHide] = useState(false),
    [command, setCommand] = useState<Command | null>(null),
    [sending, setSending] = useState(false),
    [retryAt, setRetryAt] = useState<number | null>(null),
    [now, setNow] = useState(() => Date.now()),
    [message, setMessage] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const active = useRef(true),
    busy = useRef(false),
    identityGeneration = useRef(0);
  const remaining = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  useBlocker({
    disabled: command === null,
    enableBeforeUnload: command !== null,
    shouldBlockFn: ({ next }) => {
      if (['/login', '/verify-email', '/legal/agree'].includes(next.pathname)) return false;
      setError('공지를 처리한 결과를 먼저 확인하세요. 같은 요청 다시 확인으로 이어갈 수 있습니다.');
      return true;
    },
  });
  useEffect(() => {
    active.current = true;
    const invalidate = () => {
      identityGeneration.current++;
    };
    for (const event of ['focus', 'blur', 'online', 'offline']) window.addEventListener(event, invalidate);
    document.addEventListener('visibilitychange', invalidate);
    return () => {
      active.current = false;
      identityGeneration.current++;
      for (const event of ['focus', 'blur', 'online', 'offline']) window.removeEventListener(event, invalidate);
      document.removeEventListener('visibilitychange', invalidate);
    };
  }, []);

  function clearDraft() {
    setEditing(null);
    setTitle('');
    setBody('');
    setReason('');
    setConfirmHide(false);
  }
  function chooseFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (command || busy.current) return;
    const id = worldId.trim();
    if (scope === 'WORLD' && !uuid.test(id)) {
      setError('월드 UUID를 확인하세요.');
      return;
    }
    const value: Filter = scope === 'LOBBY' ? { scope } : { scope, worldId: id };
    setFilter(value);
    clearDraft();
    setError(null);
    setMessage(null);
    void query.read((signal) => client.admin.notice.list.query(value, { signal }));
  }
  function changeScope() {
    if (command || busy.current) return;
    query.clear();
    setFilter(null);
    clearDraft();
    setMessage(null);
    setError(null);
  }
  async function send(value: Command) {
    if (busy.current || (retryAt !== null && Date.now() < retryAt)) return;
    busy.current = true;
    setSending(true);
    setError(null);
    setMessage(null);
    setRetryAt(null);
    const generation = identityGeneration.current;
    try {
      const identity = await client.auth.me.query();
      if (!active.current) return;
      if (generation !== identityGeneration.current) {
        setError('접근 권한을 다시 확인한 뒤 같은 요청 다시 확인을 눌러 주세요.');
        return;
      }
      if (identity.user?.id !== viewerId) {
        if (active.current) {
          setCommand(null);
          clearDraft();
          query.clear();
          setError('계정과 권한을 다시 확인합니다.');
          void router.invalidate();
        }
        return;
      }
      if (value.kind === 'create') await client.admin.notice.create.mutate(value.input);
      else if (value.kind === 'update') await client.admin.notice.update.mutate(value.input);
      else await client.admin.notice.hide.mutate(value.input);
      if (!active.current) return;
      setCommand(null);
      clearDraft();
      setMessage(
        value.kind === 'hide'
          ? '공지를 숨겼습니다.'
          : value.kind === 'update'
            ? '공지를 수정했습니다.'
            : '공지를 발행했습니다.',
      );
      if (filter) void query.read((signal) => client.admin.notice.list.query(filter, { signal }));
    } catch (failure) {
      if (!active.current) return;
      const code = publicFailure(failure)?.code;
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
        setCommand(null);
        clearDraft();
        query.clear();
        setError('계정과 권한을 다시 확인합니다.');
        void router.invalidate();
      } else if (code && ['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND'].includes(code)) {
        setCommand(null);
        if (code === 'CONFLICT') {
          query.clear();
          setError('다른 요청으로 공지가 바뀌었습니다. 목록을 다시 조회하세요.');
        } else setError('공지를 처리하지 못했습니다. 입력과 공지 범위를 확인하세요.');
      } else {
        // 반영 여부를 모르면 입력과 UUID를 바꾸지 않고 같은 요청만 다시 보낸다.
        const seconds = code === 'TOO_MANY_REQUESTS' ? retryAfterSeconds(failure) : null;
        if (seconds !== null) {
          const time = Date.now();
          setNow(time);
          setRetryAt(time + seconds * 1000);
        }
        setError(
          code === 'TOO_MANY_REQUESTS'
            ? '요청이 많습니다. 잠시 뒤 같은 요청 다시 확인을 눌러 주세요.'
            : '처리 결과를 확인하지 못했습니다. 같은 요청 다시 확인을 눌러 주세요.',
        );
      }
    } finally {
      busy.current = false;
      if (active.current) setSending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>, hide = false) {
    event.preventDefault();
    if (!filter || command || busy.current) return;
    const trimmedTitle = title.trim(),
      trimmedBody = body.trim(),
      trimmedReason = reason.trim();
    if (
      hide
        ? !editing || !confirmHide || !trimmedReason || trimmedReason.length > 200
        : !trimmedTitle || trimmedTitle.length > 200 || !trimmedBody || trimmedBody.length > 2000
    ) {
      setError(hide ? '숨김 사유1~200자와 확인이 필요합니다.' : '제목1~200자와 본문1~2,000자를 입력하세요.');
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    const value: Command =
      hide && editing
        ? {
            kind: 'hide',
            input: { id: editing.id, expectedRevision: editing.revision, idempotencyKey, reason: trimmedReason },
          }
        : editing
          ? {
              kind: 'update',
              input: {
                id: editing.id,
                expectedRevision: editing.revision,
                idempotencyKey,
                title: trimmedTitle,
                body: trimmedBody,
              },
            }
          : { kind: 'create', input: { ...filter, idempotencyKey, title: trimmedTitle, body: trimmedBody } };
    setCommand(value);
    void send(value);
  }
  const locked = command !== null || sending;
  return (
    <section>
      <h2>공지 관리</h2>
      <p>로비 또는 월드 공지를 발행·수정·숨깁니다. 숨긴 공지와 감사 기록은 보존됩니다. 시각은 한국 시각입니다.</p>
      <form className={styles.form} onSubmit={chooseFilter}>
        <label>
          공지 범위
          <select
            value={scope}
            disabled={locked}
            onChange={(event) => {
              changeScope();
              setScope(event.target.value as 'LOBBY' | 'WORLD');
            }}
          >
            <option value="LOBBY">로비</option>
            <option value="WORLD">월드</option>
          </select>
        </label>
        {scope === 'WORLD' ? (
          <label>
            월드 UUID
            <input
              value={worldId}
              maxLength={36}
              required
              disabled={locked}
              onChange={(event) => {
                changeScope();
                setWorldId(event.target.value);
              }}
              autoComplete="off"
            />
          </label>
        ) : null}
        <button disabled={locked || query.pending}>목록 조회</button>
      </form>
      {error || query.error ? <ErrorState title={error ?? query.error!} /> : null}
      {message ? <p role="status">{message}</p> : null}
      {sending ? <LoadingState>공지를 처리하는 중입니다.</LoadingState> : null}
      {command && !sending ? (
        <div role="status">
          <p>새 요청을 만들기 전에 이전 요청의 결과를 확인하세요.</p>
          {remaining > 0 ? <p role="status">다시 확인까지 {remaining}초</p> : null}
          <button disabled={remaining > 0} onClick={() => void send(command)}>
            같은 요청 다시 확인
          </button>
        </div>
      ) : null}
      {query.pending ? <LoadingState /> : null}
      {query.data ? (
        <>
          {query.data.items.length === 0 ? (
            <EmptyState title="공지가 없습니다" />
          ) : (
            <ol className={styles.notices}>
              {query.data.items.map((row) => (
                <li key={row.id} data-notice-id={row.id}>
                  <h3>{row.title ?? '제목 없는 월드 공지'}</h3>
                  <p className={styles.noticeBody}>{row.body}</p>
                  <p>
                    <time dateTime={row.publishedAt}>{time.format(new Date(row.publishedAt))}</time> · 판{row.revision}{' '}
                    · {row.hiddenAt ? '숨김' : '게시 중'}
                    {row.pinned ? ' · 고정' : ''}
                  </p>
                  {row.hiddenAt ? (
                    <p>
                      숨긴 시각 <time dateTime={row.hiddenAt}>{time.format(new Date(row.hiddenAt))}</time>
                    </p>
                  ) : (
                    <button
                      disabled={locked}
                      onClick={() => {
                        setEditing(row);
                        setTitle(row.title ?? '');
                        setBody(row.body);
                        setReason('');
                        setConfirmHide(false);
                        setError(null);
                        setMessage(null);
                      }}
                    >
                      수정·숨김 선택
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {query.data.next && filter ? (
            <button
              disabled={locked || query.pending}
              onClick={() => {
                const next = query.data!.next!;
                clearDraft();
                void query.read((signal) => client.admin.notice.list.query({ ...filter, cursor: next }, { signal }));
              }}
            >
              다음50개
            </button>
          ) : null}
        </>
      ) : null}
      {filter ? (
        <>
          <h3>{editing ? '선택한 공지 수정' : '새 공지'}</h3>
          <p>발행 범위: {filter.scope === 'LOBBY' ? '로비' : `월드 ${filter.worldId}`}</p>
          {editing ? (
            <button disabled={locked} onClick={clearDraft}>
              새 공지로 전환
            </button>
          ) : null}
          <form className={styles.noticeForm} onSubmit={submit}>
            <label>
              제목
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={200}
                disabled={locked}
              />
            </label>
            <label>
              본문
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                required
                maxLength={2000}
                rows={8}
                disabled={locked}
              />
            </label>
            <button disabled={locked}>{editing ? '수정 저장' : '공지 발행'}</button>
          </form>
          {editing ? (
            <form className={styles.noticeForm} onSubmit={(event) => submit(event, true)}>
              <label>
                숨김 사유
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  maxLength={200}
                  rows={2}
                  disabled={locked}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmHide}
                  onChange={(event) => setConfirmHide(event.target.checked)}
                  disabled={locked}
                />
                일반 화면에서 숨기고 이력을 보존합니다.
              </label>
              <button disabled={locked || !confirmHide}>공지 숨김</button>
            </form>
          ) : null}
        </>
      ) : (
        <p>공지 범위를 조회한 뒤 작성할 수 있습니다.</p>
      )}
    </section>
  );
}
