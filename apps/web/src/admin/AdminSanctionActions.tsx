import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { publicFailure, retryAfterSeconds } from '../auth/credentials';
import { useTRPCClient } from '../trpc';
import { parseSanctionExpiry } from './sanctionTime';
import styles from './AdminPages.module.css';

type Detail = inferRouterOutputs<AppRouter>['admin']['user']['get'];
type Inputs = inferRouterInputs<AppRouter>['admin']['sanction'];
type Command =
  { kind: 'create'; userId: string; input: Inputs['create'] } | { kind: 'lift'; userId: string; input: Inputs['lift'] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });

export function AdminSanctionActions({
  viewerId,
  target,
  onRead,
  onClear,
  onLockChange,
}: {
  viewerId: string;
  target: Detail | null;
  onRead: (userId: string) => void;
  onClear: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const client = useTRPCClient(),
    router = useRouter();
  const [scope, setScope] = useState<'GLOBAL' | 'WORLD'>('GLOBAL'),
    [worldId, setWorldId] = useState(''),
    [reason, setReason] = useState(''),
    [indefinite, setIndefinite] = useState(true),
    [expires, setExpires] = useState(''),
    [selected, setSelected] = useState<string | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [command, setCommand] = useState<Command | null>(null),
    [sending, setSending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null),
    [retryAt, setRetryAt] = useState<number | null>(null),
    [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true),
    busy = useRef(false),
    generation = useRef(0),
    previousTarget = useRef<string | null>(null);
  const remaining = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current++;
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
  useEffect(() => {
    if (command || busy.current) return;
    const id = target?.userId ?? null;
    if (id === null) {
      clearDraft();
      return;
    }
    if (previousTarget.current !== id) {
      previousTarget.current = id;
      clearDraft();
      setError(null);
      setMessage(null);
    }
  }, [target?.userId, command]);
  useBlocker({
    disabled: command === null,
    enableBeforeUnload: command !== null,
    shouldBlockFn: ({ next }) => {
      if (['/login', '/verify-email', '/legal/agree'].includes(next.pathname)) return false;
      setError('제재 처리 결과를 먼저 확인하세요. 같은 요청 다시 확인으로 이어갈 수 있습니다.');
      return true;
    },
  });

  function release() {
    setCommand(null);
    onLockChange(false);
    setRetryAt(null);
  }
  function clearDraft() {
    setScope('GLOBAL');
    setReason('');
    setSelected(null);
    setConfirmed(false);
    setWorldId('');
    setExpires('');
    setIndefinite(true);
  }
  function denyIdentity() {
    release();
    clearDraft();
    onClear();
    setMessage(null);
    setError('계정과 권한을 다시 확인합니다.');
    void router.invalidate();
  }
  async function send(value: Command) {
    if (busy.current || (retryAt !== null && Date.now() < retryAt)) return;
    busy.current = true;
    setSending(true);
    setError(null);
    setMessage(null);
    setRetryAt(null);
    const own = generation.current;
    try {
      const identity = await client.auth.me.query();
      if (!mounted.current) return;
      if (identity.user?.id !== viewerId) {
        denyIdentity();
        return;
      }
      if (own !== generation.current) {
        setError('접근 권한을 다시 확인한 뒤 같은 요청 다시 확인을 눌러 주세요.');
        return;
      }
      if (value.kind === 'create') await client.admin.sanction.create.mutate(value.input);
      else await client.admin.sanction.lift.mutate(value.input);
      const after = await client.auth.me.query();
      if (!mounted.current) return;
      if (after.user?.id !== viewerId) {
        denyIdentity();
        return;
      }
      if (own !== generation.current) {
        setError('처리 결과를 다시 확인하세요. 같은 요청 다시 확인으로 이어갈 수 있습니다.');
        return;
      }
      release();
      clearDraft();
      setMessage(value.kind === 'create' ? '제재를 등록했습니다.' : '제재를 해제했습니다.');
      onRead(value.userId);
    } catch (failure) {
      if (!mounted.current) return;
      const code = publicFailure(failure)?.code;
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') denyIdentity();
      else if (code && ['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'PRECONDITION_FAILED'].includes(code)) {
        release();
        clearDraft();
        onClear();
        setError('대상과 제재를 다시 조회한 뒤 내용을 확인하세요.');
      } else {
        const wait = retryAfterSeconds(failure);
        if (code === 'TOO_MANY_REQUESTS' && wait !== null) setRetryAt(Date.now() + wait * 1000);
        setError(
          code === 'TOO_MANY_REQUESTS'
            ? '요청이 많습니다. 잠시 뒤 같은 요청 다시 확인을 눌러 주세요.'
            : '처리 결과를 확인하지 못했습니다. 같은 요청 다시 확인을 눌러 주세요.',
        );
      }
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || command || busy.current) return;
    const trimmed = reason.trim();
    if (!confirmed || !trimmed || trimmed.length > 200) {
      setError('대상·범위와 사유를 확인하고 확인란을 선택하세요.');
      return;
    }
    let value: Command;
    if (selected) {
      const row = target.sanctions.find((item) => item.sanctionId === selected);
      if (!row || row.liftedAt) {
        setError('해제할 제재를 다시 확인하세요.');
        return;
      }
      value = {
        kind: 'lift',
        userId: target.userId,
        input: { sanctionId: selected, reason: trimmed, expectedUserId: viewerId },
      };
    } else {
      if (target.role !== 'USER' || target.status !== 'ACTIVE' || target.userId === viewerId) {
        setError('새 제재를 등록할 활성 사용자 계정을 확인하세요.');
        return;
      }
      const id = worldId.trim();
      if (scope === 'WORLD' && !uuid.test(id)) {
        setError('월드 UUID를 확인하세요.');
        return;
      }
      const expiry = indefinite ? null : parseSanctionExpiry(expires, Date.now());
      if (expiry && !expiry.ok) {
        setError(expiry.message);
        return;
      }
      value = {
        kind: 'create',
        userId: target.userId,
        input: {
          userId: target.userId,
          worldId: scope === 'GLOBAL' ? null : id,
          reason: trimmed,
          expiresAt: expiry?.ok ? expiry.iso : null,
          expectedUserId: viewerId,
          idempotencyKey: crypto.randomUUID(),
        },
      };
    }
    setCommand(value);
    onLockChange(true);
    void send(value);
  }
  const locked = command !== null || sending;
  const preview = indefinite ? null : parseSanctionExpiry(expires, Date.now());
  return (
    <section className={styles.sanctionActions} aria-label="제재 조치">
      <h3>제재 조치</h3>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {command ? (
        <div>
          <p>결과 확인 중인 대상 {command.userId}</p>
          <p>
            {command.kind === 'create' ? '제재 등록' : '제재 해제'} · 사유 {command.input.reason}
          </p>
          {remaining > 0 ? <p role="status">다시 확인까지 {remaining}초</p> : null}
          <button type="button" disabled={sending || remaining > 0} onClick={() => void send(command)}>
            같은 요청 다시 확인
          </button>
        </div>
      ) : null}
      {!target ? (
        <p>사용자 상세를 먼저 조회하세요.</p>
      ) : (
        <>
          <p>대상 {target.userId}</p>
          <form className={styles.noticeForm} noValidate onSubmit={submit}>
            <label>
              조치
              <select
                aria-label="조치"
                value={selected ?? ''}
                disabled={locked}
                onChange={(event) => {
                  setSelected(event.target.value || null);
                  setConfirmed(false);
                  setReason('');
                }}
              >
                <option value="">새 제재 등록</option>
                {target.sanctions
                  .filter((row) => !row.liftedAt)
                  .map((row) => (
                    <option key={row.sanctionId} value={row.sanctionId}>
                      제재 해제 {row.sanctionId} · {row.worldName ?? row.worldId ?? '계정 전체'}
                    </option>
                  ))}
              </select>
            </label>
            {!selected ? (
              <>
                <label>
                  범위
                  <select
                    aria-label="범위"
                    value={scope}
                    disabled={locked}
                    onChange={(event) => {
                      setScope(event.target.value as 'GLOBAL' | 'WORLD');
                      setConfirmed(false);
                    }}
                  >
                    <option value="GLOBAL">계정 전체</option>
                    <option value="WORLD">지정 월드</option>
                  </select>
                </label>
                {scope === 'WORLD' ? (
                  <label>
                    월드 UUID
                    <input
                      value={worldId}
                      disabled={locked}
                      maxLength={36}
                      autoComplete="off"
                      onChange={(event) => {
                        setWorldId(event.target.value);
                        setConfirmed(false);
                      }}
                    />
                  </label>
                ) : null}
                <p>
                  {scope === 'GLOBAL'
                    ? '모든 세션을 닫고 새 로그인을 막습니다.'
                    : '지정한 월드의 게임 변경만 막고 다른 월드와 기존 예약은 유지합니다.'}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={indefinite}
                    disabled={locked}
                    onChange={(event) => {
                      setIndefinite(event.target.checked);
                      setConfirmed(false);
                    }}
                  />
                  무기한
                </label>
                {!indefinite ? (
                  <label>
                    만료 시각 (한국)
                    <input
                      type="datetime-local"
                      step={60}
                      value={expires}
                      disabled={locked}
                      onChange={(event) => {
                        setExpires(event.target.value);
                        setConfirmed(false);
                      }}
                    />
                  </label>
                ) : null}
                {preview?.ok ? <p>만료 {time.format(new Date(preview.iso))} (한국 시각)</p> : null}
              </>
            ) : (
              <p>제재 UUID {selected}의 해제를 확인하세요. 원본 이력은 보존합니다.</p>
            )}
            <label>
              사유 (1~200자)
              <textarea
                aria-label="사유 (1~200자)"
                value={reason}
                disabled={locked}
                maxLength={200}
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
                disabled={locked}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              대상·범위·사유와 조치를 확인했습니다.
            </label>
            <button
              type="submit"
              disabled={
                locked ||
                !confirmed ||
                (!selected && (target.role !== 'USER' || target.status !== 'ACTIVE' || target.userId === viewerId))
              }
            >
              {selected ? '제재 해제 확정' : '제재 등록 확정'}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
