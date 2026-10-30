// INT-11 실제 시험 전용 수명 경계. 게임 상태나 실행 결과를 만드는 도구가 아니다.
export class DeadlineError extends Error {}

export async function bounded<T>(label: string, work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(label)), Math.max(1, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Task = { label: string; settled: boolean; failed: boolean; reason?: unknown; done: Promise<void> };
export class WorkScope {
  readonly controller = new AbortController();
  readonly tasks: Task[] = [];
  get signal() {
    return this.controller.signal;
  }
  check() {
    this.signal.throwIfAborted();
  }
  cancel() {
    this.controller.abort(new Error('시험 작업을 취소했습니다.'));
  }
  retain<T>(label: string, work: PromiseLike<T>): Promise<T> {
    const task: Task = { label, settled: false, failed: false, done: Promise.resolve() };
    const result = Promise.resolve(work);
    task.done = result.then(
      () => {
        task.settled = true;
      },
      (reason: unknown) => {
        task.failed = true;
        task.reason = reason;
        task.settled = true;
      },
    );
    this.tasks.push(task);
    return result;
  }
  async work<T>(label: string, work: () => PromiseLike<T>, after?: (value: T) => void, checkAfter = true): Promise<T> {
    this.check();
    const result = await this.retain(label, work());
    after?.(result); // 취소와 commit이 겹쳐도 생성된 자원의 식별자를 먼저 남긴다.
    if (checkAfter) this.check();
    return result;
  }
  async cancellable<T>(work: Promise<T>): Promise<T> {
    void work.catch(() => {});
    this.check();
    let listener: () => void = () => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          listener = () => reject(this.signal.reason);
          this.signal.addEventListener('abort', listener, { once: true });
          if (this.signal.aborted) listener();
        }),
      ]);
    } finally {
      this.signal.removeEventListener('abort', listener);
    }
  }
  async settle(ms: number) {
    const until = Date.now() + ms;
    let index = 0;
    while (index < this.tasks.length) {
      if (Date.now() >= until) throw new DeadlineError('시험 본문·SQL·route 정착 한도');
      const batch = this.tasks.slice(index);
      index += batch.length;
      await bounded('시험 본문·SQL·route 정착 한도', Promise.all(batch.map((t) => t.done)), until - Date.now());
    }
    return this.summary();
  }
  isExpectedCancellation(reason: unknown) {
    return this.signal.aborted && reason === this.signal.reason;
  }
  summary(formatReason: (reason: unknown) => string = () => '[reason retained; details redacted]') {
    return this.tasks.map(({ label, settled, failed, reason }) => {
      let failure: string | undefined;
      if (failed) {
        try {
          failure = formatReason(reason);
        } catch {
          failure = '[reason formatting failed]';
        }
      }
      return { label, settled, failed, expectedCancellation: failed && this.isExpectedCancellation(reason), failure };
    });
  }
  failures(formatReason?: (reason: unknown) => string) {
    return this.summary(formatReason).filter((task) => task.failed && !task.expectedCancellation);
  }
}

// Prisma의 callback transaction과 model 호출에만 쓴다. array transaction은 이 시험에서 사용하지 않는다.
export function guardedDb<T extends object>(target: T, scope: WorkScope): T {
  const cache = new WeakMap<object, object>();
  const wrap = (object: object): object => {
    const cached = cache.get(object);
    if (cached) return cached;
    const proxy = new Proxy(object, {
      get(value, key) {
        const member = Reflect.get(value, key);
        if (typeof member === 'function')
          return (...args: unknown[]) => {
            scope.check();
            if (key === '$transaction') {
              if (typeof args[0] !== 'function') throw new Error('시험은 callback transaction만 사용합니다.');
              const callback = args[0] as (tx: object) => unknown;
              args[0] = (tx: object) => {
                scope.check();
                return callback(wrap(tx));
              };
            }
            // commit 직후 abort되어도 상위 생성 코드가 UUID를 기록할 수 있게 한다.
            return scope.work(
              String(key),
              () => Promise.resolve(Reflect.apply(member, value, args)),
              undefined,
              key !== '$transaction',
            );
          };
        if (member && typeof member === 'object' && !String(key).startsWith('_')) return wrap(member);
        return member;
      },
    });
    cache.set(object, proxy);
    return proxy;
  };
  return wrap(target) as T;
}

