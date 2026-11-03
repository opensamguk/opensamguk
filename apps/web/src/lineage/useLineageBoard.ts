import { useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { retryAfterSeconds } from '../auth/credentials';
import { refreshFailureClearsView } from '../hooks/logisticsRequestState';
import { useTRPCClient } from '../trpc';
import { errorCode, serverMessage } from '../turns/apiError';
import { appliedMessage, type LineageBoard, type LineageInput, type LineageRequestResult } from './lineageModel';
import {
  forgetLineagePending,
  lineageModeAllowed,
  lineageStorageKey,
  ownerCurrent,
  readLineagePending,
  sameLineageRequest,
  writeLineagePending,
  type LineageOwner,
  type LineagePending,
  type LineageRequestMode,
} from './lineageRequestState';

// 가문 조회·요청 흐름 (T4-95, AC-P2-32). 황실(useGovernanceBoard)과 같은 순서다:
// 계정 재확인 → 장수 재확인 → 탭 저장 → 한 번 전송 → 상태 확인. 자동으로 다시 보내지 않는다.
// 계승은 같은 계정의 장수만 바꾼다. 대기 기록은 계정 키라 그대로 남고, 열린 대화상자·양식은 장수 id가 바뀌면 버린다.
export type LineageState = { userId: string; board: LineageBoard; pending: LineagePending | null };
export type LineageNotice = { text: string; tone: 'info' | 'ok' | 'error' } | null;
class IdentityChanged extends Error {}

const ACCOUNT_MESSAGE = '계정이 바뀌었습니다. 다시 확인하세요.';
const RECORD_MESSAGE = '요청 기록이 바뀌었습니다. 다시 확인하세요.';
const GENERAL_CHANGED_MESSAGE = '장수가 바뀌었습니다. 화면을 다시 확인하세요.';
export const OLD_REQUEST_CLEARED =
  '이전 장수 명의 요청은 접수되지 않았고 앞으로도 처리되지 않음을 확인해 이 탭의 기록을 지웠습니다. 필요하면 새로 요청하세요.';
export const OLD_REQUEST_KEPT = '이전 장수 명의 요청을 확인하지 못해 기록을 그대로 두었습니다. 다시 확인하세요.';
const deniedView = (error: unknown) => refreshFailureClearsView(errorCode(error), error instanceof IdentityChanged);
const unreachable = (error: unknown) => errorCode(error) === undefined && !(error instanceof IdentityChanged);
// 가문 기능을 켜지 않은 월드. 오류로 보이지 않고 조회를 다시 하지 않는다.
const featureOff = (error: unknown) => errorCode(error) === 'PRECONDITION_FAILED';
export const STALE_NOTICE: LineageNotice = {
  text: '가문 정보를 다시 확인하지 못했습니다. 보이는 값이 오래됐을 수 있어 새 요청을 잠시 막았습니다. 새로 확인을 누르세요.',
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
const canSubmit = (board: LineageBoard) => board.canSubmit && board.view.actorId !== null;

export function useLineageBoard(worldId: string) {
  const api = useTRPCClient();
  const queryClient = useQueryClient();
  const [view, setView] = useState<LineageState | null>(null);
  const [notice, setNotice] = useState<LineageNotice>(null);
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState(false);
  // 상태 확인에서 접수 기록을 아직 찾지 못했다(404). 원래 전송이 늦게 접수될 수 있어 기록을 지우거나 새 번호를 만들지 않는다.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [stale, setStale] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [retryUntil, setRetryUntil] = useState(0),
    [now, setNow] = useState(Date.now);
  // 렌더를 기다리지 않고 바로 비교하려고 보기와 세션 번호를 ref에도 둔다.
  const viewRef = useRef<LineageState | null>(null);
  const offRef = useRef(false);
  const retryDeadline = useRef(0);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    sending = useRef(false);
  const session = useRef(0);
  const [sessionId, setSessionId] = useState(0);
  const begin = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const stamp = ++generation.current;
    return { stamp, signal: abort.signal, current: () => generation.current === stamp && !abort.signal.aborted };
  }, []);
  const timed = (signal: AbortSignal) => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  const drop = useCallback(() => {
    setSessionId(++session.current);
    viewRef.current = null;
    setView(null);
  }, []);
  // 새로 읽은 보기를 둔다. 같은 계정인데 장수가 바뀌었으면(계승) 열린 대화상자·양식을 버리고
  // 장수 정보·다른 칸의 공용 조회를 다시 받게 한다. 대기 기록은 계정 키라 건드리지 않는다.
  const show = useCallback(
    (next: LineageState) => {
      const before = viewRef.current;
      viewRef.current = next;
      setView(next);
      if (before && before.userId === next.userId && before.board.view.actorId !== next.board.view.actorId) {
        setSessionId(++session.current);
        setFormEpoch((value) => value + 1);
        setNotice({ text: GENERAL_CHANGED_MESSAGE, tone: 'info' });
        void queryClient.invalidateQueries();
        return true;
      }
      return false;
    },
    [queryClient],
  );
  const turnOff = useCallback(() => {
    offRef.current = true;
    setOff(true);
    drop();
    setNotice(null);
  }, [drop]);

  const snapshot = useCallback(
    async (signal: AbortSignal, expected?: string) => {
      const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
      const before = await api.auth.me.query(undefined, options);
      const userId = before.user?.id;
      if (!userId || (expected && userId !== expected)) throw new IdentityChanged(ACCOUNT_MESSAGE);
      const board = await api.lineage.get.query({ worldId }, options);
      const after = await api.auth.me.query(undefined, options);
      if (board.userId !== userId || board.worldId !== worldId || after.user?.id !== userId)
        throw new IdentityChanged(ACCOUNT_MESSAGE);
      return { userId, board };
    },
    [api, worldId],
  );

  const observe = useCallback(
    async (userId: string, request: LineagePending, signal: AbortSignal, valid: () => boolean) => {
      const deadline = Date.now() + 60_000;
      while (valid()) {
        const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
        const me = await api.auth.me.query(undefined, options);
        if (me.user?.id !== userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
        let result: LineageRequestResult;
        try {
          result = await api.lineage.request.query({ worldId, requestId: request.requestId }, options);
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
          if (!forgetLineagePending(sessionStorage, lineageStorageKey(userId, worldId), request))
            throw new IdentityChanged(RECORD_MESSAGE);
          const fresh = await snapshot(signal, userId);
          if (!valid()) return;
          show({ ...fresh, pending: null });
          setStale(false);
          if (result.status === 'applied') {
            setNotice({ text: appliedMessage(fresh.board.view, request.payload, result.result.action), tone: 'ok' });
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
    [api, worldId, snapshot, show],
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
      const pending = readLineagePending(sessionStorage, lineageStorageKey(fresh.userId, worldId));
      show({ ...fresh, pending });
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
            : (serverMessage(error) ?? '가문 정보를 확인하지 못했습니다. 연결을 확인한 뒤 다시 확인하세요.'),
        tone: 'error',
      });
    } finally {
      if (run.current()) setBusy(false);
    }
  }, [begin, snapshot, worldId, observe, turnOff, drop, show]);

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

  // 같은 계정·세대에서만 새로 읽는다. 다른 탭의 계승도 여기서 알아채 열린 대화상자를 버린다.
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
          setNotice((previous) => (previous === STALE_NOTICE ? null : previous));
          show({ ...fresh, pending: null });
          setStale(false);
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
                  : (serverMessage(error) ?? '가문 정보를 볼 수 없습니다.'),
              tone: 'error',
            });
            return;
          }
          setStale(true);
          setNotice(STALE_NOTICE);
        });
    }, 15_000);
    return () => clearInterval(timer);
  }, [view, busy, snapshot, turnOff, drop, show]);

  // submit: 새 번호로 새 요청을 보낸다. check: 저장된 요청의 상태만 본다.
  // resubmit: 접수 기록을 찾지 못한 저장 요청을 같은 번호·장수·내용 그대로 다시 보낸다. 기록은 최종 결과에서만 지운다.
  async function act(request: LineagePending, mode: LineageRequestMode) {
    const current = viewRef.current;
    if (!current || sending.current) return;
    const key = lineageStorageKey(current.userId, worldId);
    const allowed = lineageModeAllowed(mode, {
      request,
      pending: current.pending,
      saved: readLineagePending(sessionStorage, key),
      canSubmit: canSubmit(current.board),
      stale,
    });
    if (!allowed || (mode !== 'check' && Date.now() < retryDeadline.current)) return;
    const sends = mode !== 'check';
    sending.current = true;
    const run = begin();
    setBusy(true);
    setNotice(null);
    let latest: LineageState = current,
      mutationStarted = false,
      mutationReturned = false;
    try {
      const fresh = await snapshot(run.signal, current.userId);
      if (!run.current()) return;
      latest = { ...fresh, pending: current.pending };
      show(latest);
      setStale(false);
      // 새 요청은 대화상자를 연 장수가 지금도 이 계정의 장수일 때만 보낸다. 같은 요청 재접수는 처음 장수 그대로 보낸다.
      if (mode === 'submit' && fresh.board.view.actorId !== request.generalId) {
        setNotice({ text: `${GENERAL_CHANGED_MESSAGE} 요청을 보내지 않았습니다.`, tone: 'error' });
        return;
      }
      if (sends) {
        if (!canSubmit(fresh.board)) {
          setNotice({
            text:
              mode === 'submit'
                ? '지금은 가문 요청을 보낼 수 없습니다. 위 안내를 확인하세요.'
                : '지금은 다시 접수할 수 없습니다. 같은 요청의 상태만 확인할 수 있습니다.',
            tone: 'error',
          });
          return;
        }
        const me = await api.auth.me.query(undefined, timed(run.signal));
        if (me.user?.id !== current.userId) throw new IdentityChanged(ACCOUNT_MESSAGE);
        if (!run.current()) return;
        const saved = readLineagePending(sessionStorage, key);
        if (mode === 'submit') {
          if (saved) throw new IdentityChanged(RECORD_MESSAGE);
          // 마지막 신원 조회까지 마친 뒤 저장한다. 저장과 전송 사이에는 await를 두지 않는다.
          writeLineagePending(sessionStorage, key, request);
          latest = { ...fresh, pending: request };
          show(latest);
        } else if (
          !lineageModeAllowed('resubmit', { request, pending: current.pending, saved, canSubmit: true, stale: false })
        )
          throw new IdentityChanged(RECORD_MESSAGE);
        setUnconfirmed(false);
        mutationStarted = true;
        // 다시 읽기와 접수 사이(수 ms)의 계승은 서버가 expectedGeneralId로 막는다(CONFLICT).
        const accepted = await api.lineage.submit.mutate(
          {
            worldId,
            expectedUserId: current.userId,
            expectedGeneralId: request.generalId,
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
          forgetLineagePending(sessionStorage, key, request);
        } catch {
          cleanupFailed = true;
        }
      }
      if (run.current()) {
        if (unaccepted && keepForm(error)) show({ ...latest, pending: null });
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
                    ? '요청을 보내지 않았습니다. 계정과 장수를 다시 확인하세요.'
                    : '상태를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.')),
        });
      }
    } finally {
      sending.current = false;
      if (run.current()) setBusy(false);
    }
  }

  // 이전 장수 명의 요청의 탭 기록을 사용자가 명시적으로 지운다. 아래 두 확인을 이 순서로 모두 통과할 때만 지운다.
  // 1) 같은 계정으로 새로 읽은 보기의 장수가 요청의 장수와 다르다(계승이 이미 끝났다).
  // 2) 그 뒤 같은 번호의 접수 기록을 새로 물어 NOT_FOUND다.
  // 계승 전에 접수됐다면 2)에서 기록이 보이고, 계승 뒤 잠금에 닿은 원래 전송은 서버가 expectedGeneralId로 거부하므로
  // 이 요청은 앞으로도 적용될 수 없다. 같은 장수의 미확인 요청, 접수 기록이 있는 요청, 확인 실패(연결·인증)는 지우지 않는다.
  // 다시 보내거나 새 번호를 만들지 않는다.
  async function forgetOld(request: LineagePending) {
    const current = viewRef.current;
    if (!current || sending.current || !sameLineageRequest(current.pending, request)) return;
    const key = lineageStorageKey(current.userId, worldId);
    if (!sameLineageRequest(readLineagePending(sessionStorage, key), request)) return;
    sending.current = true;
    const run = begin();
    setBusy(true);
    setNotice(null);
    try {
      const fresh = await snapshot(run.signal, current.userId);
      if (!run.current()) return;
      show({ ...fresh, pending: request });
      setStale(false);
      // 지금 장수를 확인하지 못한 보기(actorId null)도 바뀐 장수로 보지 않는다.
      if (fresh.board.view.actorId === null || fresh.board.view.actorId === request.generalId) {
        setNotice({
          text: '지금 장수가 이 요청을 보낸 장수와 달라졌음을 확인하지 못해 기록을 지우지 않았습니다. 같은 요청의 상태를 확인하세요.',
          tone: 'error',
        });
        return;
      }
      let receipt = true;
      try {
        await api.lineage.request.query({ worldId, requestId: request.requestId }, timed(run.signal));
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
      if (!forgetLineagePending(sessionStorage, key, request)) throw new IdentityChanged(RECORD_MESSAGE);
      show({ ...fresh, pending: null });
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
    submit: (payload: LineageInput, owner: LineageOwner) => {
      const current = viewRef.current;
      const live = current && { userId: current.userId, session: session.current, actorId: current.board.view.actorId };
      if (!ownerCurrent(owner, live)) return;
      void act({ requestId: crypto.randomUUID(), generalId: owner.actorId, payload }, 'submit');
    },
    recheck: () => view?.pending && void act(view.pending, 'check'),
    resubmit: () => view?.pending && void act(view.pending, 'resubmit'),
    forgetOld: () => view?.pending && void forgetOld(view.pending),
    canSubmit: view ? canSubmit(view.board) : false,
  };
}
