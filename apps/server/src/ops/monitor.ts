import type { PrismaClient } from '@opensamguk/db';
import { statfs } from 'node:fs/promises';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import { sendDiscordWebhook } from '../notifications/discordWebhook';
import {
  CAPACITY_POLL_MS,
  CAPACITY_READ_MS,
  CAPACITY_REPEAT_MS,
  evaluateDatabaseCapacity,
  evaluateDiskCapacity,
  readDatabaseCapacity,
  type CapacityLevel,
  type CapacityMonitorConfig,
  type CapacitySample,
  type DiskSpace,
} from './capacity';

type NoticeKind = Exclude<CapacityLevel, 'healthy'> | 'recovered';
type NoticeState = { alerting: boolean; attempted: NoticeKind | null; attemptedAt: number };
export type CapacityMonitorDependencies = {
  readDisk(path: string): Promise<DiskSpace>;
  readDatabase(): Promise<bigint>;
  notify(webhook: string, content: string, signal: AbortSignal): Promise<boolean>;
  failure(): void;
  now(): number;
};

export function createCapacityMonitor(config: CapacityMonitorConfig, dependencies: CapacityMonitorDependencies) {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const states = new Map<string, NoticeState>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let current: Promise<void> | undefined;
  let closing = false;
  let stopPromise: Promise<void> | undefined;

  function failure(): void {
    try {
      dependencies.failure();
    } catch {
      /* 감시 진단 실패는 게임 요청으로 전파하지 않는다. */
    }
  }

  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(() => {
      if (closing) throw new Error('용량 감시가 종료 중입니다.');
      return operation();
    });
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }

  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        track(operation),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('용량 감시 조회가 늦어졌습니다.')), CAPACITY_READ_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function observe(key: string, read: () => Promise<CapacitySample>): Promise<void> {
    let sample: CapacitySample;
    try {
      sample = await bounded(read);
    } catch {
      sample = { level: 'unavailable' };
      failure();
    }
    if (closing) return;
    const now = dependencies.now();
    if (!Number.isFinite(now) || now < 0) {
      failure();
      return;
    }
    const state = states.get(key) ?? { alerting: false, attempted: null, attemptedAt: 0 };
    if (sample.level === 'healthy' && !state.alerting) return;
    const kind = sample.level === 'healthy' ? 'recovered' : sample.level;
    if (kind === state.attempted && now - state.attemptedAt < CAPACITY_REPEAT_MS) return;
    state.attempted = kind;
    state.attemptedAt = now;
    if (kind !== 'recovered') state.alerting = true;
    states.set(key, state);
    const label = { warning: '경고', critical: '위험', unavailable: '조회 실패', recovered: '회복' }[kind];
    const content =
      `opensamguk 용량 감시\n대상 ${key}\n상태 ${label}` +
      (sample.bytes === undefined ? '' : `\n사용 바이트 ${sample.bytes}`) +
      (sample.usedPercent === undefined ? '' : `\n사용률 ${sample.usedPercent}%`);
    try {
      const delivered = await track(() => dependencies.notify(config.webhook, content, controller.signal));
      if (!delivered) failure();
      else if (kind === 'recovered') state.alerting = false;
    } catch {
      failure();
    }
  }

  function poll(): Promise<void> {
    if (closing || current || pending.size > 0) return current ?? Promise.resolve();
    const tasks = [
      ...config.paths.map((path, index) =>
        observe(`disk-${index + 1}`, async () => evaluateDiskCapacity(await dependencies.readDisk(path))),
      ),
      observe('database', async () =>
        evaluateDatabaseCapacity(await dependencies.readDatabase(), config.databaseWarnBytes),
      ),
    ];
    const running = Promise.allSettled(tasks).then((results) => {
      if (results.some((result) => result.status === 'rejected')) failure();
    });
    current = running;
    void running.then(() => {
      if (current === running) current = undefined;
    });
    return running;
  }

  function start(): void {
    if (closing || timer) return;
    timer = setInterval(() => {
      void poll();
    }, CAPACITY_POLL_MS);
    timer.unref();
    void poll();
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    closing = true;
    clearInterval(timer);
    controller.abort();
    stopPromise = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = (async () => {
          if (current) await current;
          while (pending.size > 0) await Promise.allSettled([...pending]);
        })();
        await Promise.race([
          settled,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('용량 감시 종료를 확인하지 못했습니다.')), CAPACITY_READ_MS);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    })();
    return stopPromise;
  }
  return { poll, start, stop };
}

async function notifyCapacity(webhook: string, content: string, signal: AbortSignal): Promise<boolean> {
  const transports: Promise<Response>[] = [];
  try {
    const result = await sendDiscordWebhook(
      { url: webhook, content },
      {
        transport: (url, init) => {
          const operation = (async () => {
            const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, init.signal]) });
            await response.body?.cancel();
            return new Response(null, { status: response.status, headers: response.headers });
          })();
          transports.push(operation);
          return operation;
        },
      },
    );
    return result.kind === 'HTTP_OBSERVED' && result.status >= 200 && result.status < 300;
  } finally {
    // 기존 sender의 제한 시간이 먼저 끝나도 실제 transport 정착은 따로 기다린다.
    await Promise.allSettled(transports);
  }
}

export function registerCapacityMonitor<L extends FastifyBaseLogger>(
  server: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    L
  >,
  db: PrismaClient,
  config: CapacityMonitorConfig | null,
): void {
  if (config === null) return;
  const monitor = createCapacityMonitor(config, {
    readDisk: (path) => statfs(path, { bigint: true }),
    readDatabase: () => readDatabaseCapacity(db),
    notify: notifyCapacity,
    failure: () => server.log.warn('운영 용량 감시를 확인하지 못했습니다.'),
    now: () => performance.now(),
  });
  server.addHook('onReady', async () => monitor.start());
  server.addHook('preClose', async () => monitor.stop());
}
