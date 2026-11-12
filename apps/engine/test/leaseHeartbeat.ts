import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@opensamguk/db';
import { onTestFinished } from 'vitest';
import { renewLease, type Lease } from '../src/lease';

// TurnLoop를 직접 실행하는 긴 시험에서도 엔진 프로세스와 같은 주기로 실행권을 갱신한다.
export function renewLeaseDuringTest(db: PrismaClient, lease: Lease): void {
  const stop = new AbortController();
  let renewalError: unknown;
  const renewal = (async () => {
    while (!stop.signal.aborted) {
      try {
        await delay(lease.ttlMs / 3, undefined, { signal: stop.signal, ref: false });
      } catch {
        return;
      }
      if (stop.signal.aborted) return;
      await renewLease(db, lease);
    }
  })().catch((error: unknown) => {
    renewalError = error;
  });
  onTestFinished(async () => {
    stop.abort();
    await renewal;
    if (renewalError !== undefined) throw renewalError;
  });
}
