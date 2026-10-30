import { afterEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../packages/db/src/index';
import type { BrowserContext, Page } from '@playwright/test';
import { OfferFixture, assertCleanupPassed } from '../e2e/campaign-offer-fixture';
import {
  WorkScope,
  guardedDb,
  guardedUi,
  bounded,
  auditOwnedDatabase,
  cleanupVerified,
  mayDeleteFixtureRows,
  type AuditPort,
} from './campaign-offer-lifetime';

afterEach(() => vi.useRealTimers());
const latch = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
it('취소 뒤 늦게 끝난 SQL 결과가 다음 SQL이나 engine 시작으로 이어지지 않는다', async () => {
  const scope = new WorkScope(),
    gate = latch<number>();
  const read = vi.fn(() => gate.promise),
    write = vi.fn(async () => 1);
  const db = guardedDb({ model: { read, write } }, scope);
  const body = scope.work('body', async () => {
    await db.model.read();
    await db.model.write();
  });
  scope.cancel();
  gate.resolve(1);
  await expect(body).rejects.toThrow('취소');
  await scope.settle(100);
  expect(read).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
});
it('진행 중인 engine에는 같은 AbortSignal을 전달하고 정착 전에는 삭제하지 않는다', async () => {
  const scope = new WorkScope();
  let stopped = false;
  const engine = scope.work(
    'engine',
    () =>
      new Promise<void>((resolve) => {
        scope.signal.addEventListener(
          'abort',
          () => {
            stopped = true;
            resolve();
          },
          { once: true },
        );
      }),
  );
  scope.cancel();
  await expect(engine).rejects.toThrow();
  await scope.settle(100);
  expect(stopped).toBe(true);
  expect(scope.summary().every((task) => task.settled)).toBe(true);
});
it('영원히 끝나지 않는 본문은 유한 정리 한도 뒤에도 미정착으로 남는다', async () => {
  vi.useFakeTimers();
  const scope = new WorkScope();
  scope.retain('stalled body', new Promise(() => {}));
  scope.cancel();
  const result = expect(scope.settle(20)).rejects.toThrow('정착');
  await vi.advanceTimersByTimeAsync(21);
  await result;
  expect(scope.summary()[0]!.settled).toBe(false);
});
it('commit과 취소가 겹쳐도 생성 UUID를 보존한 뒤 다음 작업을 거부한다', async () => {
  const scope = new WorkScope(),
    gate = latch<{ worldId: string }>();
  const ids: string[] = [];
  const created = scope.work(
    'create',
    () => gate.promise,
    (row) => ids.push(row.worldId),
  );
  scope.cancel();
  gate.resolve({ worldId: 'own-generated-uuid' });
  await expect(created).rejects.toThrow();
  expect(ids).toEqual(['own-generated-uuid']);
});
it('종료를 보지 못한 child·후손·스트림·admin 중 하나라도 있으면 lock을 해제하지 않는다', () => {
  const proof = {
    tasksSettled: true,
    treesEmpty: true,
    streamsClosed: true,
    guardianClosed: true,
    portsFree: true,
    adminsDisconnected: true,
    databaseAbsent: true,
    sourceUnchanged: true,
  };
  expect(cleanupVerified(proof)).toBe(true);
  for (const key of Object.keys(proof)) expect(cleanupVerified({ ...proof, [key]: false })).toBe(false);
});
function port(overrides: Partial<AuditPort> = {}) {
  return {
    catalog: vi.fn(async () => [{ oid: '123' }]),
    activity: vi.fn(async () => 0),
    drop: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}
const input = {
  beforeCreateAbsent: true,
  createAttempted: true,
  createdOid: '123',
  bodyPassed: true,
  processTreeClosed: true,
  otherCleanupVerified: true,
};
it('CREATE 응답이 유실되고 서비스 종료도 실패해도 catalog·activity·disconnect를 모두 시행한다', async () => {
  const api = port();
  const result = await auditOwnedDatabase(
    { ...input, createdOid: undefined, bodyPassed: false, processTreeClosed: false },
    api,
  );
  expect(result.oid).toBe('123');
  expect(result.connections).toBe(0);
  expect(result.disconnected).toBe(true);
  expect(api.catalog).toHaveBeenCalledOnce();
  expect(api.activity).toHaveBeenCalledOnce();
  expect(api.disconnect).toHaveBeenCalledOnce();
  expect(api.drop).not.toHaveBeenCalled();
});
it('catalog 감사 실패가 activity 감사나 admin disconnect를 가리지 않는다', async () => {
  const api = port({
    catalog: vi.fn(async () => {
      throw new Error('catalog failure');
    }),
  });
  const result = await auditOwnedDatabase(input, api);
  expect(result.activityKnown).toBe(true);
  expect(result.disconnected).toBe(true);
  expect(api.drop).not.toHaveBeenCalled();
});
it('다른 OID·활성 연결·본문 실패·CREATE 이전 존재 중 하나라도 있으면 DROP하지 않는다', async () => {
  for (const value of [
    { ...input, createdOid: 'other' },
    { ...input, bodyPassed: false },
    { ...input, beforeCreateAbsent: false },
  ]) {
    const api = port();
    await auditOwnedDatabase(value, api);
    expect(api.drop).not.toHaveBeenCalled();
  }
  const api = port({ activity: vi.fn(async () => 1) });
  await auditOwnedDatabase(input, api);
  expect(api.drop).not.toHaveBeenCalled();
});
it('DROP·catalog 이후 실패가 나도 admin disconnect를 시행한다', async () => {
  const api = port({
    drop: vi.fn(async () => {
      throw new Error('drop failed');
    }),
  });
  const result = await auditOwnedDatabase(input, api);
  expect(result.disconnected).toBe(true);
  expect(result.errors).toContain('DROP audit uncertain');
});
it('같은 OID·conn0·모든 정리 증거 뒤에만 일반 DROP과 catalog0을 확인한다', async () => {
  const api = port({
    catalog: vi
      .fn()
      .mockResolvedValueOnce([{ oid: '123' }])
      .mockResolvedValueOnce([{ oid: '123' }])
      .mockResolvedValueOnce([]),
  });
  const result = await auditOwnedDatabase(input, api);
  expect(result.dropSucceeded && result.afterDropAbsent && result.disconnected).toBe(true);
});
it('멈춘 독립 감사도 유한 한도 뒤 나머지 감사·disconnect와 함께 불확실함을 남긴다', async () => {
  vi.useFakeTimers();
  const api = port({ catalog: vi.fn(() => new Promise<Array<{ oid: string }>>(() => {})) });
  const pending = auditOwnedDatabase(input, api, 20);
  await vi.advanceTimersByTimeAsync(25);
  const result = await pending;
  expect(result.catalogKnown).toBe(false);
  expect(result.activityKnown).toBe(true);
  expect(result.disconnected).toBe(true);
  expect(api.drop).not.toHaveBeenCalled();
});
it('child close가 없으면 기다림을 끝내되 close를 관찰했다고 기록하지 않는다', async () => {
  vi.useFakeTimers();
  let observedClose = false;
  const pending = expect(
    bounded(
      'child close',
      new Promise(() => {
        observedClose = false;
      }),
      10,
    ),
  ).rejects.toThrow('child close');
  await vi.advanceTimersByTimeAsync(11);
  await pending;
  expect(observedClose).toBe(false);
});

it('시간초과 취소는 호출자를 돌려보내도 원래 본문을 정착으로 가장하지 않는다', async () => {
  const scope = new WorkScope();
  const raw = scope.retain('raw body', new Promise<void>(() => {}));
  const caller = scope.cancellable(raw);
  scope.cancel();
  await expect(caller).rejects.toThrow('취소');
  expect(scope.summary()[0]).toMatchObject({ settled: false });
});

it('본문 실패·시간초과·불명확한 실행권 중 하나라도 있으면 월드와 계정 삭제를 모두 막는다', () => {
  const proof = {
    bodyPassed: true,
    hadFailure: false,
    tasksSettled: true,
    renewalsSettled: true,
    contextsClosed: true,
    ownershipCertain: true,
  };
  const deleteWorldsAndAccounts = vi.fn();
  for (const value of [
    { ...proof, bodyPassed: false },
    { ...proof, hadFailure: true },
    { ...proof, tasksSettled: false },
    { ...proof, ownershipCertain: false },
  ]) {
    if (mayDeleteFixtureRows(value)) deleteWorldsAndAccounts();
  }
  expect(deleteWorldsAndAccounts).not.toHaveBeenCalled();
  expect(mayDeleteFixtureRows(proof)).toBe(true);
});

it('시간초과 뒤 UI 대기가 늦게 풀려도 새 click이 서버 요청을 만들지 않는다', async () => {
  const scope = new WorkScope(),
    gate = latch<void>(),
    submit = vi.fn();
  class Locator {
    async click() {
      submit();
    }
  }
  class Page {
    async goto() {
      await gate.promise;
    }
    getByRole() {
      return new Locator();
    }
  }
  const page = guardedUi(new Page(), scope);
  const body = scope.work('body', async () => {
    await page.goto();
    await page.getByRole().click();
  });
  scope.cancel();
  gate.resolve();
  await expect(body).rejects.toThrow('취소');
  await scope.settle(100);
  expect(submit).not.toHaveBeenCalled();
  expect(page.constructor.name).toBe('Page');
});

it('본문 PASS 뒤 context close 중 늦은 route 오류는 실제 cleanup 삭제0·최종 FAIL·원인·연결종료를 남긴다', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const rows = { worlds: [id], users: ['own-user'] };
  const worldDelete = vi.fn(async () => {
    rows.worlds = [];
    return { count: 1 };
  });
  const userDelete = vi.fn(async () => {
    rows.users = [];
    return { count: 1 };
  });
  const disconnect = vi.fn(async () => {}),
    auditDisconnect = vi.fn(async () => {});
  const execute = vi.fn(async () => 1);
  const raw = {
    world: { deleteMany: worldDelete },
    user: { deleteMany: userDelete },
    $queryRaw: vi.fn(async () => [{ id }]),
    $executeRaw: execute,
    $disconnect: disconnect,
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(raw)),
  };
  const audit = {
    world: { count: vi.fn(async () => rows.worlds.length) },
    user: { count: vi.fn(async () => rows.users.length) },
    $disconnect: auditDisconnect,
  };
  const fixture = new OfferFixture(() => audit as unknown as PrismaClient);
  fixture.users.push({ page: {} as Page, id: 'own-user', email: 'own-user@example.test', cookies: [] });
  const late = latch<void>();
  void fixture.track(late.promise).catch(() => {});
  fixture.contexts.add({
    close: async () => {
      late.reject(new Error('late route failure'));
    },
  } as unknown as BrowserContext);
  const hold = {
    db: raw as unknown as PrismaClient,
    lease: { worldId: id, ownerId: 'own-lease', fencingToken: 1, ttlMs: 15000 },
    done: new AbortController(),
    renewal: Promise.resolve(),
  };
  fixture.worlds.push({ id, hold, tick: 0 });
  fixture.rawHolds.set(id, hold);
  fixture.createdWorlds.add(id);
  fixture.clients.add(raw as unknown as PrismaClient);
  expect(fixture.scope.failures()).toHaveLength(0);
  const result = await fixture.cleanup(true);
  expect(result.failedBeforeCleanup).toBe(false);
  expect(result.taskFailureCount).toBe(1);
  expect(result.taskFailures[0]!.failure).toContain('late route failure');
  expect(result.preserveFailureRows).toBe(true);
  expect(raw.$transaction).not.toHaveBeenCalled();
  expect(worldDelete).not.toHaveBeenCalled();
  expect(userDelete).not.toHaveBeenCalled();
  expect(rows).toEqual({ worlds: [id], users: ['own-user'] });
  expect(result.worldRows).toBe(1);
  expect(result.accountRows).toBe(1);
  expect(execute).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(auditDisconnect).toHaveBeenCalledOnce();
  expect(() => assertCleanupPassed(result)).toThrow('시험 실패');
});

