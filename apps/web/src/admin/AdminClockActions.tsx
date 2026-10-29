import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { publicFailure, retryAfterSeconds } from '../auth/credentials';
import { useTRPCClient } from '../trpc';
import styles from './AdminPages.module.css';

type World = inferRouterOutputs<AppRouter>['admin']['world']['list'][number];
type Input = inferRouterInputs<AppRouter>['admin']['world']['requestClock'];
type Reply = inferRouterOutputs<AppRouter>['admin']['world']['clockRequest'];
type Command = { input: Input; name: string };
const actions = { PREOPEN: 'start', RUNNING: 'pause', PAUSED: 'resume' } as const;
const names = { start: '시작', pause: '일시정지', resume: '재개' } as const;
const states = { PREOPEN: '개장 전', RUNNING: '진행 중', PAUSED: '일시정지', ENDED: '종료' } as const;
const descriptions = {
  start: '월드를 시작합니다. 접수 뒤 엔진이 상태를 적용합니다.',
  pause: '게임 시계를 멈추고 접수한 예약은 보존합니다.',
  resume: '멈춘 시계에서 이어집니다. 예약을 다시 제출하지 않습니다.',
};
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium' });

export function AdminClockActions({
  viewerId,
  worlds,
  onClear,
  onLockChange,
}: {
  viewerId: string;
  worlds: World[] | null;
  onClear: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const client = useTRPCClient(),
    router = useRouter();
  const [worldId, setWorldId] = useState(''),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [command, setCommand] = useState<Command | null>(null),
    [reply, setReply] = useState<Reply | null>(null),
    [sending, setSending] = useState(false),
    [fresh, setFresh] = useState(true),
    [error, setError] = useState<string | null>(null),
    [notAccepted, setNotAccepted] = useState(false),
    [retryAt, setRetryAt] = useState<number | null>(null),
    [now, setNow] = useState(() => Date.now());
  const generation = useRef(0),
    mounted = useRef(true),
    busy = useRef(false);
  const world = worlds?.find((value) => value.id === worldId),
    action = world && world.status !== 'ENDED' ? actions[world.status] : undefined,
    normalizedReason = reason.trim(),
    validReason =
      normalizedReason.length > 0 &&
      normalizedReason.length <= 200 &&
      [...normalizedReason].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    remaining = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  const terminal = reply?.status === 'APPLIED' || reply?.status === 'REJECTED';
  useLayoutEffect(() => setConfirmed(false), [world?.id, world?.status, world?.replayFormat, action]);

  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current++;
      setFresh(false);
      setReply(null);
      setReason('');
      setConfirmed(false);
      setWorldId('');
      setError(null);
    };
    for (const event of ['focus', 'blur', 'online', 'offline']) window.addEventListener(event, invalidate);
    document.addEventListener('visibilitychange', invalidate);
    return () => {
      mounted.current = false;
      generation.current++;
      for (const event of ['focus', 'blur', 'online', 'offline']) window.removeEventListener(event, invalidate);
      document.removeEventListener('visibilitychange', invalidate);
    };
  }, [viewerId]);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  useBlocker({
    disabled: command === null || terminal || notAccepted,
    enableBeforeUnload: command !== null && !terminal && !notAccepted,
    shouldBlockFn: ({ next }) => {
      if (['/login', '/verify-email', '/legal/agree'].includes(next.pathname)) return false;
      setError('월드 요청 결과를 먼저 확인하세요.');
      return true;
    },
  });

  function reset() {
    setCommand(null);
    setReply(null);
    setNotAccepted(false);
    setRetryAt(null);
    setWorldId('');
    setReason('');
    setConfirmed(false);
    onClear();
    onLockChange(false);
  }
  function denied() {
    reset();
    setFresh(false);
    setError('계정과 권한을 다시 확인합니다.');
    void router.invalidate();
  }
  async function identity(own: number) {
    const before = await client.auth.me.query();
    if (!mounted.current) return false;
    if (before.user?.id !== viewerId) {
      denied();
      return false;
    }
    await client.admin.whoami.query();
    const after = await client.auth.me.query();
    if (!mounted.current) return false;
    if (after.user?.id !== viewerId) {
      denied();
      return false;
    }
    return own === generation.current;
  }
  function failure(value: unknown, write: boolean) {
    const code = publicFailure(value)?.code;
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      denied();
      return;
    }
    if (write && code && ['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND'].includes(code)) {
      setNotAccepted(true);
      setError('이 내용으로 접수하지 못했습니다. 월드를 다시 조회한 뒤 새 요청을 작성하세요.');
      return;
    }
    const seconds = retryAfterSeconds(value);
    if (code === 'TOO_MANY_REQUESTS' && seconds !== null) setRetryAt(Date.now() + seconds * 1000);
    setError(
      code === 'NOT_FOUND'
        ? '접수 기록을 찾지 못했습니다. 같은 요청 접수 확인으로 이어갈 수 있습니다.'
        : code === 'TOO_MANY_REQUESTS'
          ? '요청이 많습니다. 표시한 시간이 지난 뒤 다시 확인하세요.'
          : '결과를 확인하지 못했습니다. 결과 조회 또는 같은 요청 접수 확인을 눌러 주세요.',
    );
  }
  async function recheckIdentity() {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const own = generation.current;
    try {
      if (await identity(own)) setFresh(true);
    } catch (value) {
      if (mounted.current && own === generation.current) failure(value, false);
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function send(value: Command, write: boolean) {
    if (busy.current || !fresh || (retryAt !== null && Date.now() < retryAt)) return;
    busy.current = true;
    setSending(true);
    setError(null);
    setRetryAt(null);
    const own = generation.current;
    try {
      if (!(await identity(own))) return;
      const result = write
        ? await client.admin.world.requestClock.mutate(value.input)
        : await client.admin.world.clockRequest.query({
            expectedUserId: viewerId,
            worldId: value.input.worldId,
            idempotencyKey: value.input.idempotencyKey,
          });
      if (!(await identity(own))) return;
      if (result.action !== value.input.action) {
        setError('요청 내용이 다릅니다. 관리자 기록을 확인하세요.');
        return;
      }
      setReply(result);
      setNotAccepted(false);
    } catch (value) {
      if (mounted.current && own === generation.current) failure(value, write);
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      busy.current ||
      command ||
      !fresh ||
      !world ||
      world.replayFormat !== 3 ||
      !action ||
      !validReason ||
      !confirmed
    )
      return;
    const value: Command = {
      name: world.name,
      input: {
        expectedUserId: viewerId,
        worldId: world.id,
        action,
        reason: normalizedReason,
        idempotencyKey: crypto.randomUUID(),
      },
    };
    setCommand(value);
    setReply(null);
    setNotAccepted(false);
    onLockChange(true);
    void send(value, true);
  }
  return (
    <section className={styles.sanctionActions} aria-label="월드 시계 조치">
      <h3>월드 시계 조치</h3>
      {!fresh ? (
        <>
          <p>현재 계정과 권한을 확인한 뒤 조치를 이어갈 수 있습니다.</p>
          <button type="button" disabled={sending} onClick={() => void recheckIdentity()}>
            계정과 권한 다시 확인
          </button>
        </>
      ) : command ? (
        <>
          <p>대상 {command.name}</p>
          <p>
            월드 UUID <code>{command.input.worldId}</code>
          </p>
          <p>
            {names[command.input.action]} · 사유 {command.input.reason}
          </p>
          <p>
            요청 번호 <code>{command.input.idempotencyKey}</code>
          </p>
          {reply?.status === 'PENDING' ? <p role="status">접수됨 · 엔진 처리 대기</p> : null}
          {reply?.status === 'APPLIED' && reply.result && 'after' in reply.result ? (
            <div role="status">
              <p>
                적용 완료 · {states[reply.result.before.status]} → {states[reply.result.after.status]}
              </p>
              <p>
                적용 시각 (한국) <time dateTime={reply.result.at}>{time.format(new Date(reply.result.at))}</time>
              </p>
              <p>
                tick {reply.tick} · sequence {reply.sequence}
              </p>
            </div>
          ) : null}
          {reply?.status === 'REJECTED' && reply.result && 'message' in reply.result ? (
            <p role="status">적용하지 않음 · {reply.result.message}</p>
          ) : null}
          {!terminal && !notAccepted ? (
            <>
              <button type="button" disabled={sending || remaining > 0} onClick={() => void send(command, false)}>
                요청 결과 조회
              </button>{' '}
              <button type="button" disabled={sending || remaining > 0} onClick={() => void send(command, true)}>
                같은 요청 접수 확인
              </button>
            </>
          ) : (
            <button type="button" disabled={sending} onClick={reset}>
              새 요청 작성
            </button>
          )}
        </>
      ) : (
        <form className={styles.noticeForm} onSubmit={submit}>
          <label>
            조치할 월드
            <select
              aria-label="조치할 월드"
              value={worldId}
              disabled={sending}
              onChange={(event) => {
                setWorldId(event.target.value);
                setConfirmed(false);
              }}
            >
              <option value="">먼저 월드를 조회하고 선택하세요</option>
              {worlds?.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name} · {states[value.status]} · {value.id}
                </option>
              ))}
            </select>
          </label>
          {world ? (
            <p>
              월드 UUID <code>{world.id}</code> · {states[world.status]}
            </p>
          ) : null}
          {world && world.replayFormat !== 3 ? (
            <p>이 월드의 재생 형식에서는 시계 조치를 사용할 수 없습니다.</p>
          ) : world?.status === 'ENDED' ? (
            <p>종료한 월드에는 시계 조치를 적용할 수 없습니다.</p>
          ) : action ? (
            <p>
              {names[action]} · {descriptions[action]}
            </p>
          ) : null}
          <label>
            시계 조치 사유 (1~200자)
            <textarea
              aria-label="시계 조치 사유 (1~200자)"
              value={reason}
              maxLength={200}
              disabled={sending || !action || world?.replayFormat !== 3}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={sending || !action || world?.replayFormat !== 3}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            대상·현재 상태·사유와 시계 조치를 확인했습니다.
          </label>
          <button
            type="submit"
            disabled={sending || !action || world?.replayFormat !== 3 || !validReason || !confirmed}
          >
            {action ? names[action] : '시계 조치'} 요청 확정
          </button>
        </form>
      )}
      {sending ? <p role="status">계정·권한과 요청을 확인하고 있습니다…</p> : null}
      {remaining > 0 ? <p role="status">{remaining}초 뒤 다시 확인할 수 있습니다.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
