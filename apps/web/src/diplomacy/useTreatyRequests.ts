import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorCode, serverMessage } from '../turns/apiError';
import { sendAction, treatyApi, TREATY_PATH_KEY, type ActionInput, type RequestId } from './contract';
import {
  applyCheckError,
  applyOutcome,
  applySendError,
  dismissFinished,
  readTracked,
  resendRequest,
  shouldPoll,
  startRequest,
  writeTracked,
  type RequestsState,
} from './requests';

const sessionStore = () => (typeof window === 'undefined' ? undefined : window.sessionStorage);
const POLL_MS = 1_000;

// 즉시 행동을 보내고 결과가 확정될 때까지 추적한다. 규칙은 requests.ts에 있다.
export function useTreatyRequests(worldId: string, storageKey: string) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RequestsState>(() => ({
    tracked: readTracked(sessionStore(), storageKey),
    finished: [],
  }));
  // 보내기 전에 sessionStorage에 써야 하므로 렌더를 기다리지 않고 바로 쓴다.
  const ref = useRef(state);
  const update = useCallback(
    (fn: (prev: RequestsState) => RequestsState) => {
      const before = ref.current;
      const next = fn(before);
      if (next === before) return;
      ref.current = next;
      writeTracked(sessionStore(), storageKey, next.tracked);
      setState(next);
      if (next.finished.length > before.finished.length)
        void queryClient.invalidateQueries({ queryKey: TREATY_PATH_KEY });
    },
    [queryClient, storageKey],
  );

  const deliver = useCallback(
    (requestId: RequestId, action: ActionInput) => {
      sendAction(worldId, requestId, action).then(
        (outcome) => update((prev) => applyOutcome(prev, outcome)),
        (error: unknown) => update((prev) => applySendError(prev, requestId, errorCode(error), serverMessage(error))),
      );
    },
    [update, worldId],
  );

  const send = useCallback(
    (action: ActionInput) => {
      const requestId = crypto.randomUUID();
      update((prev) => startRequest(prev, requestId, action));
      deliver(requestId, action);
      return requestId;
    },
    [deliver, update],
  );

  // 응답을 받지 못한 요청은 같은 requestId와 같은 내용으로 다시 보낸다.
  const resend = useCallback(
    (requestId: RequestId) => {
      const item = ref.current.tracked.find((t) => t.requestId === requestId);
      if (!item || item.phase === 'sending') return;
      update((prev) => resendRequest(prev, requestId));
      deliver(requestId, item.action);
    },
    [deliver, update],
  );

  const dismiss = useCallback((requestId: RequestId) => update((prev) => dismissFinished(prev, requestId)), [update]);

  // 처리 중인 요청은 1초마다 treaty.request로 묻는다. 목록에서 사라졌는지로 결과를 추측하지 않는다.
  const polling = state.tracked.some((t) => shouldPoll(t.phase));
  const inFlight = useRef(new Set<RequestId>());
  useEffect(() => {
    if (!polling) return;
    const tick = () => {
      for (const item of ref.current.tracked) {
        if (!shouldPoll(item.phase) || inFlight.current.has(item.requestId)) continue;
        inFlight.current.add(item.requestId);
        treatyApi.request
          .query({ worldId, requestId: item.requestId })
          .then(
            (outcome) => update((prev) => applyOutcome(prev, outcome)),
            (error: unknown) => update((prev) => applyCheckError(prev, item.requestId, errorCode(error))),
          )
          .finally(() => inFlight.current.delete(item.requestId));
      }
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, update, worldId]);

  return { tracked: state.tracked, finished: state.finished, send, resend, dismiss };
}
