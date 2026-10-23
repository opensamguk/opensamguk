const PATHS = ['/healthz', '/healthz/engine'] as const;
type HealthPath = (typeof PATHS)[number];
type TargetResult = { path: HealthPath } & (
  { outcome: 'ok' | 'status' | 'redirect'; status: number } | { outcome: 'timeout' | 'network' }
);
type ProbeResult = { ok: boolean; targets: TargetResult[] };

async function probeTarget(path: HealthPath, origin: string, timeoutMs: number): Promise<TargetResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(new URL(path, origin), { method: 'GET', redirect: 'manual', signal });
    const status = response.status;
    const outcome = status === 200 ? 'ok' : status >= 300 && status < 400 ? 'redirect' : 'status';
    try {
      await response.body?.cancel();
    } catch {
      // The status was received; discarding its body cannot change that observation.
    }
    return { path, outcome, status };
  } catch {
    return { path, outcome: signal.aborted ? 'timeout' : 'network' };
  }
}

export async function probeHealth({ baseUrl, timeoutMs }: { baseUrl: URL; timeoutMs: number }): Promise<ProbeResult> {
  const origin = baseUrl.origin;
  const targets = await Promise.all(PATHS.map((path) => probeTarget(path, origin, timeoutMs)));
  return { ok: targets.every((target) => target.outcome === 'ok'), targets };
}
