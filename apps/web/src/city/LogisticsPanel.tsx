import { TRPCClientError } from '@trpc/client';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { retryAfterSeconds } from '../auth/credentials';
import { formatYearMonth, personalLogDate } from '../game/gameDate';
import { useWorldMap, useWorldSummary } from '../game/queries';
import {
  forgetLogisticsPending,
  logisticsStorageKey,
  readLogisticsPending,
  refreshFailureClearsView,
  requestModeAllowed,
  writeLogisticsPending,
  type LogisticsPending,
  type LogisticsRequestMode,
} from '../hooks/logisticsRequestState';
import {
  dispatchCheck,
  formatCount,
  GOOD_LABEL,
  LOGISTICS_GOODS,
  lossPercent,
  MOVEMENT_REASON,
  readOnlyReason,
  tradeCheck,
  upgradeCheck,
  type DispatchDraft,
  type LogisticsBoard,
  type LogisticsGood,
  type LogisticsMovement,
  type LogisticsPayload,
  type LogisticsRequestResult,
  type OwnLogisticsBoard,
  type TradeDraft,
} from '../queries/logistics';
import { useTRPCClient } from '../trpc';
import { errorCode, serverMessage } from '../turns/apiError';
import { DataTable, type Column } from '../ui/DataTable';
import { LoadingState } from '../ui/States';
import styles from './logistics.module.css';
import { LogisticsCosts } from './LogisticsCosts';

// 도시 물류 칸 (T4-93, AC-P2-30). 도시 정보에서 금·쌀·수비병 칸 아래에 둔다.
// 재고·한도·경로·손실률·가격은 logistics.get만 쓰고, 처리 결과는 logistics.request로 확인한 뒤 다시 조회한다.
// 요청 흐름은 CityResourcesPanel과 같다: 계정 재확인 → 탭 저장 → 한 번 전송 → 상태 확인. 자동으로 다시 보내지 않는다.

type View = { userId: string; board: LogisticsBoard; pending: LogisticsPending | null };
type Notice = { text: string; tone: 'info' | 'ok' | 'error' } | null;
type Names = (cityKey: number) => string;
type When = (tick: number) => string;
class IdentityChanged extends Error {}

const ACCOUNT_MESSAGE = '계정이 바뀌었습니다. 다시 확인하세요.';
const RECORD_MESSAGE = '요청 기록이 바뀌었습니다. 다시 확인하세요.';
const deniedView = (error: unknown) => refreshFailureClearsView(errorCode(error), error instanceof IdentityChanged);
// 응답을 받지 못한 실패. 같은 계정의 화면·입력은 남기고 값이 오래됐다고 표시한다.
const unreachable = (error: unknown) => errorCode(error) === undefined && !(error instanceof IdentityChanged);
const STALE_NOTICE: Notice = {
  text: '물류를 다시 확인하지 못했습니다. 보이는 값이 오래됐을 수 있어 새 요청을 잠시 막았습니다. 새로 확인을 누르세요.',
  tone: 'error',
};
// 서버가 응답으로 접수를 거절했다. 접수 기록이 생기지 않았으므로 탭의 요청 기록을 지운다.
const admissionRejected = (error: unknown) =>
  error instanceof TRPCClientError &&
  error.meta?.response instanceof Response &&
  [
    'BAD_REQUEST',
    'FORBIDDEN',
    'CONFLICT',
    'PRECONDITION_FAILED',
    'TOO_MANY_REQUESTS',
    'UNAUTHORIZED',
    'NOT_FOUND',
  ].includes(errorCode(error) ?? '');
// 입력만 다시 고치면 되는 거절. 화면과 입력을 그대로 둔다.
const keepForm = (error: unknown) => ['BAD_REQUEST', 'TOO_MANY_REQUESTS'].includes(errorCode(error) ?? '');

export function LogisticsPanel({ worldId, cityKey }: { worldId: string; cityKey: number }) {
  return <LogisticsBoardView key={`${worldId}:${cityKey}`} worldId={worldId} cityKey={cityKey} />;
}

