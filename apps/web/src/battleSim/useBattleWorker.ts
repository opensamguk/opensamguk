import { useCallback, useEffect, useRef, useState } from 'react';
import type { BattleRunBody, BattleRunErrorCode, BattleRunReply, BattleRunRequest, BattleRunResult } from './request';

// Worker의 쓰는 부분만. 단위 시험은 이 모양의 가짜를 주입해 상태 전이만 본다. 진짜 Worker 실행은 Chromium E2E가 본다.
export interface WorkerLike {
  postMessage(message: BattleRunRequest): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
}

export function createBattleWorker(): WorkerLike {
  // Vite가 이 줄을 보고 battle.worker를 같은 출처의 별도 파일로 묶는다. blob:·data: Worker는 쓰지 않는다.
  return new Worker(new URL('./battle.worker.ts', import.meta.url), { type: 'module', name: 'battle' });
}

export type BattleWorkerState =
  | { status: 'idle' }
  | { status: 'running'; requestId: number }
  | { status: 'done'; result: BattleRunResult }
  | { status: 'error'; code: BattleRunErrorCode | 'WORKER'; field?: string };

// Worker 하나와 요청 번호를 맡는다 (docs/plans/T4-34.md 수명).
// 실행마다 requestId를 늘리고 그 번호의 답만 받는다. 취소·오류·언마운트 때 Worker를 끝내고 다음 실행에 새로 만든다.
export function useBattleWorker(create: () => WorkerLike = createBattleWorker) {
  const [state, setState] = useState<BattleWorkerState>({ status: 'idle' });
  const workerRef = useRef<WorkerLike | null>(null);
  const lastIdRef = useRef(0);
  const currentRef = useRef<number | null>(null);
  const lastBodyRef = useRef<BattleRunBody | null>(null);
  const mountedRef = useRef(true);

  const stop = useCallback(() => {
    const worker = workerRef.current;
    workerRef.current = null;
    currentRef.current = null;
    worker?.terminate();
  }, []);

  const fail = useCallback(
    (worker: WorkerLike, code: BattleRunErrorCode | 'WORKER', field?: string) => {
      if (workerRef.current !== worker || !mountedRef.current) return;
      stop();
      setState(field === undefined ? { status: 'error', code } : { status: 'error', code, field });
    },
    [stop],
  );

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    const worker = create();
    workerRef.current = worker;
    worker.addEventListener('message', (event) => {
      if (workerRef.current !== worker || !mountedRef.current) return;
      const reply = event.data as BattleRunReply | null;
      if (!reply || typeof reply !== 'object' || reply.requestId !== currentRef.current) return;
      if (reply.type === 'result') {
        currentRef.current = null;
        setState({ status: 'done', result: reply });
      } else {
        fail(worker, reply.code, reply.field);
      }
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      fail(worker, 'WORKER');
    });
    worker.addEventListener('messageerror', () => fail(worker, 'WORKER'));
    return worker;
  }, [create, fail]);

  const run = useCallback(
    (body: BattleRunBody) => {
      lastBodyRef.current = body;
      const worker = ensureWorker();
      const requestId = ++lastIdRef.current;
      currentRef.current = requestId;
      setState({ status: 'running', requestId });
      worker.postMessage({ type: 'run', requestId, ...body });
    },
    [ensureWorker],
  );

  const cancel = useCallback(() => {
    stop();
    setState({ status: 'idle' });
  }, [stop]);

  // 마지막으로 보낸 입력과 시드를 새 Worker로 다시 보낸다.
  const retry = useCallback(() => {
    if (lastBodyRef.current) run(lastBodyRef.current);
  }, [run]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  return { state, run, cancel, retry };
}