// Playwright는 Page/Locator의 내부 메서드도 쓰므로 원래 receiver와 constructor를 보존한다.
export function guardedUi<T extends object>(target: T, scope: WorkScope): T {
  const cache = new WeakMap<object, object>();
  const names = new Set([
    'Page',
    'Locator',
    'FrameLocator',
    'Frame',
    'ElementHandle',
    'BrowserContext',
    'APIRequestContext',
    'APIResponse',
    'Response',
  ]);
  const wrap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || !names.has(value.constructor.name)) return value;
    const cached = cache.get(value);
    if (cached) return cached;
    const proxy = new Proxy(value, {
      get(object, key) {
        const member = Reflect.get(object, key);
        if (key === 'constructor' || typeof key === 'symbol') return member;
        if (typeof member !== 'function') return String(key).startsWith('_') ? member : wrap(member);
        return (...args: unknown[]) => {
          scope.check();
          const result = Reflect.apply(member, object, args);
          if (
            result &&
            (typeof result === 'object' || typeof result === 'function') &&
            'then' in result &&
            typeof result.then === 'function'
          )
            return scope.work('UI ' + String(key), () => Promise.resolve(result as PromiseLike<unknown>)).then(wrap);
          return wrap(result);
        };
      },
    });
    cache.set(value, proxy);
    return proxy;
  };
  return wrap(target) as T;
}

export type AuditInput = {
  beforeCreateAbsent: boolean;
  createAttempted: boolean;
  createdOid?: string | undefined;
  bodyPassed: boolean;
  processTreeClosed: boolean;
  otherCleanupVerified: boolean;
};
export interface AuditPort {
  catalog(): Promise<Array<{ oid: string }>>;
  activity(): Promise<number>;
  drop(): Promise<void>;
  disconnect(): Promise<void>;
}
export async function auditOwnedDatabase(input: AuditInput, port: AuditPort, timeoutMs = 5000) {
  const result = {
    catalogAttempted: false,
    activityAttempted: false,
    disconnectAttempted: false,
    catalogKnown: false,
    activityKnown: false,
    oid: undefined as string | undefined,
    connections: undefined as number | undefined,
    absent: false,
    dropSucceeded: false,
    afterDropAbsent: false,
    disconnected: false,
    preDropCatalogAttempted: false,
    preDropCatalogKnown: false,
    preDropOid: undefined as string | undefined,
    preDropSameOid: false,
    errors: [] as string[],
  };
  // 모든 경로에서 두 감사를 독립 시작한다. 앞 단계 오류나 누락된 CREATE 응답으로 건너뛰지 않는다.
  await Promise.all([
    (async () => {
      result.catalogAttempted = true;
      try {
        const rows = await bounded('catalog audit', port.catalog(), timeoutMs);
        if (rows.length > 1) throw new Error('catalog shape');
        result.catalogKnown = true;
        result.absent = rows.length === 0;
        result.oid = rows[0]?.oid;
      } catch {
        result.errors.push('catalog audit uncertain');
      }
    })(),
    (async () => {
      result.activityAttempted = true;
      try {
        result.connections = await bounded('activity audit', port.activity(), timeoutMs);
        result.activityKnown = true;
      } catch {
        result.errors.push('activity audit uncertain');
      }
    })(),
  ]);
  try {
    if (
      input.bodyPassed &&
      input.processTreeClosed &&
      input.otherCleanupVerified &&
      input.beforeCreateAbsent &&
      input.createAttempted &&
      input.createdOid &&
      result.oid === input.createdOid &&
      result.activityKnown &&
      result.connections === 0
    ) {
      result.preDropCatalogAttempted = true;
      const rows = await bounded('pre DROP catalog', port.catalog(), timeoutMs);
      result.preDropCatalogKnown = true;
      result.preDropOid = rows[0]?.oid;
      result.preDropSameOid = rows.length === 1 && rows[0]!.oid === input.createdOid;
      if (!result.preDropSameOid) result.errors.push('pre DROP OID changed or absent; preserve database');
      else {
        await bounded('normal DROP', port.drop(), timeoutMs);
        result.dropSucceeded = true;
        result.afterDropAbsent = (await bounded('post DROP catalog', port.catalog(), timeoutMs)).length === 0;
        if (!result.afterDropAbsent) result.errors.push('post DROP not absent');
      }
    }
  } catch {
    result.errors.push('DROP audit uncertain');
  } finally {
    result.disconnectAttempted = true;
    try {
      await bounded('admin disconnect', port.disconnect(), timeoutMs);
      result.disconnected = true;
    } catch {
      result.errors.push('admin disconnect uncertain');
    }
  }
  return result;
}

export function cleanupVerified(proof: {
  tasksSettled: boolean;
  treesEmpty: boolean;
  streamsClosed: boolean;
  guardianClosed: boolean;
  portsFree: boolean;
  adminsDisconnected: boolean;
  databaseAbsent: boolean;
  sourceUnchanged: boolean;
}) {
  return Object.values(proof).every((value) => value === true);
}

export function mayDeleteFixtureRows(proof: {
  bodyPassed: boolean;
  hadFailure: boolean;
  tasksSettled: boolean;
  renewalsSettled: boolean;
  contextsClosed: boolean;
  ownershipCertain: boolean;
}) {
  return (
    proof.bodyPassed &&
    !proof.hadFailure &&
    proof.tasksSettled &&
    proof.renewalsSettled &&
    proof.contextsClosed &&
    proof.ownershipCertain
  );
}
