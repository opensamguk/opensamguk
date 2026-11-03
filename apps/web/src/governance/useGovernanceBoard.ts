import { TRPCClientError } from '@trpc/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { retryAfterSeconds } from '../auth/credentials';
import { refreshFailureClearsView } from '../hooks/logisticsRequestState';
import { useTRPCClient } from '../trpc';
import { errorCode, serverMessage } from '../turns/apiError';
import { APPLIED_MESSAGE, type GovernanceBoard, type GovernanceRequestResult } from './governanceModel';
import {
  forgetGovernancePending,
  governanceActorChanged,
  governanceModeAllowed,
  governanceStorageKey,
  readGovernancePending,
  sameGovernanceRequest,
  writeGovernancePending,
  type GovernancePending,
  type GovernanceRequestMode,
} from './governanceRequestState';

// 황실 조회·요청 흐름 (T4-94, AC-P2-31). 물류 칸(LogisticsPanel)과 같은 순서다:
// 계정 재확인 → 탭 저장 → 한 번 전송 → 상태 확인. 자동으로 다시 보내지 않는다. 확인하지 못한 요청은
// 같은 번호·내용으로만 손으로 다시 접수한다.
export type GovernanceState = { userId: string; board: GovernanceBoard; pending: GovernancePending | null };
export type GovernanceNotice = { text: string; tone: 'info' | 'ok' | 'error' } | null;
class IdentityChanged extends Error {}

const ACCOUNT_MESSAGE = '계정이 바뀌었습니다. 다시 확인하세요.';
const RECORD_MESSAGE = '요청 기록이 바뀌었습니다. 다시 확인하세요.';
// 가문 계승(T4-95)은 같은 계정의 장수만 바꾼다. 계정 확인만으로는 전임자 기준 대화상자를 막지 못한다.
const GENERAL_CHANGED_MESSAGE = '장수가 바뀌었습니다. 화면을 다시 확인하세요.';
export const OLD_REQUEST_CLEARED =
  '이전 장수 명의 요청은 접수되지 않았고 앞으로도 처리되지 않음을 확인해 이 탭의 기록을 지웠습니다. 필요하면 새로 요청하세요.';
export const OLD_REQUEST_KEPT = '이전 장수 명의 요청을 확인하지 못해 기록을 그대로 두었습니다. 다시 확인하세요.';
const OLD_REQUEST_NO_RESEND =
  '장수가 바뀌어 이전 장수 명의 요청은 다시 접수하지 않았습니다. 같은 요청의 상태를 확인하거나 이전 장수 요청 기록 지우기를 누르세요.';
const viewerOf = (board: GovernanceBoard) => (board.view.enabled ? board.view.viewerGeneralId : null);
const deniedView = (error: unknown) => refreshFailureClearsView(errorCode(error), error instanceof IdentityChanged);
const unreachable = (error: unknown) => errorCode(error) === undefined && !(error instanceof IdentityChanged);
// 황실 기능을 켜지 않은 월드. 오류로 보이지 않고 조회를 다시 하지 않는다.
const featureOff = (error: unknown) => errorCode(error) === 'PRECONDITION_FAILED';
export const STALE_NOTICE: GovernanceNotice = {
  text: '황실 정보를 다시 확인하지 못했습니다. 보이는 값이 오래됐을 수 있어 새 요청을 잠시 막았습니다. 새로 확인을 누르세요.',
  tone: 'error',
};
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
const canSubmit = (board: GovernanceBoard) => board.canSubmit && board.view.enabled;

