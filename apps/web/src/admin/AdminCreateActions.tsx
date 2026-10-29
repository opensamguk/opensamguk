import { useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useTRPCClient } from '../trpc';
import { publicFailure, retryAfterSeconds } from '../auth/credentials';
import { ErrorState, LoadingState } from '../ui/States';
import {
  createDraft,
  CreateDraftError,
  createFailurePhase,
  createPointer,
  createRejections,
  freezeCreation,
  ownCreateReply,
  reviewCreation,
  type CreateCommand,
  type CreateDraft,
  type CreateOptions,
  type CreatePointer,
  type CreateReply,
  type CreateReview,
} from './adminCreateModel';
import styles from './AdminCreateActions.module.css';

type Phase = 'idle' | 'unknown' | 'pending' | 'limited' | 'notAccepted' | 'done' | 'failed';
export function AdminCreateActions({
  viewerId,
  disabled,
  onAcquire,
  onRelease,
  onClear,
}: {
  viewerId: string;
  disabled: boolean;
  onAcquire: () => boolean;
  onRelease: () => void;
  onClear: () => void;
}) {
  const client = useTRPCClient(),
    router = useRouter();
  const [expanded, setExpanded] = useState(false),
    [fresh, setFresh] = useState(false),
    [options, setOptions] = useState<CreateOptions | null>(null),
    [draft, setDraft] = useState<CreateDraft>(createDraft),
    [review, setReview] = useState<CreateReview | null>(null),
    [open, setOpen] = useState(false),
    [checked, setChecked] = useState(false),
    [command, setCommand] = useState<CreateCommand | null>(null),
    [pointer, setPointer] = useState<CreatePointer | null>(null),
    [reply, setReply] = useState<CreateReply | null>(null),
    [phase, setPhase] = useState<Phase>('idle'),
    [sending, setSending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [storageWarning, setStorageWarning] = useState(false),
    [recoveryBlocked, setRecoveryBlocked] = useState(false),
    [invalidField, setInvalidField] = useState<CreateDraftError['field'] | null>(null),
    [retryAt, setRetryAt] = useState<number | null>(null),
    [now, setNow] = useState(Date.now);
  const mounted = useRef(true),
    generation = useRef(0),
    busy = useRef(false),
    active = useRef<AbortController | null>(null),
    pointerRef = useRef<CreatePointer | null>(null),
    commandRef = useRef<CreateCommand | null>(null),
    writeCount = useRef(0),
    autoSeed = useRef(''),
    pointerLoaded = useRef(false),
    restoreFocus = useRef(false),
    dialog = useRef<HTMLDialogElement>(null),
    form = useRef<HTMLFormElement>(null),
    opener = useRef<HTMLButtonElement>(null),
    reviewButton = useRef<HTMLButtonElement>(null);
  const profile = options?.profiles[0],
    available = profile?.available ? profile : null,
    preset = available?.presets.find((entry) => entry.key === draft.presetKey),
    unresolved = pointer !== null && !['done', 'failed', 'notAccepted'].includes(phase),
    remaining = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000)),
    storageKey = `opensamguk:admin-create:v1:${viewerId}`;
  useLayoutEffect(() => {
    if (open && fresh && dialog.current && !dialog.current.open) dialog.current.showModal();
    if ((!open || !fresh) && dialog.current?.open) dialog.current.close();
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      (expanded ? reviewButton.current : opener.current)?.focus();
    }
  }, [open, fresh, expanded]);
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current++;
      active.current?.abort();
      setFresh(false);
      setOptions(null);
      setReview(null);
      setChecked(false);
      setOpen(false);
      setReply(null);
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
    if (retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  useBlocker({
    disabled: !sending && !unresolved,
    enableBeforeUnload: sending || unresolved,
    shouldBlockFn: ({ next }) => {
      if (['/login', '/verify-email', '/legal/agree'].includes(next.pathname)) return false;
      setError('생성 요청 결과를 먼저 확인하세요.');
      return true;
    },
  });

  function current(own: number, signal: AbortSignal) {
    return mounted.current && generation.current === own && !signal.aborted;
  }
  function denied() {
    setFresh(false);
    setExpanded(false);
    setOpen(false);
    setOptions(null);
    setReview(null);
    setReply(null);
    setDraft(createDraft());
    setCommand(null);
    commandRef.current = null;
    setPointer(null);
    pointerRef.current = null;
    pointerLoaded.current = false;
    autoSeed.current = '';
    writeCount.current = 0;
    setChecked(false);
    setInvalidField(null);
    onClear();
    onRelease();
    setError('계정과 관리자 권한을 다시 확인하세요. 이미 접수한 생성 요청은 철회되지 않습니다.');
    void router.invalidate();
  }
  async function identify(signal: AbortSignal, own: number) {
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
  async function settings(signal: AbortSignal, own: number) {
    const [identity, , value] = await Promise.all([
      client.auth.me.query(undefined, { signal }),
      client.admin.whoami.query(undefined, { signal }),
      client.admin.world.creationOptions.query({ expectedUserId: viewerId }, { signal }),
    ]);
    if (!current(own, signal)) return null;
    if (identity.user?.id !== viewerId || value.userId !== viewerId) {
      denied();
      return null;
    }
    setOptions(value);
    setFresh(true);
    return value;
  }
  function keepPointer(value: CreatePointer | null) {
    pointerRef.current = value;
    setPointer(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      setStorageWarning(true);
    }
  }
  function loadPointer() {
    if (pointerLoaded.current) return;
    let raw: string | null;
    try {
      raw = sessionStorage.getItem(storageKey);
    } catch {
      setStorageWarning(true);
      setRecoveryBlocked(true);
      throw new Error('이 탭의 이전 요청 정보를 확인하지 못했습니다.');
    }
    if (raw !== null) {
      let value: CreatePointer | null = null;
      try {
        value = createPointer(JSON.parse(raw), viewerId);
      } catch {
        /* 원문을 노출하지 않는다. */
      }
      if (!value) {
        setRecoveryBlocked(true);
        throw new Error('보관한 요청 정보를 확인하지 못했습니다.');
      }
      pointerRef.current = value;
      setPointer(value);
      setPhase('unknown');
    }
    pointerLoaded.current = true;
    setRecoveryBlocked(false);
  }
  async function operation(work: (signal: AbortSignal, own: number) => Promise<void>) {
    if (busy.current || disabled || (retryAt !== null && Date.now() < retryAt)) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const controller = new AbortController(),
      own = generation.current;
    active.current = controller;
    let stop: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      stop = () => reject(new Error('생성 요청 확인 기한을 넘겼습니다.'));
      controller.signal.addEventListener('abort', stop, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      await Promise.race([work(controller.signal, own), deadline]);
    } catch (failure) {
      if (mounted.current && own === generation.current) {
        if (['UNAUTHORIZED', 'FORBIDDEN'].includes(publicFailure(failure)?.code ?? '')) denied();
        else
          setError(
            pointerRef.current
              ? '결과를 확인하지 못했습니다. 같은 요청의 상태를 직접 확인하세요.'
              : '생성 설정을 확인하지 못했습니다. 다시 조회하세요.',
          );
      }
    } finally {
      clearTimeout(timer);
      if (stop) controller.signal.removeEventListener('abort', stop);
      if (active.current === controller) active.current = null;
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }
  function begin() {
    if (busy.current || disabled || !onAcquire()) return;
    setExpanded(true);
    void operation(async (signal, own) => {
      const value = await settings(signal, own);
      if (!value) return;
      loadPointer();
    });
  }
  function change(patch: Partial<CreateDraft>) {
    if (busy.current || pointerRef.current || recoveryBlocked || !pointerLoaded.current) return;
    setDraft((old) => ({ ...old, ...patch }));
    setReview(null);
    setChecked(false);
    setError(null);
    setInvalidField(null);
  }
  function makeReview(value: CreateOptions) {
    if (!autoSeed.current)
      autoSeed.current = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    return reviewCreation(value, draft, viewerId, autoSeed.current);
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy.current || pointerRef.current || recoveryBlocked || !pointerLoaded.current) return;
    void operation(async (signal, own) => {
      const value = await settings(signal, own);
      if (!value) return;
      try {
        setReview(makeReview(value));
        setChecked(false);
        setOpen(true);
      } catch (failure) {
        setError(failure instanceof CreateDraftError ? failure.message : '현재 계정과 생성 설정을 확인하세요.');
        if (failure instanceof CreateDraftError) {
          setInvalidField(failure.field);
          const target = form.current?.elements.namedItem(failure.field);
          if (target instanceof HTMLElement) target.focus();
        }
      }
    });
  }
  function cancelReview() {
    if (busy.current) return;
    restoreFocus.current = true;
    setOpen(false);
    setChecked(false);
  }
  async function receive(result: CreateReply, signal: AbortSignal, own: number) {
    if (!(await identify(signal, own))) return;
    const expected = pointerRef.current;
    if (!expected || !ownCreateReply(result, expected)) {
      setError('요청 응답이 다릅니다. 관리자 기록을 확인하세요.');
      return;
    }
    setReply(result);
    if (result.status === 'DONE' || result.status === 'FAILED') {
      setPhase(result.status === 'DONE' ? 'done' : 'failed');
      keepPointer(null);
    } else {
      setPhase('pending');
      keepPointer({ ...expected, requestId: result.requestId });
    }
  }
  async function write(value: CreateCommand, signal: AbortSignal, own: number) {
    if (!(await identify(signal, own))) return;
    const firstWrite = writeCount.current++ === 0;
    setPhase('unknown');
    try {
      await receive(await client.admin.world.create.mutate(value.input, { signal }), signal, own);
    } catch (failure) {
      if (!current(own, signal)) return;
      const code = publicFailure(failure)?.code,
        next = createFailurePhase(code, firstWrite);
      if (next === 'denied') {
        denied();
        return;
      }
      setPhase(next);
      const seconds = retryAfterSeconds(failure);
      if (next === 'limited' && seconds !== null) setRetryAt(Date.now() + seconds * 1000);
      if (next === 'notAccepted') keepPointer(null);
      setError(
        next === 'notAccepted'
          ? '입력을 접수하지 못했습니다. 설정을 확인해 새 요청을 작성하세요.'
          : next === 'limited'
            ? '요청이 많습니다. 잠시 뒤 같은 요청을 직접 확인하세요.'
            : '접수 여부를 확인하지 못했습니다. 같은 요청의 상태를 직접 확인하세요.',
      );
    }
  }
  function submit() {
    if (!checked || !review || busy.current || pointerRef.current || recoveryBlocked || !pointerLoaded.current) return;
    const reviewed = review;
    void operation(async (signal, own) => {
      const value = await settings(signal, own);
      if (!value) return;
      if (value.revision !== reviewed.revision) {
        setChecked(false);
        try {
          setReview(makeReview(value));
        } catch {
          setReview(null);
          setOpen(false);
        }
        setError('생성 설정이 바뀌었습니다. 현재 내용을 다시 확인하세요.');
        return;
      }
      const frozen = freezeCreation(reviewed, crypto.randomUUID());
      commandRef.current = frozen;
      setCommand(frozen);
      keepPointer({ version: 1, viewerId, idempotencyKey: frozen.input.idempotencyKey });
      setPhase('unknown');
      setOpen(false);
      setChecked(false);
      setReply(null);
      await write(frozen, signal, own);
    });
  }
  function read() {
    const expected = pointerRef.current;
    if (!expected) return;
    void operation(async (signal, own) => {
      if (!(await identify(signal, own))) return;
      const result = await client.admin.world.createStatus.query(
        { expectedUserId: viewerId, idempotencyKey: expected.idempotencyKey },
        { signal },
      );
      await receive(result, signal, own);
    });
  }
  function resend() {
    const value = commandRef.current;
    if (!value || !pointerRef.current) return;
    void operation((signal, own) => write(value, signal, own));
  }
  function reset() {
    if (busy.current || pointerRef.current) return;
    setCommand(null);
    commandRef.current = null;
    setReply(null);
    setReview(null);
    setOptions(null);
    setOpen(false);
    setChecked(false);
    setDraft(createDraft());
    setPhase('idle');
    setInvalidField(null);
    setFresh(false);
    setExpanded(false);
    setError(null);
    setRetryAt(null);
    autoSeed.current = '';
    writeCount.current = 0;
    restoreFocus.current = true;
    onClear();
    onRelease();
  }
  const shownInput = command?.input ?? review?.input;
  return (
    <section className={styles.create} aria-label="새 월드 생성">
      <h3>새 월드 생성</h3>
      <p>개장 전 월드를 새로 만듭니다. 생성 뒤 월드 목록에서 별도로 시작합니다.</p>
      {!expanded ? (
        <button ref={opener} type="button" disabled={disabled || sending} onClick={begin}>
          새 월드 생성 준비
        </button>
      ) : (
        <>
          {!fresh ? (
            <button type="button" disabled={sending || disabled} onClick={begin}>
              계정과 생성 설정 다시 확인
            </button>
          ) : null}
          {fresh && pointer ? (
            <div className={styles.result}>
              <p role="status">{phase === 'pending' ? '접수됨 · 생성 대기' : '이전 생성 요청의 결과를 확인하세요.'}</p>
              <p>
                요청 번호 <code>{pointer.idempotencyKey}</code>
              </p>
              {command ? (
                <p>
                  이름 {command.input.name} · 턴 {command.input.turnTermMinutes}분
                </p>
              ) : (
                <p>
                  이 탭에는 원래 입력이 없습니다. 상태 조회만 할 수 있습니다. 접수 기록이 없더라도 새 요청으로 바꾸지
                  않습니다.
                </p>
              )}
              <button type="button" disabled={sending || remaining > 0} onClick={read}>
                요청 상태 확인
              </button>{' '}
              {command ? (
                <button type="button" disabled={sending || remaining > 0} onClick={resend}>
                  같은 요청 접수 확인
                </button>
              ) : null}
              {command ? <p>같은 이름·설정·시드·요청 번호로 접수 여부를 확인합니다.</p> : null}
            </div>
          ) : null}
          {fresh && reply?.status === 'DONE' ? (
            <div role="status">
              <p>생성 완료 · 개장 전</p>
              <p>
                월드 UUID <code>{reply.worldId}</code>
              </p>
            </div>
          ) : null}
          {fresh && reply?.status === 'FAILED' && reply.error ? (
            <p role="status">생성하지 않음 · {createRejections[reply.error.code as keyof typeof createRejections]}</p>
          ) : null}
          {recoveryBlocked ? (
            <ErrorState title="보관한 요청 정보를 읽지 못했습니다. 관리자 기록에서 접수 여부를 먼저 확인하세요." />
          ) : null}
          {fresh && !pointer && !recoveryBlocked && !['done', 'failed', 'notAccepted'].includes(phase) ? (
            <>
              {profile && !profile.available ? <ErrorState title={profile.reason} onRetry={begin} /> : null}
              {available ? (
                <form ref={form} className={styles.form} onSubmit={prepare}>
                  <label>
                    월드 이름
                    <input
                      value={draft.name}
                      name="name"
                      aria-invalid={invalidField === 'name' || undefined}
                      aria-describedby={invalidField === 'name' ? 'create-form-error' : undefined}
                      disabled={sending}
                      required
                      onChange={(e) => change({ name: e.target.value })}
                    />
                  </label>
                  <label>
                    시나리오
                    <select aria-label="시나리오" defaultValue={available.id} disabled={sending}>
                      <option value={available.id}>{available.label}</option>
                    </select>
                  </label>
                  <p>
                    {available.startYear}년 · {available.counts.nations}국 · NPC {available.counts.generals}명 · 도시{' '}
                    {available.counts.cities} · 관문 {available.counts.gates}
                    <br />
                    5능력치 · 휘하·부곡 · 도시 자원 규칙을 포함합니다.
                  </p>
                  <label>
                    프리셋
                    <select
                      aria-label="프리셋"
                      value={draft.presetKey}
                      name="presetKey"
                      aria-invalid={invalidField === 'presetKey' || undefined}
                      aria-describedby={invalidField === 'presetKey' ? 'create-form-error' : undefined}
                      disabled={sending}
                      required
                      onChange={(e) => {
                        const selected = available.presets.find((item) => item.key === e.target.value);
                        change({
                          presetKey: e.target.value,
                          turnTerm: selected ? String(selected.turnTermMinutes) : '',
                          endYear: draft.endYear || String(available.suggestedEndYear),
                        });
                      }}
                    >
                      <option value="">프리셋을 선택하세요</option>
                      {available.presets.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label} · 기본 {item.turnTermMinutes}분
                        </option>
                      ))}
                    </select>
                  </label>
                  {preset ? (
                    <ul>
                      {preset.descriptions.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                  ) : null}
                  <label>
                    턴 간격 (분)
                    <input
                      type="number"
                      min={1}
                      max={2147483647}
                      step={1}
                      value={draft.turnTerm}
                      name="turnTerm"
                      aria-invalid={invalidField === 'turnTerm' || undefined}
                      aria-describedby={invalidField === 'turnTerm' ? 'create-form-error' : undefined}
                      disabled={sending}
                      required
                      onChange={(e) => change({ turnTerm: e.target.value })}
                    />
                  </label>
                  <p>프리셋을 바꾸면 턴 간격을 해당 기본값으로 다시 넣습니다.</p>
                  <label>
                    자동 종료
                    <select
                      aria-label="자동 종료"
                      value={draft.endMode}
                      disabled={sending}
                      onChange={(e) => change({ endMode: e.target.value === 'none' ? 'none' : 'year' })}
                    >
                      <option value="year">종료 연도 지정</option>
                      <option value="none">종료 연도 지정 안 함</option>
                    </select>
                  </label>
                  {draft.endMode === 'year' ? (
                    <label>
                      종료 연도
                      <input
                        type="number"
                        min={available.startYear}
                        max={10000}
                        step={1}
                        value={draft.endYear}
                        name="endYear"
                        aria-invalid={invalidField === 'endYear' || undefined}
                        aria-describedby={invalidField === 'endYear' ? 'create-form-error' : undefined}
                        disabled={sending}
                        required
                        onChange={(e) => change({ endYear: e.target.value })}
                      />
                    </label>
                  ) : null}
                  <label>
                    시드 선택
                    <select
                      aria-label="시드 선택"
                      value={draft.seedMode}
                      disabled={sending}
                      onChange={(e) => change({ seedMode: e.target.value === 'custom' ? 'custom' : 'auto' })}
                    >
                      <option value="auto">자동 생성</option>
                      <option value="custom">직접 지정</option>
                    </select>
                  </label>
                  {draft.seedMode === 'custom' ? (
                    <label>
                      시드
                      <input
                        aria-label="시드"
                        value={draft.seed}
                        name="seed"
                        aria-invalid={invalidField === 'seed' || undefined}
                        aria-describedby={
                          invalidField === 'seed' ? 'create-seed-help create-form-error' : 'create-seed-help'
                        }
                        disabled={sending}
                        required
                        onChange={(e) => change({ seed: e.target.value })}
                      />
                      <small id="create-seed-help">
                        재현할 게임의 시드입니다. 비밀번호나 인증 키를 입력하지 마세요.
                      </small>
                    </label>
                  ) : null}
                  <button ref={reviewButton} type="submit" disabled={sending}>
                    현재 설정 검토
                  </button>
                </form>
              ) : null}
            </>
          ) : null}
          {!pointer ? (
            <button type="button" disabled={sending} onClick={reset}>
              {['done', 'failed', 'notAccepted'].includes(phase) ? '확인 마치기' : '생성 준비 닫기'}
            </button>
          ) : null}
        </>
      )}
      <dialog
        ref={dialog}
        aria-labelledby="create-confirm-title"
        className={styles.dialog}
        onCancel={(event) => {
          event.preventDefault();
          cancelReview();
        }}
      >
        <h3 id="create-confirm-title">개장 전 월드 생성 확인</h3>
        {review && shownInput ? (
          <>
            <dl>
              <dt>이름</dt>
              <dd>{shownInput.name}</dd>
              <dt>시나리오</dt>
              <dd>{review.scenarioTitle}</dd>
              <dt>프리셋</dt>
              <dd>{review.presetLabel}</dd>
              <dt>턴 간격</dt>
              <dd>{shownInput.turnTermMinutes}분</dd>
              <dt>자동 종료</dt>
              <dd>{shownInput.endYear === null ? '종료 연도 지정 안 함' : `${shownInput.endYear}년`}</dd>
              <dt>시드 ({review.seedMode === 'auto' ? '자동 생성' : '직접 지정'})</dt>
              <dd>
                <code>{shownInput.seed}</code>
              </dd>
            </dl>
            <p>
              191년 · 21국 · NPC 491명 · 도시53 · 관문8 · 9개 기능. 현재 조회한 프리셋과 게시 자원을 사용하며 최종
              설정은 생성 처리 때 확정됩니다.
            </p>
            {preset ? (
              <ul>
                {preset.descriptions.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            ) : null}
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={checked}
                disabled={sending}
                onChange={(e) => setChecked(e.target.checked)}
              />
              이름·현재 설정·시드와 개장 전 생성을 확인했습니다.
            </label>
            <button type="button" disabled={!checked || sending} onClick={submit}>
              개장 전 월드 생성 요청
            </button>{' '}
            <button type="button" disabled={sending} onClick={cancelReview}>
              돌아가서 수정
            </button>
          </>
        ) : null}
        {open && error ? <ErrorState title={error} /> : null}
      </dialog>
      {sending ? <LoadingState>계정·생성 설정과 요청을 확인하고 있습니다.</LoadingState> : null}
      {remaining > 0 ? <p role="status">{remaining}초 뒤 같은 요청을 직접 확인할 수 있습니다.</p> : null}
      {storageWarning ? (
        <p role="alert">이 탭의 복구 정보를 보관하지 못했습니다. 탭을 닫기 전에 요청 번호와 결과를 확인하세요.</p>
      ) : null}
      {!open && error ? (
        <div id="create-form-error">
          <ErrorState title={error} />
        </div>
      ) : null}
    </section>
  );
}
