import { sha } from './schema';

export async function probeHttp(baseUrl: string, claimedSourceSHA: string) {
  sha(claimedSourceSHA);
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    !['http:', 'https:'].includes(base.protocol)
  )
    throw new Error('INVALID_ORIGIN');
  if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
    throw new Error('HTTPS_REQUIRED');
  async function get(path: string) {
    const response = await fetch(new URL(`/trpc/${path}`, base), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    // No response, URL, header, cookie or server error text is written to evidence.
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_RESPONSE');
    return { status: response.status, body: raw as Record<string, unknown> };
  }
  const health = await get('health');
  const result = health.body.result as { data?: { server?: unknown; db?: unknown } } | undefined;
  const world = await get('world.list');
  const error = world.body.error as { data?: { code?: unknown } } | undefined;
  const healthy = health.status === 200 && result?.data?.server === 'ok' && result.data.db === 'ok';
  const unauthorized = world.status === 401 && error?.data?.code === 'UNAUTHORIZED';
  return {
    version: 1,
    kind: 'http-probe',
    toolStatus: healthy && unauthorized ? 'VALID' : 'INVALID',
    productStatus: 'NOT_READY',
    acStatus: 'NOT_ASSESSED',
    claimedSourceSHA,
    sourceVerification: 'OPERATOR_CLAIM_ONLY',
    checks: { serverAndDatabase: healthy, unauthenticatedWorldDenied: unauthorized },
    notReadyReasons: [
      'HTTP_PROBE_IS_NOT_PARTICIPATION',
      'NATIVE_PARTICIPANTS_NOT_COLLECTED',
      'SERVER_SHA_REQUIRES_DEPLOYMENT_EVIDENCE',
    ],
    notice:
      'A read-only HTTP/database probe is not an independent-agent season or public rehearsal. No game state was initialized or changed.',
  };
}
