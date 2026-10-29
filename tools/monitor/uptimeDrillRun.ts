import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isAbsolute } from 'node:path';
import type { AddressInfo } from 'node:net';
import { UPTIME_REF, updateUptimeGit, type UptimeGitDependencies } from './uptimeGit';
import { validateUptimeToken } from './uptimeGitAuth';
import { probeHealth } from './uptimeProbe';
import { UPTIME_LIMITS } from './uptimeState';

export interface UptimeDrillConfig {
  key: string;
  status: string;
  stateRef: string;
  remote: string;
  runId: string;
  runAttempt: string;
}
export class UptimeDrillError extends Error {
  constructor(readonly kind: 'configuration' | 'clock' | 'listener' | 'probe' | 'git' | 'cleanup') {
    super(`가동 확인 연습 실패 (${kind}).`);
    this.name = 'UptimeDrillError';
  }
}
const controls = (value: string) => [...value].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127);
function requireConfig(value: unknown): asserts value {
  if (!value) throw new UptimeDrillError('configuration');
}
export function validateUptimeDrill(config: UptimeDrillConfig, git: UptimeGitDependencies) {
  requireConfig(typeof config.key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(config.key));
  requireConfig(config.status === '200' || config.status === '500');
  requireConfig(config.stateRef === UPTIME_REF);
  requireConfig(
    typeof config.remote === 'string' &&
      config.remote.startsWith('https://') &&
      !/[\\?#]/.test(config.remote) &&
      !controls(config.remote),
  );
  let remote: URL;
  try {
    remote = new URL(config.remote);
  } catch {
    throw new UptimeDrillError('configuration');
  }
  requireConfig(
    remote.protocol === 'https:' &&
      !remote.username &&
      !remote.password &&
      !remote.search &&
      !remote.hash &&
      remote.hostname &&
      remote.pathname !== '/',
  );
  for (const value of [config.runId, config.runAttempt])
    requireConfig(typeof value === 'string' && /^[1-9][0-9]*$/.test(value));
  if (git.httpsToken !== undefined) {
    try {
      validateUptimeToken(git.httpsToken);
    } catch {
      throw new UptimeDrillError('configuration');
    }
    requireConfig(git.localRemote === undefined);
  } else
    requireConfig(
      typeof git.localRemote === 'string' &&
        isAbsolute(git.localRemote) &&
        ![...git.localRemote].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    );
  return { key: 'drill-' + config.key, status: Number(config.status) as 200 | 500 };
}
export function readUptimeDrillConfig(env: NodeJS.ProcessEnv) {
  const config: UptimeDrillConfig = {
    key: env.DRILL_KEY ?? '',
    status: env.DRILL_STATUS ?? '',
    stateRef: env.UPTIME_STATE_REF ?? '',
    remote: env.UPTIME_GIT_REMOTE ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '',
  };
  const git = { httpsToken: env.UPTIME_GIT_TOKEN ?? '' };
  validateUptimeDrill(config, git);
  return { config, git };
}
async function listen(status: 200 | 500): Promise<Server> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const server = createServer((request, response) => {
      const known = request.method === 'GET' && ['/healthz', '/healthz/engine'].includes(request.url ?? '');
      response.writeHead(known ? status : 404, { 'Content-Type': 'text/plain', Connection: 'close' });
      response.end('uptime drill');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once('error', failed);
        server.listen(randomInt(10_081, 65_536), '127.0.0.1', () => {
          server.removeListener('error', failed);
          resolve();
        });
      });
      return server;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw new UptimeDrillError('listener');
    }
  }
  throw new UptimeDrillError('listener');
}
export async function runUptimeDrill(
  config: UptimeDrillConfig,
  dependencies: {
    git: UptimeGitDependencies;
    clock?: () => number;
    /** 신뢰한 시험의 관측 전용이다. CLI·환경·HTTP 입력에서 받지 않는다. */
    onListen?: (port: number) => void;
    onClosed?: () => void;
  },
) {
  const validated = validateUptimeDrill(config, dependencies.git);
  const time = () => {
    let now: number;
    try {
      now = (dependencies.clock ?? Date.now)();
    } catch {
      throw new UptimeDrillError('clock');
    }
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new UptimeDrillError('clock');
    return now;
  };
  time();
  const server = await listen(validated.status);
  let failure: unknown, result: Awaited<ReturnType<typeof updateUptimeGit>> | undefined;
  let targets: Awaited<ReturnType<typeof probeHealth>>['targets'] = [];
  try {
    const { port } = server.address() as AddressInfo;
    dependencies.onListen?.(port);
    const health = await probeHealth({
      baseUrl: new URL('http://127.0.0.1:' + port),
      timeoutMs: UPTIME_LIMITS.probeTimeoutMs,
    });
    targets = health.targets;
    if (
      !health.targets.every((target) => 'status' in target && target.status === validated.status) ||
      health.ok !== (validated.status === 200)
    )
      throw new UptimeDrillError('probe');
    try {
      result = await updateUptimeGit(
        {
          remote: config.remote,
          stateRef: config.stateRef,
          key: validated.key,
          operation: {
            kind: 'observe',
            observation: {
              key: validated.key,
              runId: config.runId,
              runAttempt: config.runAttempt,
              now: time(),
              ok: health.ok,
              webhookConfigured: false,
            },
          },
        },
        dependencies.git,
      );
    } catch (error) {
      throw error instanceof UptimeDrillError ? error : new UptimeDrillError('git');
    }
    if (!['applied', 'skipped'].includes(result.result)) throw new UptimeDrillError('git');
  } catch (error) {
    failure = error instanceof UptimeDrillError ? error : new UptimeDrillError('listener');
  }
  try {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    dependencies.onClosed?.();
  } catch {
    failure = failure
      ? new AggregateError([failure, new UptimeDrillError('cleanup')], '가동 확인 연습과 정리 실패.')
      : new UptimeDrillError('cleanup');
  }
  if (failure) throw failure;
  return {
    mode: 'drill' as const,
    key: validated.key,
    runId: config.runId,
    runAttempt: config.runAttempt,
    status: validated.status,
    targets,
    observation: result!.result,
    decision: result!.decision,
    consecutiveFailures: result!.state.consecutiveFailures,
    alerting: result!.state.alerting,
    lastRunId: result!.state.lastRunId,
    head: result!.head,
    committed: result!.committed,
  };
}