export function useGovernanceBoard(worldId: string) {
  const api = useTRPCClient();
  const [view, setView] = useState<GovernanceState | null>(null);
  const [notice, setNotice] = useState<GovernanceNotice>(null);
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState(false);
  // 상태 확인에서 접수 기록을 아직 찾지 못했다(404). 원래 전송이 잠금을 기다리는 중일 수 있으므로
  // 기록을 지우거나 새 번호를 만들지 않는다.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [stale, setStale] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [retryUntil, setRetryUntil] = useState(0),
    [now, setNow] = useState(Date.now);
  const viewRef = useRef<GovernanceState | null>(null);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const offRef = useRef(false);
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
  // 보기를 지울 때마다 세션 번호를 올린다. 그 전에 연 확인 대화상자는 다른 계정으로 다시 읽은 뒤에도
  // 보낼 수 없다. ref는 렌더·effect를 기다리지 않고 바로 비교하려고, state는 대화상자를 숨기려고 둔다.
  const session = useRef(0);
  const [sessionId, setSessionId] = useState(0);
  const drop = useCallback(() => {
    setSessionId(++session.current);
    setView(null);
  }, []);
  const turnOff = useCallback(() => {
    offRef.current = true;
    setOff(true);
    drop();
    setNotice(null);
  }, [drop]);
  // 같은 계정으로 다시 읽었는데 보는 장수가 바뀌었으면(계승) 열린 확인 대화상자와 입력 폼을 버린다.
  const lastViewer = useRef<{ userId: string; generalId: number | null } | null>(null);
  useEffect(() => {
    if (!view) return;
    const before = lastViewer.current,
      generalId = viewerOf(view.board);
    lastViewer.current = { userId: view.userId, generalId };
    if (!before || before.userId !== view.userId || before.generalId === generalId) return;
    setSessionId(++session.current);
    setFormEpoch((value) => value + 1);
    setNotice((previous) => previous ?? { text: GENERAL_CHANGED_MESSAGE, tone: 'info' });
  }, [view]);

  const snapshot = useCallback(
    async (signal: AbortSignal, expected?: string) => {
      const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
      const before = await api.auth.me.query(undefined, options);
      const userId = before.user?.id;
      if (!userId || (expected && userId !== expected)) throw new IdentityChanged(ACCOUNT_MESSAGE);
      const board = await api.governance.get.query({ worldId }, options);
      const after = await api.auth.me.query(undefined, options);
      if (board.userId !== userId || board.worldId !== worldId || after.user?.id !== userId)
        throw new IdentityChanged(ACCOUNT_MESSAGE);
      return { userId, board };
    },
    [api, worldId],
  );

  const observe = useCallback(
    async (userId: string, request: GovernancePending, signal: AbortSignal, valid: () => boolean) => {
      const deadline = Date.now() + 60_000;
      while (valid()) {
        const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
        const me = await api.auth.me.query(undefined, options);
        if (me.user?.id !== userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
        let result: GovernanceRequestResult;
        try {
          result = await api.governance.request.query({ worldId, requestId: request.requestId }, options);
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
          // 최종 결과(applied/rejected)를 받았을 때만 탭 기록을 끝낸다.
          if (!forgetGovernancePending(sessionStorage, governanceStorageKey(userId, worldId), request))
            throw new IdentityChanged(RECORD_MESSAGE);
          const fresh = await snapshot(signal, userId);
          if (!valid()) return;
          setView({ ...fresh, pending: null });
          setStale(false);
          if (result.status === 'applied') {
            setNotice({ text: APPLIED_MESSAGE[result.result.action], tone: 'ok' });
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

  const load = useCallback(async () => {
    if (offRef.current || Date.now() < retryDeadline.current) return;
    const run = begin();
    const expected = viewRef.current?.userId;
    setNotice(null);
    setUnconfirmed(false);
    setBusy(true);
    try {
      const fresh = await snapshot(run.signal, expected);
      if (!run.current()) return;
      if (!fresh.board.view.enabled) return turnOff();
      const pending = readGovernancePending(sessionStorage, governanceStorageKey(fresh.userId, worldId));
      setView({ ...fresh, pending });
      setStale(false);
      if (pending) await observe(fresh.userId, pending, run.signal, run.current);
    } catch (error) {
      if (!run.current()) return;
      if (featureOff(error)) return turnOff();
      if (deniedView(error)) drop();
      else setStale(true);
      setNotice({
        text:
          error instanceof IdentityChanged
            ? error.message
            : (serverMessage(error) ?? '황실 정보를 확인하지 못했습니다. 연결을 확인한 뒤 다시 확인하세요.'),
        tone: 'error',
      });
    } finally {
      if (run.current()) setBusy(false);
    }
  }, [begin, snapshot, worldId, observe, turnOff, drop]);

  useEffect(() => {
    void load();
    const clear = () => {
      controller.current?.abort();
      ++generation.current;
      drop();
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
  }, [load, drop]);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= retryUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryUntil]);

  // 같은 계정·세대에서만 새로 읽는다. 폼은 formEpoch가 바뀔 때만 새로 만들어 입력이 남는다.
  // 요청을 확인하는 중이거나 월드가 진행 중이 아니면 멈춘다.
  useEffect(() => {
    if (!view || view.pending || busy || view.board.status !== 'RUNNING') return;
    const timer = setInterval(() => {
      if (sending.current || document.hidden) return;
      const signal = controller.current?.signal,
        stamp = generation.current;
      if (!signal || signal.aborted) return;
      void snapshot(signal, view.userId)
        .then((fresh) => {
          if (generation.current !== stamp || signal.aborted) return;
          if (!fresh.board.view.enabled) return turnOff();
          setView({ ...fresh, pending: null });
          setStale(false);
          setNotice((previous) => (previous === STALE_NOTICE ? null : previous));
        })
        .catch((error) => {
          if (generation.current !== stamp || signal.aborted) return;
          if (featureOff(error)) return turnOff();
          if (deniedView(error)) {
            drop();
            setNotice({
              text:
                error instanceof IdentityChanged
                  ? error.message
                  : (serverMessage(error) ?? '황실 정보를 볼 수 없습니다.'),
              tone: 'error',
            });
            return;
          }
          setStale(true);
          setNotice(STALE_NOTICE);
        });
    }, 15_000);
    return () => clearInterval(timer);
  }, [view, busy, snapshot, turnOff, drop]);

  // submit: 새 번호로 새 요청을 보낸다. check: 저장된 요청의 상태만 본다.
  // resubmit: 접수 기록을 찾지 못한 저장 요청을 같은 번호·내용 그대로 다시 보낸다. 기록은 최종 결과에서만 지운다.
  // request.generalId: 처음 기록을 만든 대화상자가 본 장수. 새 요청은 다시 읽은 장수가 다르면 보내지 않고,
  // 재접수도 바뀐 장수 명의로는 보내지 않는다. 보낼 때는 이 값을 expectedGeneralId로 그대로 보낸다.
  async function act(request: GovernancePending, mode: GovernanceRequestMode) {
    if (!view || sending.current) return;
    const key = governanceStorageKey(view.userId, worldId);
    const allowed = governanceModeAllowed(mode, {
      request,
      pending: view.pending,
      saved: readGovernancePending(sessionStorage, key),
      canSubmit: canSubmit(view.board),
      stale,
    });
    if (!allowed || (mode !== 'check' && Date.now() < retryDeadline.current)) return;
    const sends = mode !== 'check';
    sending.current = true;
    const run = begin();
    const current = view;
    setBusy(true);
    setNotice(null);
    let latest: GovernanceState = current,
      mutationStarted = false,
      mutationReturned = false;
    try {
      const fresh = await snapshot(run.signal, current.userId);
      if (!run.current()) return;
      latest = { ...fresh, pending: current.pending };
      setView(latest);
      setStale(false);
      if (mode === 'submit' && viewerOf(fresh.board) !== request.generalId) {
        setNotice({ text: `${GENERAL_CHANGED_MESSAGE} 요청을 보내지 않았습니다.`, tone: 'error' });
        return;
      }
      if (mode === 'resubmit' && governanceActorChanged(request, viewerOf(fresh.board))) {
        setNotice({ text: OLD_REQUEST_NO_RESEND, tone: 'error' });
        return;
      }
      if (sends) {
        if (!canSubmit(fresh.board)) {
          setNotice({
            text:
              mode === 'submit'
                ? '지금은 황실 요청을 보낼 수 없습니다. 위 안내를 확인하세요.'
                : '지금은 다시 접수할 수 없습니다. 같은 요청의 상태만 확인할 수 있습니다.',
            tone: 'error',
          });
          return;
        }
        const me = await api.auth.me.query(undefined, timed(run.signal));
        if (me.user?.id !== current.userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
        if (!run.current()) return;
        const saved = readGovernancePending(sessionStorage, key);
        if (mode === 'submit') {
          if (saved) throw new IdentityChanged(RECORD_MESSAGE);
          // 마지막 신원 조회까지 마친 뒤 저장한다. 저장과 전송 사이에는 await를 두지 않는다.
          writeGovernancePending(sessionStorage, key, request);
          latest = { ...fresh, pending: request };
          setView(latest);
        } else if (
          !governanceModeAllowed('resubmit', {
            request,
            pending: current.pending,
            saved,
            canSubmit: true,
            stale: false,
          })
        )
          throw new IdentityChanged(RECORD_MESSAGE);
        setUnconfirmed(false);
        mutationStarted = true;
        // 다시 읽기와 접수 사이(수 ms)의 계승은 서버가 expectedGeneralId로 막는다(CONFLICT).
        // 장수 id가 없는 예전 기록은 예전처럼 보낸다.
        const accepted = await api.governance.submit.mutate(
          {
            worldId,
            expectedUserId: current.userId,
            ...(request.generalId === undefined ? {} : { expectedGeneralId: request.generalId }),
            requestId: request.requestId,
            payload: request.payload,
          },
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
          forgetGovernancePending(sessionStorage, key, request);
        } catch {
          cleanupFailed = true;
        }
      }
      if (run.current()) {
        if (unaccepted && keepForm(error)) setView({ ...latest, pending: null });
        else if (deniedView(error) || unaccepted) drop();
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
                    ? '요청을 보내지 않았습니다. 계정과 월드를 다시 확인하세요.'
                    : '상태를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.')),
        });
      }
    } finally {
      sending.current = false;
      if (run.current()) setBusy(false);
    }
  }

  // 이전 장수 명의 요청의 탭 기록을 사용자가 명시적으로 지운다(가문 칸 useLineageBoard.forgetOld와 같은 순서).
  // 1) 같은 계정으로 새로 읽은 보기의 장수가 기록의 장수와 다르다(계승이 이미 끝났다).
  // 2) 그 뒤 같은 번호의 접수 기록을 새로 물어 NOT_FOUND다.
  // 계승 전에 접수됐다면 2)에서 기록이 보이고, 계승 뒤 잠금에 닿은 원래 전송은 서버가 expectedGeneralId로 거부하므로
  // 이 요청은 앞으로도 적용될 수 없다. 장수 id가 없는 예전 기록, 같은 장수의 미확인 요청, 접수 기록이 있는 요청,
  // 확인 실패(연결·인증)는 지우지 않는다. 다시 보내거나 새 번호를 만들지 않는다.
  async function forgetOld(request: GovernancePending) {
    const current = viewRef.current;
    if (!current || sending.current || request.generalId === undefined) return;
    if (!sameGovernanceRequest(current.pending, request)) return;
    const key = governanceStorageKey(current.userId, worldId);
    if (!sameGovernanceRequest(readGovernancePending(sessionStorage, key), request)) return;
    sending.current = true;
    const run = begin();
    setBusy(true);
    setNotice(null);
    try {
      const fresh = await snapshot(run.signal, current.userId);
      if (!run.current()) return;
      setView({ ...fresh, pending: request });
      setStale(false);
      if (!governanceActorChanged(request, viewerOf(fresh.board))) {
        setNotice({
          text: '지금 장수가 이 요청을 보낸 장수와 달라졌음을 확인하지 못해 기록을 지우지 않았습니다. 같은 요청의 상태를 확인하세요.',
          tone: 'error',
        });
        return;
      }
      let receipt = true;
      try {
        await api.governance.request.query({ worldId, requestId: request.requestId }, timed(run.signal));
      } catch (error) {
        if (errorCode(error) !== 'NOT_FOUND') throw error;
        receipt = false;
      }
      if (!run.current()) return;
      // 접수 기록이 있으면 지우지 않고 그 결과를 끝까지 확인한다.
      if (receipt) return await observe(current.userId, request, run.signal, run.current);
      const me = await api.auth.me.query(undefined, timed(run.signal));
      if (me.user?.id !== current.userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
      if (!run.current()) return;
      if (!forgetGovernancePending(sessionStorage, key, request)) throw new IdentityChanged(RECORD_MESSAGE);
      setView({ ...fresh, pending: null });
      setUnconfirmed(false);
      setNotice({ text: OLD_REQUEST_CLEARED, tone: 'info' });
    } catch (error) {
      if (!run.current()) return;
      if (deniedView(error)) drop();
      else if (unreachable(error)) setStale(true);
      setNotice({
        text: error instanceof IdentityChanged ? error.message : (serverMessage(error) ?? OLD_REQUEST_KEPT),
        tone: 'error',
      });
    } finally {
      sending.current = false;
      if (run.current()) setBusy(false);
    }
  }

  return {
    view,
    notice,
    busy,
    off,
    stale,
    unconfirmed,
    formEpoch,
    retryWait: retryUntil > now ? Math.ceil((retryUntil - now) / 1000) : 0,
    load,
    session: sessionId,
    // owner: 대화상자를 열 때의 계정·세션·장수. 그사이 보기가 지워졌거나 계정·장수가 바뀌었으면 보내지 않는다.
    submit: (
      payload: GovernancePending['payload'],
      owner: { userId: string; session: number; generalId: number | null },
    ) => {
      if (!view || owner.session !== session.current || owner.userId !== view.userId) return;
      if (owner.generalId === null || owner.generalId !== viewerOf(view.board)) return;
      // 보낸 장수는 처음 기록을 만들 때 한 번만 정한다. 재접수·상태 확인은 저장된 값을 그대로 쓴다.
      void act({ requestId: crypto.randomUUID(), generalId: owner.generalId, payload }, 'submit');
    },
    recheck: () => view?.pending && void act(view.pending, 'check'),
    resubmit: () => view?.pending && void act(view.pending, 'resubmit'),
    forgetOld: () => view?.pending && void forgetOld(view.pending),
    // 미확인 대기 기록을 보낸 장수가 지금 보는 장수와 다른가. 이때는 재접수 대신 기록 지우기만 연다.
    oldActor: view?.pending ? governanceActorChanged(view.pending, viewerOf(view.board)) : false,
    canSubmit: view ? canSubmit(view.board) : false,
  };
}
