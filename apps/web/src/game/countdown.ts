import { useEffect, useRef, useState } from 'react';

// 다음 턴까지 남은 시간. 서버가 준 nextTurnAt(ISO)만 쓰고 tick을 직접 바꾸지 않는다 (T1-12 계약, UI 지침 §1).
export function remainingSeconds(nextTurnAt: string | null, now: number): number | null {
  if (nextTurnAt === null) return null;
  const at = Date.parse(nextTurnAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function formatRemaining(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// 0초가 되면 한 번 다시 조회한다. 서버가 같은 시각을 다시 주면(엔진이 아직 처리 전) 간격을 늘려 몇 번만 더 묻고 멈춘다.
// 요청이 몰리거나 끝없이 반복되지 않게 하기 위해서다. 새 시각이 오면 처음부터 다시 센다.
export const DUE_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

interface DueState {
  value: string;
  calls: number;
  dueAt: number;
}

export function useTurnCountdown(
  nextTurnAt: string | null,
  onDue: () => void,
  now: () => number = Date.now,
): { seconds: number | null; waiting: boolean } {
  const [current, setCurrent] = useState(now);
  const onDueRef = useRef(onDue);
  // 같은 nextTurnAt에 대한 호출 횟수는 effect가 다시 돌아도(StrictMode 포함) 이어서 센다.
  const due = useRef<DueState | null>(null);

  useEffect(() => {
    onDueRef.current = onDue;
  }, [onDue]);

  useEffect(() => {
    if (nextTurnAt === null) return;
    const at = Date.parse(nextTurnAt);
    if (Number.isNaN(at)) return;
    if (due.current?.value !== nextTurnAt) due.current = { value: nextTurnAt, calls: 0, dueAt: at };
    const state = due.current;
    const step = () => {
      const t = now();
      setCurrent(t);
      if (t < state.dueAt || state.calls > DUE_RETRY_DELAYS_MS.length) return;
      state.calls += 1;
      const delay = DUE_RETRY_DELAYS_MS[state.calls - 1];
      state.dueAt = delay === undefined ? Number.POSITIVE_INFINITY : t + delay;
      onDueRef.current();
    };
    step();
    const id = setInterval(step, 1000);
    return () => clearInterval(id);
  }, [nextTurnAt, now]);

  const seconds = remainingSeconds(nextTurnAt, current);
  return { seconds, waiting: seconds === 0 };
}
