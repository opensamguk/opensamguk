import { UPTIME_REF, updateUptimeGit, type UptimeGitDependencies, type UptimeGitInput } from './uptimeGit';
import { probeHealth } from './uptimeProbe';
import { nextDelivery, restoreState, serializeState, UPTIME_LIMITS, type StateWarning } from './uptimeState';
import { sendUptimeNotice } from './uptimeWebhook';
import { validateUptimeToken } from './uptimeGitAuth';

export interface UptimeRunConfig {
  stateRef: string;
  publicUrl: string;
  remote: string;
  key: string;
  runId: string;
  runAttempt: string;
  webhook: string;
}
export interface UptimeRunDependencies {
  /** 운영 인증과 신뢰한 시험 의존을 연결한다. 시험 경로·명령은 CLI에서 받지 않는다. */
  git?: UptimeGitDependencies;
  clock?: () => number;
  probe?: typeof probeHealth;
  send?: typeof sendUptimeNotice;
}
type Warning = StateWarning | { code: 'pending_dropped'; reason: 'ttl' | 'cap' };
export class UptimeRunError extends Error {
  constructor(
    readonly kind: 'configuration' | 'clock' | 'probe' | 'git' | 'delivery',
    readonly warnings: Warning[] = [],
  ) {
    super(`가동 확인 실행 실패 (${kind}).`);
    this.name = 'UptimeRunError';
  }
}
function check(value: unknown): asserts value {
  if (!value) throw new UptimeRunError('configuration');
}
function https(value: string): URL {
  try {
    check(typeof value === 'string' && value.startsWith('https://'));
    check(
      !/[\\?#\s]/.test(value) &&
        ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
    );
    const url = new URL(value);
    check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
    return url;
  } catch {
    throw new UptimeRunError('configuration');
  }
}

export function validateUptimeRunConfig(config: UptimeRunConfig) {
  check(config.stateRef === UPTIME_REF);
  if (config.publicUrl === '') return { mode: 'disabled' as const };
  const publicUrl = https(config.publicUrl),
    remote = https(config.remote);
  check(publicUrl.pathname === '/' && remote.pathname !== '/');
  check(config.key === 'prod' || /^drill-[A-Za-z0-9_-]{1,64}$/.test(config.key));
  for (const value of [config.runId, config.runAttempt])
    check(typeof value === 'string' && /^[1-9][0-9]*$/.test(value));
  const webhook = config.webhook === '' ? null : https(config.webhook);
  if (webhook)
    check(
      webhook.hostname === 'discord.com' &&
        !webhook.port &&
        /^\/api(?:\/v[1-9][0-9]*)?\/webhooks\/[1-9][0-9]*\/[^/]+$/.test(webhook.pathname),
    );
  return { mode: 'enabled' as const, publicUrl, webhook };
}

export async function runUptime(config: UptimeRunConfig, dependencies: UptimeRunDependencies = {}) {
  const validated = validateUptimeRunConfig(config);
  if (validated.mode === 'disabled') return validated;
  if (dependencies.git?.httpsToken !== undefined) {
    try {
      validateUptimeToken(dependencies.git.httpsToken);
      check(dependencies.git.localRemote === undefined);
    } catch {
      throw new UptimeRunError('configuration');
    }
  }
  const { publicUrl, webhook } = validated;
  const warnings: Warning[] = [];
  const time = () => {
    try {
      const now = (dependencies.clock ?? Date.now)();
      if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new Error();
      return now;
    } catch {
      throw new UptimeRunError('clock', warnings);
    }
  };
  const persist = async (operation: UptimeGitInput['operation']) => {
    try {
      return await updateUptimeGit(
        { remote: config.remote, stateRef: config.stateRef, key: config.key, operation },
        dependencies.git,
      );
    } catch {
      throw new UptimeRunError('git', warnings);
    }
  };
  let health: Awaited<ReturnType<typeof probeHealth>>;
  try {
    health = await (dependencies.probe ?? probeHealth)({ baseUrl: publicUrl, timeoutMs: UPTIME_LIMITS.probeTimeoutMs });
  } catch {
    throw new UptimeRunError('probe');
  }
  const now = time();
  const observed = await persist({
    kind: 'observe',
    observation: {
      key: config.key,
      runId: config.runId,
      runAttempt: config.runAttempt,
      now,
      ok: health.ok,
      webhookConfigured: webhook !== null,
    },
  });
  if (observed.result !== 'applied' && observed.result !== 'skipped') throw new UptimeRunError('git');
  let state = observed.state,
    delivered = 0;
  warnings.push(
    ...observed.warnings,
    ...observed.dropped.map((item) => ({ code: 'pending_dropped' as const, reason: item.reason })),
  );
  const seen = new Set<string>();
  for (let index = 0; webhook && index < UPTIME_LIMITS.maxPending; index++) {
    const deliveryNow = time();
    if ('error' in restoreState({ key: config.key, raw: serializeState(state), now: deliveryNow }))
      throw new UptimeRunError('clock', warnings);
    const notice = nextDelivery(state, { now: deliveryNow });
    if (!notice) break;
    if (seen.has(notice.id)) throw new UptimeRunError('delivery', warnings);
    seen.add(notice.id);
    let delivery: Awaited<ReturnType<typeof sendUptimeNotice>>;
    try {
      delivery = await (dependencies.send ?? sendUptimeNotice)({
        endpoint: webhook,
        notice,
        timeoutMs: UPTIME_LIMITS.probeTimeoutMs,
      });
    } catch {
      throw new UptimeRunError('delivery', warnings);
    }
    const result = await persist({
      kind: delivery.outcome === 'ok' ? 'ack' : 'attemptFailure',
      id: notice.id,
      now: time(),
    });
    if (delivery.outcome !== 'ok') throw new UptimeRunError('delivery', warnings);
    if (result.result !== 'removed' && result.result !== 'already_removed') throw new UptimeRunError('git', warnings);
    state = result.state;
    warnings.push(...result.warnings);
    delivered++;
  }
  return {
    mode: 'observed' as const,
    healthy: health.ok,
    observation: observed.result,
    delivered,
    pending: state.pending.length,
    warnings,
  };
}
