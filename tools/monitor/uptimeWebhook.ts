import type { PendingNotice } from './uptimeState';

export type UptimeDelivery =
  { outcome: 'ok' | 'status' | 'redirect'; status: number } | { outcome: 'timeout' | 'network' };

/** 호출자가 검증한 주소만 받는다. 운영 URL 검사는 runUptime 경계에 둔다. */
export async function sendUptimeNotice({
  endpoint,
  notice,
  timeoutMs,
}: {
  endpoint: URL;
  notice: PendingNotice;
  timeoutMs: number;
}): Promise<UptimeDelivery> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new RangeError('invalid_timeout');
  const content = `opensamguk ${notice.kind === 'down' ? '장애' : '회복'}\n${notice.id}\n${notice.decidedAt}`;
  if (content.length > 2000) throw new RangeError('invalid_notice');
  const url = new URL(endpoint);
  // Discord의 기본 wait=false는 저장되지 않은 메시지에도 오류를 주지 않을 수 있다.
  url.searchParams.set('wait', 'true');
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      redirect: 'manual',
      signal,
    });
    const status = response.status;
    try {
      await response.body?.cancel();
    } catch {
      // 본문과 서버 오류 원문은 읽지 않는다. 받은 상태 코드만 판정한다.
    }
    return {
      outcome: status >= 200 && status < 300 ? 'ok' : status >= 300 && status < 400 ? 'redirect' : 'status',
      status,
    };
  } catch {
    return { outcome: signal.aborted ? 'timeout' : 'network' };
  }
}