it('의도한 동일 AbortSignal.reason만 취소로 구분하고 같은 문구의 새 Error는 실패로 보존한다', async () => {
  const scope = new WorkScope();
  scope.cancel();
  await expect(scope.retain('intentional cancel', Promise.reject(scope.signal.reason))).rejects.toThrow();
  await expect(scope.retain('real failure', Promise.reject(new Error(scope.signal.reason.message)))).rejects.toThrow();
  await scope.settle(100);
  expect(scope.summary()[0]!.expectedCancellation).toBe(true);
  expect(scope.failures((reason) => (reason as Error).message)).toMatchObject([
    { label: 'real failure', expectedCancellation: false },
  ]);
});

it('첫 catalog A 뒤 activity가0인 동안 동명DB가 B로 바뀌면 DROP0·실패기록·admin종료를 보장한다', async () => {
  let oid = '123';
  const api = port({
    catalog: vi.fn(async () => [{ oid }]),
    activity: vi.fn(async () => {
      oid = '456';
      return 0;
    }),
  });
  const result = await auditOwnedDatabase(input, api);
  expect(result.oid).toBe('123');
  expect(result.preDropOid).toBe('456');
  expect(result.preDropSameOid).toBe(false);
  expect(api.drop).not.toHaveBeenCalled();
  expect(result.errors).toContain('pre DROP OID changed or absent; preserve database');
  expect(result.disconnected).toBe(true);
  expect(result.dropSucceeded).toBe(false);
  expect(result.afterDropAbsent).toBe(false);
  expect(
    cleanupVerified({
      tasksSettled: true,
      treesEmpty: true,
      streamsClosed: true,
      guardianClosed: true,
      portsFree: true,
      adminsDisconnected: result.disconnected,
      sourceUnchanged: true,
      databaseAbsent: result.absent || result.afterDropAbsent,
    }),
  ).toBe(false);
});