function LogisticsBoardView({ worldId, cityKey }: { worldId: string; cityKey: number }) {
  const api = useTRPCClient();
  const summary = useWorldSummary(worldId);
  const map = useWorldMap(worldId);
  const [view, setView] = useState<View | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  // 상태 확인에서 접수 기록을 아직 찾지 못했다(404). 원래 전송이 잠금을 기다리는 중일 수도 있으므로
  // 기록을 지우거나 새 번호를 만들지 않는다. 같은 번호·내용으로 수동 재접수만 허용한다(서버 멱등).
  const [unconfirmed, setUnconfirmed] = useState(false);
  // 다시 조회하다 연결이 끊겼다. 같은 계정의 화면·입력은 남기고 새 요청만 막는다.
  const [stale, setStale] = useState(false);
  const viewRef = useRef<View | null>(null);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [formEpoch, setFormEpoch] = useState(0);
  const [retryUntil, setRetryUntil] = useState(0),
    [now, setNow] = useState(Date.now);
  const retryDeadline = useRef(0);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    sending = useRef(false);
  const begin = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const stamp = ++generation.current;
    return { stamp, signal: abort.signal, current: () => generation.current === stamp && !abort.signal.aborted };
  }, []);
  const timed = (signal: AbortSignal) => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });

  const snapshot = useCallback(
    async (signal: AbortSignal, expected?: string) => {
      const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
      const before = await api.auth.me.query(undefined, options);
      const userId = before.user?.id;
      if (!userId || (expected && userId !== expected)) throw new IdentityChanged(ACCOUNT_MESSAGE);
      const board = await api.logistics.get.query({ worldId, cityKey }, options);
      const after = await api.auth.me.query(undefined, options);
      if (board.userId !== userId || after.user?.id !== userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
      return { userId, board };
    },
    [api, worldId, cityKey],
  );

  const observe = useCallback(
    async (userId: string, request: LogisticsPending, signal: AbortSignal, valid: () => boolean) => {
      const deadline = Date.now() + 60_000;
      while (valid()) {
        const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
        const me = await api.auth.me.query(undefined, options);
        if (me.user?.id !== userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
        let result: LogisticsRequestResult;
        try {
          result = await api.logistics.request.query({ worldId, requestId: request.requestId }, options);
        } catch (error) {
          if (errorCode(error) !== 'NOT_FOUND') throw error;
          if (valid()) setUnconfirmed(true);
          return;
        }
        const after = await api.auth.me.query(undefined, options);
        if (after.user?.id !== userId || result.userId !== userId || result.requestId !== request.requestId)
          throw new IdentityChanged('계정이나 요청이 바뀌었습니다. 다시 확인하세요.');
        if (!valid()) return;
        setUnconfirmed(false);
        if (result.status !== 'pending') {
          // 최종 영수증(applied/rejected)을 받았을 때만 탭 기록을 끝낸다.
          if (!forgetLogisticsPending(sessionStorage, logisticsStorageKey(userId, worldId), request))
            throw new IdentityChanged(RECORD_MESSAGE);
          const fresh = await snapshot(signal, userId);
          if (!valid()) return;
          setView({ ...fresh, pending: null });
          setStale(false);
          if (result.status === 'applied') {
            setNotice({ text: appliedMessage(result.result), tone: 'ok' });
            setFormEpoch((value) => value + 1);
          } else setNotice({ text: `처리되지 않았습니다. ${result.result.message}`, tone: 'error' });
          return;
        }
        if (Date.now() >= deadline) {
          setNotice({
            text: '아직 처리 중입니다. 자동 확인을 멈췄습니다. 다시 보내지 않고 같은 요청의 상태만 확인할 수 있습니다.',
            tone: 'info',
          });
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1500);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          }
          signal.addEventListener('abort', done, { once: true });
        });
      }
    },
    [api, worldId, snapshot],
  );

  // 보이는 화면이 있으면 지우지 않고 같은 계정인지 확인하며 다시 받는다. 다른 계정이면 지운다.
  // 화면이 없으면(처음·blur 뒤) 지금 계정으로 받는다. view를 의존성에 넣지 않으려고 ref로 읽는다.
  const load = useCallback(async () => {
    if (Date.now() < retryDeadline.current) return;
    const run = begin();
    const expected = viewRef.current?.userId;
    setNotice(null);
    setUnconfirmed(false);
    setBusy(true);
    try {
      const fresh = await snapshot(run.signal, expected);
      const pending = readLogisticsPending(sessionStorage, logisticsStorageKey(fresh.userId, worldId));
      if (!run.current()) return;
      setView({ ...fresh, pending });
      setStale(false);
      if (pending) await observe(fresh.userId, pending, run.signal, run.current);
    } catch (error) {
      if (run.current()) {
        if (deniedView(error)) setView(null);
        else setStale(true);
        setNotice({
          text:
            error instanceof IdentityChanged
              ? error.message
              : (serverMessage(error) ?? '물류를 확인하지 못했습니다. 연결을 확인한 뒤 다시 확인하세요.'),
          tone: 'error',
        });
      }
    } finally {
      if (run.current()) setBusy(false);
    }
  }, [begin, snapshot, worldId, observe]);

  useEffect(() => {
    void load();
    const clear = () => {
      controller.current?.abort();
      ++generation.current;
      setView(null);
      setNotice(null);
      setBusy(false);
      setStale(false);
      setUnconfirmed(false);
    };
    const focus = () => {
      if (!document.hidden) void load();
    };
    const visibility = () => (document.hidden ? clear() : focus());
    window.addEventListener('blur', clear);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.current?.abort();
      ++generation.current;
      window.removeEventListener('blur', clear);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [load]);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= retryUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryUntil]);

  // 재고는 공용 캐시에 넣지 않고 같은 계정·세대에서 새로 읽는다. 입력 중인 폼은 다시 만들지 않는다.
  // 요청을 확인하는 중이거나 월드가 진행 중이 아니면 멈춘다.
  useEffect(() => {
    if (!view || view.pending || busy) return;
    if (view.board.visible && view.board.own && view.board.status !== 'RUNNING') return;
    const timer = setInterval(() => {
      if (sending.current || document.hidden) return;
      const signal = controller.current?.signal,
        stamp = generation.current;
      if (!signal || signal.aborted) return;
      void snapshot(signal, view.userId)
        .then((fresh) => {
          if (generation.current !== stamp || signal.aborted) return;
          // 같은 계정·거점이면 OwnBoard 키가 같아 입력 중인 폼이 그대로 남는다.
          setView({ ...fresh, pending: null });
          setStale(false);
          setNotice((previous) => (previous === STALE_NOTICE ? null : previous));
        })
        .catch((error) => {
          if (generation.current !== stamp || signal.aborted) return;
          if (deniedView(error)) {
            setView(null);
            setNotice({
              text:
                error instanceof IdentityChanged ? error.message : (serverMessage(error) ?? '물류를 볼 수 없습니다.'),
              tone: 'error',
            });
            return;
          }
          setStale(true);
          setNotice(STALE_NOTICE);
        });
    }, 15_000);
    return () => clearInterval(timer);
  }, [view, busy, snapshot]);

  // submit: 새 번호로 새 요청을 보낸다. check: 저장된 요청의 상태만 본다.
  // resubmit: 접수 기록을 찾지 못한 저장 요청을 같은 번호·내용 그대로 다시 보낸다. 기록은 최종 결과에서만 지운다.
  async function act(request: LogisticsPending, mode: LogisticsRequestMode) {
    if (!view || sending.current) return;
    const key = logisticsStorageKey(view.userId, worldId);
    const manage = view.board.visible && view.board.own && view.board.canManage;
    const allowed = requestModeAllowed(mode, {
      request,
      pending: view.pending,
      saved: readLogisticsPending(sessionStorage, key),
      canManage: manage,
      stale,
    });
    if (!allowed || (mode !== 'check' && Date.now() < retryDeadline.current)) return;
    const sends = mode !== 'check';
    sending.current = true;
    const run = begin();
    const current = view;
    setBusy(true);
    setNotice(null);
    let latest: View = current,
      mutationStarted = false,
      mutationReturned = false;
    try {
      const fresh = await snapshot(run.signal, current.userId);
      if (!run.current()) return;
      latest = { ...fresh, pending: current.pending };
      setView(latest);
      setStale(false);
      if (sends) {
        if (!fresh.board.visible || !fresh.board.own || !fresh.board.canManage) {
          setNotice({
            text:
              mode === 'submit'
                ? '지금은 이 거점에 물류를 지시할 수 없습니다. 아래 안내를 확인하세요.'
                : '지금은 이 거점에서 다시 접수할 수 없습니다. 같은 요청의 상태만 확인할 수 있습니다.',
            tone: 'error',
          });
          return;
        }
        const me = await api.auth.me.query(undefined, timed(run.signal));
        if (me.user?.id !== current.userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
        if (!run.current()) return;
        const saved = readLogisticsPending(sessionStorage, key);
        if (mode === 'submit') {
          if (saved) throw new IdentityChanged(RECORD_MESSAGE);
          // 마지막 신원 조회까지 마친 뒤 저장한다. 저장과 전송 사이에는 await를 두지 않는다.
          writeLogisticsPending(sessionStorage, key, request);
          latest = { ...fresh, pending: request };
          setView(latest);
        } else if (
          !requestModeAllowed('resubmit', { request, pending: current.pending, saved, canManage: true, stale: false })
        )
          throw new IdentityChanged(RECORD_MESSAGE);
        setUnconfirmed(false);
        mutationStarted = true;
        const accepted = await api.logistics.submit.mutate(
          { worldId, expectedUserId: current.userId, requestId: request.requestId, payload: request.payload },
          timed(run.signal),
        );
        mutationReturned = true;
        if (accepted.userId !== current.userId || accepted.requestId !== request.requestId)
          throw new IdentityChanged('계정이나 요청이 바뀌었습니다. 다시 확인하세요.');
      }
      await observe(current.userId, request, run.signal, run.current);
    } catch (error) {
      // 처음 보낸 요청이 응답으로 거절됐을 때만 기록을 지운다. 같은 요청 재접수의 거절은 원래 전송이
      // 아직 진행 중일 수 있으므로 기록을 남긴다.
      const unaccepted = mode === 'submit' && mutationStarted && !mutationReturned && admissionRejected(error);
      let cleanupFailed = false;
      if (unaccepted) {
        try {
          forgetLogisticsPending(sessionStorage, key, request);
        } catch {
          cleanupFailed = true;
        }
      }
      if (run.current()) {
        if (unaccepted && keepForm(error)) setView({ ...latest, pending: null });
        else if (deniedView(error) || unaccepted) setView(null);
        else if (unreachable(error)) setStale(true);
        if (errorCode(error) === 'TOO_MANY_REQUESTS') {
          const seconds = retryAfterSeconds(error);
          const at = Date.now();
          retryDeadline.current = seconds === null ? 0 : at + seconds * 1000;
          setNow(at);
          setRetryUntil(retryDeadline.current);
        }
        const lostResponse = sends && mutationStarted && !mutationReturned && !unaccepted && unreachable(error);
        setNotice({
          tone: 'error',
          text: cleanupFailed
            ? '요청 기록을 지우지 못했습니다. 같은 요청의 상태를 다시 확인하세요.'
            : error instanceof IdentityChanged
              ? error.message
              : lostResponse
                ? '응답을 받지 못했습니다. 접수됐을 수 있어 다시 보내지 않습니다. 같은 요청의 상태를 확인하세요.'
                : (serverMessage(error) ??
                  (sends && !mutationStarted
                    ? '요청을 보내지 않았습니다. 계정과 거점을 다시 확인하세요.'
                    : '상태를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.')),
        });
      }
    } finally {
      sending.current = false;
      if (run.current()) setBusy(false);
    }
  }

  const cities = map.data?.cities;
  const names: Names = (key) =>
    (view?.board.visible && view.board.own
      ? view.board.destinations.find((row) => row.cityKey === key)?.name
      : undefined) ??
    cities?.find((city) => city.key === key)?.name ??
    `거점 ${key}`;
  const clock = summary.data;
  const when: When = (tick) => (clock ? formatYearMonth(personalLogDate(tick, clock)) : '—');

  return (
    <section className={styles.panel} aria-label="도시 물류">
      <h3>도시 물류</h3>
      {notice ? (
        <p
          className={notice.tone === 'error' ? styles.error : notice.tone === 'ok' ? styles.ok : styles.info}
          role="status"
        >
          {notice.text}
        </p>
      ) : null}
      {!view ? (
        busy ? (
          <LoadingState>물류를 확인하는 중</LoadingState>
        ) : (
          <div className={styles.row}>
            {retryUntil > now ? (
              <p role="status">{Math.ceil((retryUntil - now) / 1000)}초 뒤에 다시 확인하세요.</p>
            ) : null}
            <button type="button" className={styles.secondary} disabled={retryUntil > now} onClick={() => void load()}>
              다시 확인
            </button>
          </div>
        )
      ) : (
        <>
          {stale ? (
            <div className={styles.row}>
              <p className={styles.note}>
                보이는 값이 오래됐을 수 있습니다. 새로 확인하기 전에는 새 요청을 보내지 않습니다.
              </p>
              <button type="button" className={styles.secondary} disabled={busy} onClick={() => void load()}>
                새로 확인
              </button>
            </div>
          ) : null}
          {view.pending ? (
            <PendingStatus
              pending={view.pending}
              names={names}
              busy={busy}
              unconfirmed={unconfirmed}
              canResubmit={view.board.visible && view.board.own && view.board.canManage}
              recheck={() => void act(view.pending!, 'check')}
              resubmit={() => void act(view.pending!, 'resubmit')}
            />
          ) : null}
          {!view.board.visible ? (
            <p className={styles.note}>
              물류는 자기 국가 거점에서 보입니다. 내 장수가 있는 다른 국가 거점에서는 특산만 보입니다.
            </p>
          ) : !view.board.own ? (
            <>
              <Specialty specialty={view.board.specialty} />
              <p className={styles.note}>다른 국가 거점의 재고와 수송대는 보이지 않습니다.</p>
            </>
          ) : (
            <OwnBoard
              key={`${view.userId}:${cityKey}:${formEpoch}`}
              board={view.board}
              locked={busy || stale || view.pending !== null || !view.board.canManage}
              names={names}
              when={when}
              submit={(payload) => void act({ requestId: crypto.randomUUID(), payload }, 'submit')}
            />
          )}
        </>
      )}
    </section>
  );
}

