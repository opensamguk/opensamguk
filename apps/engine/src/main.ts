import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@opensamguk/db';
import { acquireLease, LEASE_TTL_MS, LeaseLostError, releaseLease, renewLease } from './lease';
import { TurnLoop } from './turnLoop';

export function engineFailureMessage(error: unknown): string {
  if (error instanceof LeaseLostError) return `[engine] ${error.name}: ${error.message}`;
  // 연결 문자열을 포함할 수 있는 원본 DB 오류는 노출하지 않는다.
  return '[engine] 실행 실패. 월드 ID·DB 연결·migration·실행권을 확인하세요.';
}

export async function runEngine(db: PrismaClient, options: { worldId?: string; signal: AbortSignal;
  onStatus?: (status: string) => void }) {
  const { signal } = options;
  let lastStatus: string | undefined;
  const report = (status: string) => {
    if (status !== lastStatus) options.onStatus?.(status);
    lastStatus = status;
  };
  const wait = async (ms: number) => {
    try { await delay(ms, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  };
  let worldId = options.worldId;
  while (!signal.aborted) {
    if (!worldId) {
      worldId = (await db.world.findFirst({ where: { status: 'RUNNING' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))?.id;
      if (!worldId) { await wait(1000); continue; }
    }
    const lease = await acquireLease(db, worldId);
    if (!lease) { report('리스 대기'); await wait(1000); continue; }
    report('실행권 획득');
    const loop = new TurnLoop(db, lease);
    const session = new AbortController();
    const forwardAbort = () => session.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    let renewalError: unknown;
    // setInterval의 겹친 갱신·미처리 rejection을 피한다.
    const renewal = (async () => {
      while (!session.signal.aborted) {
        try { await delay(LEASE_TTL_MS / 3, undefined, { signal: session.signal }); }
        catch { break; }
        if (session.signal.aborted) break;
        try { await renewLease(db, lease); }
        catch (error) { renewalError = error; session.abort(); }
      }
    })();
    try {
      while (!session.signal.aborted) {
        await loop.poll(session.signal);
        try { await delay(100, undefined, { signal: session.signal }); }
        catch { break; }
      }
      if (renewalError) throw renewalError;
      return;
    } catch (error) {
      if (!signal.aborted) throw error;
      return;
    } finally {
      session.abort();
      signal.removeEventListener('abort', forwardAbort);
      await renewal;
      await releaseLease(db, lease);
      report('실행권 해제');
    }
  }
}