it('DROP 직전 catalog가 부재·복수·오류이면 DROP0·실패기록과 독립disconnect를 유지한다', async () => {
  for (const rows of [[], [{ oid: '123' }, { oid: '456' }]]) {
    const api = port({
      catalog: vi
        .fn()
        .mockResolvedValueOnce([{ oid: '123' }])
        .mockResolvedValueOnce(rows),
    });
    const result = await auditOwnedDatabase(input, api);
    expect(api.drop).not.toHaveBeenCalled();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.disconnected).toBe(true);
  }
  const api = port({
    catalog: vi
      .fn()
      .mockResolvedValueOnce([{ oid: '123' }])
      .mockRejectedValueOnce(new Error('pre DROP query failed')),
  });
  const result = await auditOwnedDatabase(input, api);
  expect(api.drop).not.toHaveBeenCalled();
  expect(result.preDropCatalogKnown).toBe(false);
  expect(result.disconnected).toBe(true);
});

it('정상 감사는 catalog A→activity0→직전catalog A→일반DROP→catalog0→disconnect 순서다', async () => {
  const steps: string[] = [];
  let dropped = false;
  const api = port({
    catalog: vi.fn(async () => {
      steps.push(dropped ? 'catalog0' : 'catalogA');
      return dropped ? [] : [{ oid: '123' }];
    }),
    activity: vi.fn(async () => {
      steps.push('activity0');
      return 0;
    }),
    drop: vi.fn(async () => {
      steps.push('DROP');
      dropped = true;
    }),
    disconnect: vi.fn(async () => {
      steps.push('disconnect');
    }),
  });
  const result = await auditOwnedDatabase(input, api);
  expect(result.preDropSameOid && result.dropSucceeded && result.afterDropAbsent && result.disconnected).toBe(true);
  expect(steps).toEqual(['catalogA', 'activity0', 'catalogA', 'DROP', 'catalog0', 'disconnect']);
});