function appliedMessage(result: Extract<LogisticsRequestResult, { status: 'applied' }>['result']): string {
  const lost = result.movements.some((row) => row.reason === 'LOSS_OVERFLOW' || row.reason === 'LOSS_TRANSIT');
  const base = {
    dispatch: `수송대${result.convoyId ? ` ${result.convoyId}` : ''}가 출발했습니다.`,
    cancel: '수송대를 취소하고 화물을 출발지로 돌려보냈습니다.',
    upgrade: '창고를 증축했습니다.',
    trade: '교역을 마쳤습니다.',
  }[result.action];
  return lost ? `${base} 창고가 차거나 운송 중 손실된 양이 기록됐습니다. 기록 탭에서 확인하세요.` : base;
}

function describe(payload: LogisticsPayload, names: Names): string {
  if (payload.type === 'dispatch')
    return `${names(payload.fromCityKey)}에서 ${names(payload.toCityKey)}로 보내기 · ${goodsText(payload.goods)}`;
  if (payload.type === 'cancel') return `수송대 ${payload.convoyId} 취소`;
  if (payload.type === 'upgrade') return `${names(payload.cityKey)} 창고 증축`;
  return `${names(payload.cityKey)} ${GOOD_LABEL[payload.good]} ${formatCount(payload.amount)} ${payload.side === 'buy' ? '매입' : '매도'}`;
}
function goodsText(goods: Record<LogisticsGood, number>): string {
  return (
    LOGISTICS_GOODS.filter(([good]) => goods[good] > 0)
      .map(([good, label]) => `${label} ${formatCount(goods[good])}`)
      .join(' · ') || '없음'
  );
}

