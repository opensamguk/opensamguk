import { useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { publicFailure, retryAfterSeconds } from '../auth/credentials';
import { useTRPCClient } from '../trpc';
import {
  canEnd,
  endConfirmation,
  endRejections,
  endWorldStamp,
  ownEndReply,
  type EndCommand,
  type EndReply,
  type EndWorld,
} from './adminEndModel';
import styles from './AdminPages.module.css';

const states = { PREOPEN: '개장 전', RUNNING: '진행 중', PAUSED: '일시정지', ENDED: '종료' } as const;
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium' });
type Phase = 'idle' | 'unknown' | 'pending' | 'limited' | 'notAccepted' | 'terminal';

export function AdminEndActions({
  viewerId,
  worlds,
  disabled,
  onAcquire,
  onRelease,
  onClear,
}: {
  viewerId: string;
  worlds: EndWorld[] | null;
  disabled: boolean;
  onAcquire: () => boolean;
  onRelease: () => void;
  onClear: () => void;
}) {
  const client = useTRPCClient(),
    router = useRouter();
  const [worldId, setWorldId] = useState(''),
    [refreshed, setRefreshed] = useState<EndWorld | null>(null),
    [name, setName] = useState(''),
    [reason, setReason] = useState(''),
    [checked, setChecked] = useState(false),
    [open, setOpen] = useState(false),
    [fresh, setFresh] = useState(true),
    [sending, setSending] = useState(false),
    [command, setCommand] = useState<EndCommand | null>(null),
    [reply, setReply] = useState<EndReply | null>(null),
    [phase, setPhase] = useState<Phase>('idle'),
    [error, setError] = useState<string | null>(null),
    [retryAt, setRetryAt] = useState<number | null>(null),
    [now, setNow] = useState(Date.now);
  const generation = useRef(0),
    mounted = useRef(true),
    busy = useRef(false),
    active = useRef<AbortController | null>(null),
    dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLButtonElement>(null),
    selector = useRef<HTMLSelectElement>(null),
    restoreFocus = useRef(false);
  const listed = worlds?.find((item) => item.id === worldId),
    world = refreshed ?? listed,
    stamp = world ? endWorldStamp(world) : null,
    unresolved = command !== null && ['unknown', 'pending'].includes(phase),
    blocked = sending || unresolved,
    remaining = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  useLayoutEffect(() => {
    setName('');
    setChecked(false);
  }, [stamp, viewerId]);
  useLayoutEffect(() => {
    if (dialog.current && open && fresh && !dialog.current.open) dialog.current.showModal();
    if (dialog.current?.open && (!open || !fresh)) dialog.current.close();
    if (!open && fresh && restoreFocus.current) {
      restoreFocus.current = false;
      if (opener.current && !opener.current.disabled) opener.current.focus();
      else selector.current?.focus();
    }
  }, [open, fresh]);
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current++;
      active.current?.abort();
      setFresh(false);
      setReply(null);
      setRefreshed(null);
      setWorldId('');
      setName('');
      setReason('');
      setChecked(false);
      setError(null);
      setOpen(false);
    };
    for (const event of ['focus', 'blur', 'online', 'offline']) window.addEventListener(event, invalidate);
    document.addEventListener('visibilitychange', invalidate);
    return () => {
      mounted.current = false;
      generation.current++;
      active.current?.abort();
      for (const event of ['focus', 'blur', 'online', 'offline']) window.removeEventListener(event, invalidate);
      document.removeEventListener('visibilitychange', invalidate);
    };
  }, [viewerId]);
  useEffect(() => {
    if (!open && !sending && !unresolved) onRelease();
  }, [open, sending, unresolved, onRelease]);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  useBlocker({
    disabled: !blocked,
    enableBeforeUnload: blocked,
    shouldBlockFn: ({ next }) => {
      if (['/login', '/verify-email', '/legal/agree'].includes(next.pathname)) return false;
      setError('종료 요청 결과를 먼저 확인하세요.');
      return true;
    },
  });

  function clearDraft() {
    setName('');
    setReason('');
    setChecked(false);
    setWorldId('');
    setRefreshed(null);
  }
  function denied() {
    setFresh(false);
    setReply(null);
    clearDraft();
    setOpen(false);
    onClear();
    setError('현재 계정과 관리자 권한을 다시 확인하세요. 접수한 종료 요청은 철회되지 않습니다.');
    void router.invalidate();
  }
  function close() {
    if (busy.current || unresolved) return;
    restoreFocus.current = true;
    setOpen(false);
    setCommand(null);
    setReply(null);
    setPhase('idle');
    setRetryAt(null);
    setError(null);
    clearDraft();
    onClear();
    onRelease();
  }
  // 각 read/write/body를 같은 신호와 전체30초 기한에 묶는다. abort는 이미 접수된 입력의 취소가 아니다.
  async function operation(work: (signal: AbortSignal, own: number) => Promise<void>) {
    if (busy.current || disabled) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const controller = new AbortController(),
      own = generation.current;
    active.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      const stop = () => reject(new Error('종료 요청 확인이 중단됐습니다.'));
      controller.signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => controller.abort(), 30_000);
    });
    try {
      await Promise.race([work(controller.signal, own), deadline]);
    } catch {
      if (mounted.current && generation.current === own)
        setError('확인 기한을 넘겼습니다. 접수 여부가 불명확하면 같은 요청의 결과만 조회하세요.');
    } finally {
      clearTimeout(timer);
      if (active.current === controller) active.current = null;
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }
  function current(own: number, signal: AbortSignal) {
    return mounted.current && generation.current === own && !signal.aborted;
  }
  async function identify(signal: AbortSignal, own: number) {
    const before = await client.auth.me.query(undefined, { signal });
    if (!current(own, signal)) return false;
    if (before.user?.id !== viewerId) {
      denied();
      return false;
    }
    // 이 둘은 같은 HTTP batch에서 현재 쿠키의 계정과 권한을 확인한다.
    const [identity] = await Promise.all([
      client.auth.me.query(undefined, { signal }),
      client.admin.whoami.query(undefined, { signal }),
    ]);
    if (!current(own, signal)) return false;
    if (identity.user?.id !== viewerId) {
      denied();
      return false;
    }
    return true;
  }
  async function freshBoard(signal: AbortSignal, own: number) {
    if (!(await identify(signal, own))) return null;
    const [identity, , values] = await Promise.all([
      client.auth.me.query(undefined, { signal }),
      client.admin.whoami.query(undefined, { signal }),
      client.admin.world.list.query(undefined, { signal }),
    ]);
    if (!current(own, signal)) return null;
    if (identity.user?.id !== viewerId) {
      denied();
      return null;
    }
    return values;
  }
  async function openDialog() {
    if (!world || !canEnd(world) || !onAcquire()) return;
    const selected = world.id;
    await operation(async (signal, own) => {
      try {
        const values = await freshBoard(signal, own);
        if (!values) return;
        const latest = values.find((item) => item.id === selected);
        const last = await client.auth.me.query(undefined, { signal });
        if (!current(own, signal)) return;
        if (last.user?.id !== viewerId) {
          denied();
          return;
        }
        if (!latest || !canEnd(latest)) {
          setRefreshed(latest ?? null);
          setName('');
          setChecked(false);
          setError('현재 상태에서는 종료할 수 없습니다. 월드를 다시 조회하세요.');
          return;
        }
        setRefreshed(latest);
        setOpen(true);
      } catch (value) {
        if (current(own, signal)) failure(value, false, false);
      }
    });
  }
  function failure(value: unknown, attempted: boolean, write: boolean) {
    const code = publicFailure(value)?.code;
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      denied();
      return;
    }
    if (write && attempted && code === 'TOO_MANY_REQUESTS') {
      const seconds = retryAfterSeconds(value);
      setPhase('limited');
      setRetryAt(seconds === null ? null : Date.now() + seconds * 1000);
      setError(
        seconds === null
          ? '요청이 많습니다. 결과를 조회하세요. 재접수 대기 시간을 확인하지 못했습니다.'
          : '요청 한도로 접수하지 못했습니다. 남은 시간이 지난 뒤 같은 요청을 수동 접수할 수 있습니다.',
      );
      return;
    }
    if (write && attempted && code && ['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND'].includes(code)) {
      setPhase('notAccepted');
      setError('이 내용으로 접수하지 못했습니다. 닫은 뒤 월드를 다시 조회하고 확인하세요.');
      return;
    }
    setError(
      !attempted
        ? '계정·월드 상태를 확인하지 못해 보내지 않았습니다. 다시 확인하세요.'
        : '결과를 확인하지 못했습니다. 같은 요청 번호로 수동 조회하세요. 조회에 실패해도 미접수를 뜻하지 않습니다.',
    );
  }
  async function recover() {
    await operation(async (signal, own) => {
      try {
        if (!(await identify(signal, own))) return;
        const last = await client.auth.me.query(undefined, { signal });
        if (!current(own, signal)) return;
        if (last.user?.id !== viewerId) {
          denied();
          return;
        }
        setFresh(true);
        if (command && onAcquire()) setOpen(true);
      } catch (value) {
        if (current(own, signal)) failure(value, false, false);
      }
    });
  }
  async function send(value: EndCommand, write: boolean) {
    if (!fresh || (write && phase === 'limited' && (retryAt === null || Date.now() < retryAt))) return;
    await operation(async (signal, own) => {
      let attempted = false;
      try {
        if (write && !command) {
          const values = await freshBoard(signal, own);
          if (!values) return;
          const latest = values.find((item) => item.id === value.input.worldId);
          if (!latest || endWorldStamp(latest) !== endWorldStamp(value.world)) {
            setName('');
            setChecked(false);
            setRefreshed(latest ?? null);
            if (!latest) {
              setWorldId('');
              setOpen(false);
              onClear();
            }
            setError('월드 상태가 달라졌습니다. 새 내용을 확인하고 이름을 다시 입력하세요.');
            return;
          }
        } else if (!(await identify(signal, own))) return;
        const last = await client.auth.me.query(undefined, { signal });
        if (!current(own, signal)) return;
        if (last.user?.id !== viewerId) {
          denied();
          return;
        }
        // 마지막 me 이후 await 없이 기대UUID를 포함한 실제 요청을 만든다.
        attempted = true;
        if (write) {
          setCommand(value);
          setPhase('unknown');
          setReply(null);
          setRetryAt(null);
        }
        const request = write
          ? client.admin.world.requestEnd.mutate(value.input, { signal })
          : client.admin.world.endRequest.query(
              {
                expectedUserId: value.input.expectedUserId,
                worldId: value.input.worldId,
                idempotencyKey: value.input.idempotencyKey,
              },
              { signal },
            );
        const result = await request;
        if (!(await identify(signal, own))) return;
        const after = await client.auth.me.query(undefined, { signal });
        if (!current(own, signal)) return;
        if (after.user?.id !== viewerId) {
          denied();
          return;
        }
        if (!ownEndReply(result, value)) {
          setError('응답의 계정·월드·요청 번호가 다릅니다. 현재 요청의 결과를 다시 조회하세요.');
          return;
        }
        setReply(result);
        setPhase(result.status === 'PENDING' ? 'pending' : 'terminal');
      } catch (value) {
        if (current(own, signal)) failure(value, attempted, write);
      }
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || command || !fresh || !world || !endConfirmation(world, name, reason, checked)) return;
    const value: EndCommand = Object.freeze({
      world: Object.freeze({ ...world }),
      input: Object.freeze({
        expectedUserId: viewerId,
        worldId: world.id,
        idempotencyKey: crypto.randomUUID(),
        confirmName: world.name,
        expectedRevision: world.clockRevision,
        reason: reason.trim(),
      }),
    });
    void send(value, true);
  }
  return (
    <section className={styles.sanctionActions} aria-label="월드 종료 조치">
      <h3>월드 종료</h3>
      {!fresh ? (
        <>
          <p>현재 계정과 관리자 권한을 확인한 뒤 이어가세요. 이미 접수된 종료 요청은 로그아웃해도 철회되지 않습니다.</p>
          <button type="button" disabled={sending || disabled} onClick={() => void recover()}>
            종료 계정과 권한 다시 확인
          </button>
        </>
      ) : (
        <>
          <label htmlFor="end-world">종료할 월드</label>
          <select
            ref={selector}
            id="end-world"
            value={worldId}
            disabled={sending || open || command !== null || disabled}
            onChange={(event) => {
              setWorldId(event.target.value);
              setRefreshed(null);
              setName('');
              setChecked(false);
            }}
          >
            <option value="">먼저 월드를 조회하고 선택하세요</option>
            {worlds?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {states[item.status]} · {item.id}
              </option>
            ))}
          </select>
          {world && !canEnd(world) ? (
            <p>원생성 형식3의 일시정지 월드만 종료할 수 있습니다. 필요한 시계 조치는 따로 확인하세요.</p>
          ) : null}
          <button
            ref={opener}
            type="button"
            disabled={disabled || sending || !canEnd(world) || command !== null}
            onClick={() => void openDialog()}
          >
            월드 종료 확인
          </button>
        </>
      )}
      <dialog
        ref={dialog}
        className={styles.endDialog}
        aria-labelledby="end-heading"
        onCancel={(event) => {
          event.preventDefault();
          if (!blocked) close();
        }}
      >
        <h3 id="end-heading">월드 종료 확인</h3>
        {fresh ? (
          command ? (
            <>
              <p>대상 {command.world.name}</p>
              <p>
                월드 UUID <code>{command.input.worldId}</code>
              </p>
              <p>사유 {command.input.reason}</p>
              <p>
                요청 번호 <code>{command.input.idempotencyKey}</code>
              </p>
              <p>접수한 요청은 취소할 수 없습니다. 승자를 계산하지 않으며 기존 기록은 보존합니다.</p>
              {phase === 'unknown' ? <p role="status">접수 여부 미확정 · 같은 요청의 결과를 수동 조회하세요.</p> : null}
              {reply?.status === 'PENDING' ? <p role="status">접수됨 · 엔진 처리 대기</p> : null}
              {reply?.status === 'APPLIED' && reply.result && 'after' in reply.result ? (
                <div role="status">
                  <p>종료 적용 완료 · 일시정지 → 종료</p>
                  <p>
                    적용 시각 (한국){' '}
                    <time dateTime={reply.result.at} title={reply.result.at}>
                      {time.format(new Date(reply.result.at))}
                    </time>
                  </p>
                  <p>
                    tick {reply.tick} · sequence {reply.sequence} · 시계 revision {reply.result.after.revision}
                  </p>
                  <p>승자 결과를 새로 만들지 않았습니다.</p>
                </div>
              ) : null}
              {reply?.status === 'REJECTED' && reply.result && 'code' in reply.result ? (
                <p role="status">적용하지 않음 · {endRejections[reply.result.code]}</p>
              ) : null}
              {(phase !== 'terminal' && phase !== 'notAccepted') || !reply ? (
                <button type="button" disabled={sending || remaining > 0} onClick={() => void send(command, false)}>
                  종료 요청 결과 조회
                </button>
              ) : null}
              {phase === 'limited' && retryAt !== null ? (
                <button type="button" disabled={sending || remaining > 0} onClick={() => void send(command, true)}>
                  같은 종료 요청 수동 접수
                </button>
              ) : null}
              {!blocked ? (
                <button type="button" disabled={sending} onClick={close}>
                  닫고 새로 조회
                </button>
              ) : null}
            </>
          ) : world ? (
            <form className={styles.noticeForm} onSubmit={submit}>
              <p className={styles.noticeBody}>{world.name}</p>
              <p>
                월드 UUID <code>{world.id}</code>
              </p>
              <p>
                {states[world.status]} · 시계 revision {world.clockRevision} · 사람 장수 {world.humanGenerals}명
              </p>
              <p>종료는 되돌릴 수 없습니다. 승자를 계산하지 않으며 기존 기록은 보존합니다.</p>
              {world.humanGenerals > 0 ? (
                <p>
                  <strong>사람 장수가 있는 운영 월드의 종료에는 소유자 승인이 필요합니다.</strong>
                </p>
              ) : null}
              <p>아래 확인은 소유자의 승인을 대신하거나 승인 기록을 만들지 않습니다. 사유에 개인정보를 적지 마세요.</p>
              <label htmlFor="end-name">현재 월드 이름 그대로 입력</label>
              <input
                id="end-name"
                autoComplete="off"
                value={name}
                disabled={sending}
                onChange={(event) => {
                  setName(event.target.value);
                  setChecked(false);
                }}
              />
              <label htmlFor="end-reason">종료 사유 (1~200자)</label>
              <textarea
                id="end-reason"
                value={reason}
                maxLength={200}
                disabled={sending}
                onChange={(event) => {
                  setReason(event.target.value);
                  setChecked(false);
                }}
              />
              <label htmlFor="end-confirm">
                <input
                  id="end-confirm"
                  type="checkbox"
                  checked={checked}
                  disabled={sending}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                대상·상태·사유와 종료의 영향을 확인했습니다.
              </label>
              <button type="submit" disabled={sending || !endConfirmation(world, name, reason, checked)}>
                월드 종료 요청 확정
              </button>
              <button type="button" disabled={sending} onClick={close}>
                취소
              </button>
            </form>
          ) : null
        ) : null}
        {sending ? <p role="status">현재 계정·권한과 종료 요청을 확인하고 있습니다…</p> : null}
        {remaining > 0 ? <p role="status">{remaining}초 뒤 같은 요청을 수동 접수할 수 있습니다.</p> : null}
        {error && fresh ? <p role="alert">{error}</p> : null}
      </dialog>
      {sending && !open ? <p role="status">현재 계정·권한과 월드를 확인하고 있습니다…</p> : null}
      {!open && error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