function PendingStatus({
  pending,
  names,
  busy,
  unconfirmed,
  canResubmit,
  recheck,
  resubmit,
}: {
  pending: LogisticsPending;
  names: Names;
  busy: boolean;
  unconfirmed: boolean;
  canResubmit: boolean;
  recheck: () => void;
  resubmit: () => void;
}) {
  return (
    <div className={styles.status} role="status" aria-live="polite">
      <p>
        <strong>요청 처리 대기</strong> · {describe(pending.payload, names)}
      </p>
      <p className={styles.note}>
        {unconfirmed
          ? '이 요청의 접수 기록을 아직 찾지 못했습니다. 보내던 요청이 늦게 접수될 수도 있습니다. 같은 요청을 그대로 다시 접수하면 서버가 같은 번호로 한 번만 받습니다. 결과를 받기 전에는 새 요청을 만들지 않습니다.'
          : '접수한 요청을 처리하고 있습니다. 결과가 나올 때까지 새 물류 요청은 기다려 주세요.'}
      </p>
      {unconfirmed && !canResubmit ? (
        <p className={styles.note}>지금 이 거점에서는 다시 접수할 수 없어 같은 요청의 상태만 확인할 수 있습니다.</p>
      ) : null}
      <div className={styles.row}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={recheck}>
          같은 요청 상태 확인
        </button>
        {unconfirmed && canResubmit ? (
          <button type="button" className={styles.secondary} disabled={busy} onClick={resubmit}>
            같은 요청 다시 접수
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Specialty({ specialty }: { specialty: OwnLogisticsBoard['specialty'] }) {
  return specialty ? (
    <p className={styles.specialty}>
      특산 {GOOD_LABEL[specialty.good]} · 기준 월 {formatCount(specialty.perMonth)}
      <span className={styles.note}>
        {' '}
        실제 생산량은 월 정산에서 소유·보급·인구에 따라 달라집니다. 창고가 차면 넘친 양은 손실로 기록됩니다.
      </span>
    </p>
  ) : (
    <p className={styles.note}>이 거점은 특산 재화를 만들지 않습니다.</p>
  );
}

const TABS = [
  ['dispatch', '보내기'],
  ['convoys', '수송대'],
  ['upgrade', '창고 증축'],
  ['trade', '교역'],
  ['history', '기록'],
] as const;
type Tab = (typeof TABS)[number][0];

function OwnBoard({
  board,
  locked,
  names,
  when,
  submit,
}: {
  board: OwnLogisticsBoard;
  locked: boolean;
  names: Names;
  when: When;
  submit: (payload: LogisticsPayload) => void;
}) {
  const [tab, setTab] = useState<Tab>('dispatch');
  const id = useId();
  const free = Math.max(0, board.capacity - board.used);
  const reason = readOnlyReason(board);
  const percent = (value: number) => (board.capacity > 0 ? (value / board.capacity) * 100 : 0);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(([key]) => key === tab);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setTab(TABS[next]![0]);
    document.getElementById(`${id}-tab-${TABS[next]![0]}`)?.focus();
  };
  return (
    <>
      <div className={styles.stock}>
        <p className={styles.summary}>
          <span>창고 {formatCount(board.resources.level)}단계</span>
          <span>
            사용 {formatCount(board.used)} / 용량 {formatCount(board.capacity)}
          </span>
          <span>남은 칸 {formatCount(free)}</span>
          <span>도시 금 {formatCount(board.gold)}</span>
        </p>
        <div
          className={styles.meter}
          role="img"
          aria-label={`공용 창고 ${formatCount(board.used)} / ${formatCount(board.capacity)} 사용`}
        >
          {LOGISTICS_GOODS.map(([good]) => (
            <i key={good} className={styles[good]} style={{ width: `${percent(board.resources[good])}%` }} />
          ))}
        </div>
        <ul className={styles.legend}>
          {LOGISTICS_GOODS.map(([good, label]) => (
            <li key={good}>
              <i className={styles[good]} aria-hidden="true" />
              {label} {formatCount(board.resources[good])}
            </li>
          ))}
        </ul>
        <p className={styles.note}>철·목재·말은 한 창고 용량을 함께 씁니다. 금·쌀은 위 금·쌀·수비병 칸에서 봅니다.</p>
      </div>
      <Specialty specialty={board.specialty} />
      <LogisticsCosts board={board} />
      {reason ? (
        <p className={styles.note} role="note">
          {reason}
        </p>
      ) : null}
      <div className={styles.tabs} role="tablist" aria-label="물류 작업">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`${id}-panel`}
            tabIndex={tab === key ? 0 : -1}
            className={styles.tab}
            onClick={() => setTab(key)}
            onKeyDown={onTabKey}
          >
            {key === 'convoys' ? `${label} ${formatCount(board.convoys.length)}` : label}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className={styles.tabPanel}>
        {tab === 'dispatch' ? (
          <DispatchForm board={board} locked={locked} names={names} when={when} submit={submit} />
        ) : tab === 'convoys' ? (
          <Convoys board={board} locked={locked} names={names} when={when} submit={submit} />
        ) : tab === 'upgrade' ? (
          <UpgradeForm board={board} locked={locked} submit={submit} />
        ) : tab === 'trade' ? (
          <TradeForm board={board} locked={locked} submit={submit} />
        ) : (
          <History movements={board.movements} when={when} />
        )}
      </div>
    </>
  );
}

function Reasons({ reasons }: { reasons: readonly string[] }) {
  return reasons.length ? (
    <ul className={styles.reasons} aria-label="지금 보낼 수 없는 이유">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  ) : null;
}

function DispatchForm({
  board,
  locked,
  names,
  when,
  submit,
}: {
  board: OwnLogisticsBoard;
  locked: boolean;
  names: Names;
  when: When;
  submit: (payload: LogisticsPayload) => void;
}) {
  const [draft, setDraft] = useState<DispatchDraft>({ to: '', iron: '', wood: '', horses: '' });
  if (!board.destinations.length)
    return (
      <p className={styles.note}>
        보급이 이어진 자국 거점으로 가는 경로가 없습니다. 경로가 생기면 도착지가 나타납니다.
      </p>
    );
  const check = dispatchCheck(board, draft);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!locked && check.payload) submit(check.payload);
  };
  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="재화 보내기">
      <label>
        도착지
        <select value={draft.to} disabled={locked} onChange={(e) => setDraft({ ...draft, to: e.target.value })}>
          <option value="">도착지를 고르세요</option>
          {board.destinations.map((row) => (
            <option key={row.cityKey} value={row.cityKey}>
              {row.name} · {formatCount(row.path.length - 1)}구간 · {when(row.arriveTick)} 도착
            </option>
          ))}
        </select>
      </label>
      <div className={styles.goods}>
        {LOGISTICS_GOODS.map(([good, label]) => (
          <label key={good}>
            {label} (보유 {formatCount(board.resources[good])})
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={Math.min(board.resources[good], board.costs.transport.maxPerOrder)}
              step={1}
              value={draft[good]}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, [good]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {check.destination ? (
        <dl className={styles.preview} aria-label="보내기 예상">
          <dt>경로</dt>
          <dd>{check.destination.path.map(names).join(' → ')}</dd>
          <dt>도착 예정</dt>
          <dd>{when(check.destination.arriveTick)} 월 정산 (중간 위치는 없습니다)</dd>
          <dt>운송 손실률</dt>
          <dd>{lossPercent(check.destination.lossBp)} (재화별 손실은 소수점 아래를 버립니다)</dd>
          <dt>도착지 남은 칸</dt>
          <dd>{formatCount(check.destination.freeCapacity)} (지금 기준, 도착 전에 바뀔 수 있습니다)</dd>
          <dt>보낼 합계</dt>
          <dd>{formatCount(check.total)}</dd>
        </dl>
      ) : null}
      {check.overflowRisk ? (
        <p className={styles.warning} role="note">
          보낼 양이 도착지의 지금 남은 칸보다 많습니다. 도착 때 창고가 차 있으면 넘친 양은 손실로 기록됩니다.
        </p>
      ) : null}
      <Reasons reasons={check.reasons} />
      <p className={styles.note}>
        보내면 이 거점 재고에서 바로 빠집니다. 경로가 끊기거나 도착지를 잃으면 서버 판정대로 반환·노획·손실로
        처리됩니다.
      </p>
      <button type="submit" className={styles.primary} disabled={locked || !check.payload}>
        보내기 요청
      </button>
    </form>
  );
}

function Convoys({
  board,
  locked,
  names,
  when,
  submit,
}: {
  board: OwnLogisticsBoard;
  locked: boolean;
  names: Names;
  when: When;
  submit: (payload: LogisticsPayload) => void;
}) {
  const [confirming, setConfirming] = useState<number | null>(null);
  const confirmId = useId();
  if (!board.convoys.length) return <p className={styles.note}>이동 중인 자국 수송대가 없습니다.</p>;
  type Row = OwnLogisticsBoard['convoys'][number];
  const free = Math.max(0, board.capacity - board.used);
  const target = board.convoys.find((row) => row.id === confirming) ?? null;
  const close = () => {
    const id = confirming;
    setConfirming(null);
    if (id !== null) requestAnimationFrame(() => document.getElementById(`${confirmId}-ask-${id}`)?.focus());
  };
  const columns: Column<Row>[] = [
    {
      key: 'id',
      label: '수송대',
      render: (row) => `${formatCount(row.id)}번`,
      sortValue: (row) => row.id,
      numeric: true,
    },
    { key: 'route', label: '경로', render: (row) => `${names(row.fromCityKey)} → ${names(row.toCityKey)}` },
    { key: 'goods', label: '화물', render: (row) => goodsText(row.goods) },
    { key: 'arrive', label: '도착', render: (row) => when(row.arriveTick), sortValue: (row) => row.arriveTick },
    {
      key: 'cancel',
      label: '취소',
      render: (row) =>
        locked ? (
          '—'
        ) : (
          <button
            type="button"
            id={`${confirmId}-ask-${row.id}`}
            className={styles.secondary}
            aria-label={`수송대 ${row.id} 취소`}
            onClick={() => {
              setConfirming(row.id);
              requestAnimationFrame(() => document.getElementById(`${confirmId}-confirm`)?.focus());
            }}
          >
            취소
          </button>
        ),
    },
  ];
  const total = target ? target.goods.iron + target.goods.wood + target.goods.horses : 0;
  return (
    <>
      <DataTable
        caption={`자국 수송대 ${formatCount(board.convoys.length)}대`}
        rows={board.convoys}
        columns={columns}
        rowKey={(row) => row.id}
        mobileDetails={['route', 'arrive']}
      />
      {target && !locked ? (
        <div
          className={styles.confirm}
          role="group"
          aria-label={`수송대 ${target.id} 취소 확인`}
          onKeyDown={(event) => {
            // 확인 칸만 닫고 도시 선택 같은 바깥 Escape 동작은 함께 실행하지 않는다. 초점은 원래 취소 단추로 돌린다.
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <p>
            수송대 {formatCount(target.id)}를 취소하면 화물({goodsText(target.goods)})이 바로 출발지{' '}
            {names(target.fromCityKey)}로 돌아갑니다.
          </p>
          <p className={styles.note}>
            {target.fromCityKey === board.cityKey
              ? total > free
                ? `이 창고의 남은 칸이 ${formatCount(free)}이라 넘치는 양은 창고 초과 손실로 기록됩니다.`
                : `이 창고의 남은 칸 ${formatCount(free)} 안에 들어갑니다.`
              : '출발지 창고가 차 있으면 넘친 양은 창고 초과 손실로 기록됩니다.'}{' '}
            이미 도착 정산이 끝났거나 출발지를 잃었으면 서버가 거부합니다.
          </p>
          <div className={styles.row}>
            <button
              type="button"
              id={`${confirmId}-confirm`}
              className={styles.primary}
              onClick={() => {
                setConfirming(null);
                submit({ type: 'cancel', convoyId: target.id });
              }}
            >
              취소 요청 보내기
            </button>
            <button type="button" className={styles.secondary} onClick={close}>
              그만두기
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function UpgradeForm({
  board,
  locked,
  submit,
}: {
  board: OwnLogisticsBoard;
  locked: boolean;
  submit: (payload: LogisticsPayload) => void;
}) {
  const check = upgradeCheck(board);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!locked && check.payload) submit(check.payload);
  };
  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="창고 증축">
      <dl className={styles.preview}>
        <dt>지금</dt>
        <dd>
          {formatCount(board.resources.level)}단계 · 용량 {formatCount(board.capacity)}
        </dd>
        <dt>증축 뒤</dt>
        <dd>
          {check.nextCapacity === null
            ? '—'
            : `${formatCount(board.resources.level + 1)}단계 · 용량 ${formatCount(check.nextCapacity)}`}
        </dd>
        <dt>비용</dt>
        <dd>
          도시 금 {formatCount(board.costs.upgrade.gold)} · 목재 {formatCount(board.costs.upgrade.wood)} (같은 처리에서
          함께 빠집니다)
        </dd>
      </dl>
      <Reasons reasons={check.reasons} />
      <button type="submit" className={styles.primary} disabled={locked || !check.payload}>
        증축 요청
      </button>
    </form>
  );
}

function TradeForm({
  board,
  locked,
  submit,
}: {
  board: OwnLogisticsBoard;
  locked: boolean;
  submit: (payload: LogisticsPayload) => void;
}) {
  const [draft, setDraft] = useState<TradeDraft>({ good: 'iron', side: 'buy', amount: '' });
  const check = tradeCheck(board, draft);
  const name = useId();
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!locked && check.payload) submit(check.payload);
  };
  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="도시 금과 재화 교역">
      <label>
        재화
        <select
          value={draft.good}
          disabled={locked}
          onChange={(e) => setDraft({ ...draft, good: e.target.value as LogisticsGood })}
        >
          {LOGISTICS_GOODS.map(([good, label]) => (
            <option key={good} value={good}>
              {label} · 매입 {formatCount(board.costs.trade[good].buy)}금 · 매도{' '}
              {formatCount(board.costs.trade[good].sell)}금
            </option>
          ))}
        </select>
      </label>
      <fieldset className={styles.choice}>
        <legend>거래</legend>
        {(
          [
            ['buy', '매입 (도시 금 → 재화)'],
            ['sell', '매도 (재화 → 도시 금)'],
          ] as const
        ).map(([side, label]) => (
          <label key={side}>
            <input
              type="radio"
              name={name}
              value={side}
              checked={draft.side === side}
              disabled={locked}
              onChange={() => setDraft({ ...draft, side })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label>
        수량
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={draft.amount}
          disabled={locked}
          onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
        />
      </label>
      <dl className={styles.preview}>
        <dt>단가</dt>
        <dd>{formatCount(check.price)}금</dd>
        <dt>{draft.side === 'buy' ? '도시 금 지출' : '도시 금 수입'}</dt>
        <dd>{check.total === null ? '—' : formatCount(check.total)}</dd>
      </dl>
      <Reasons reasons={check.reasons} />
      <p className={styles.note}>처리할 때 재고와 금을 다시 판정합니다. 그사이 바뀌면 거부될 수 있습니다.</p>
      <button type="submit" className={styles.primary} disabled={locked || !check.payload}>
        교역 요청
      </button>
    </form>
  );
}

function History({ movements, when }: { movements: readonly LogisticsMovement[]; when: When }) {
  if (!movements.length) return <p className={styles.note}>최근 이 거점의 재화 기록이 없습니다.</p>;
  const columns: Column<LogisticsMovement>[] = [
    { key: 'reason', label: '사유', render: (row) => MOVEMENT_REASON[row.reason] },
    { key: 'good', label: '재화', render: (row) => GOOD_LABEL[row.good] },
    {
      key: 'delta',
      label: '증감',
      numeric: true,
      sortValue: (row) => row.delta,
      render: (row) => `${row.delta > 0 ? '+' : ''}${formatCount(row.delta)}`,
    },
    { key: 'tick', label: '연월', sortValue: (row) => row.tick, render: (row) => when(row.tick) },
  ];
  return (
    <DataTable
      caption="최근 기록"
      rows={movements}
      columns={columns}
      rowKey={(row) => `${row.tick}:${row.sequence}:${row.ordinal}`}
      mobileDetails={['tick']}
    />
  );
}
