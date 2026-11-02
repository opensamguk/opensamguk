import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditOwnedCreate,
  CreateOptionsBoundary,
  type OwnedCreateAudit,
  type OwnedCreateState,
} from './admin-create-options-boundary';

const name = 't305_create_options_' + 'a'.repeat(32) + '_test';
const initial: OwnedCreateState = {
  name,
  baselineAbsent: true,
  createSent: true,
  createOutcome: 'confirmed',
  initialOid: '90',
  workSettled: true,
  clientsClosed: true,
  primaryApplicationName: 'own-primary',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function audit(
  boundary: CreateOptionsBoundary,
  state: OwnedCreateState,
  catalog = [['90'], ['90']],
  connections = 0,
  primary = 0,
) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let drops = 0,
    reads = 0;
  const receipt: OwnedCreateAudit = {
    attempted: false,
    complete: false,
    identityKnown: false,
    dropOutcome: 'not-sent',
  };
  const phase = boundary.phase('audit-probe', 1000);
  try {
    await auditOwnedCreate(
      boundary,
      phase,
      state,
      async (sql, values) => {
        calls.push({ sql, values });
        if (sql.startsWith('DROP')) {
          drops++;
          return { rows: [] };
        }
        if (sql.includes('application_name')) return { rows: [{ count: primary }] };
        if (sql.includes('pg_stat_activity')) return { rows: [{ count: connections }] };
        return { rows: (catalog[reads++] ?? []).map((oid) => ({ oid })) };
      },
      receipt,
    );
  } finally {
    boundary.finish(phase);
  }
  return { receipt, calls, drops };
}
afterEach(() => vi.useRealTimers());
describe('AC-M3-04 생성 설정 fixture 유한 수명과 불확실성', () => {
  it('setup 기한 뒤 원 SQL 성공을 보존하고 다음 SQL과 DROP은0이다', async () => {
    vi.useFakeTimers();
    const boundary = new CreateOptionsBoundary(),
      phase = boundary.phase('setup', 20, true),
      original = deferred<void>();
    let laterSql = 0;
    const flow = (async () => {
      await phase.run(() => original.promise, 100);
      await phase.run(async () => {
        laterSql++;
      });
    })();
    const guarded = phase.guard(flow).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(21);
    await guarded;
    expect(boundary.pending.size).toBe(1);
    expect(boundary.failed).toBe(true);
    expect(boundary.uncertain).toBe(true);
    original.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.pending.size).toBe(0);
    expect(laterSql).toBe(0);
    expect((await audit(boundary, initial)).drops).toBe(0);
    boundary.finish(phase);
  });
  it('Vitest test signal abort와 suite hook fail을 sticky로 받는다', async () => {
    const boundary = new CreateOptionsBoundary(),
      controller = new AbortController();
    const phase = boundary.phase('case', 1000, true, controller.signal),
      original = deferred<void>();
    const pending = phase.run(() => original.promise).catch(() => undefined);
    await Promise.resolve();
    controller.abort();
    await pending;
    original.resolve();
    await Promise.resolve();
    boundary.observeHooks({ hooks: { beforeAll: 'fail' } });
    expect(boundary.uncertain).toBe(true);
    let starts = 0;
    await expect(
      phase.run(async () => {
        starts++;
      }),
    ).rejects.toThrow();
    expect(starts).toBe(0);
    expect((await audit(boundary, initial)).drops).toBe(0);
    boundary.finish(phase);
  });
  it('cleanup 기한 뒤 닫힘이 성공해도 실패가 지워지지 않고 독립 감사는 돈다', async () => {
    vi.useFakeTimers();
    const boundary = new CreateOptionsBoundary(),
      phase = boundary.phase('cleanup', 10),
      closing = deferred<void>();
    const wait = phase.run(() => closing.promise).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(11);
    await wait;
    closing.resolve();
    await vi.advanceTimersByTimeAsync(1);
    const observed = await audit(boundary, initial);
    expect(observed.calls.some((call) => call.sql.includes('pg_database'))).toBe(true);
    expect(observed.receipt.connections).toBe(0);
    expect(observed.drops).toBe(0);
    expect(boundary.uncertain).toBe(true);
    boundary.finish(phase);
  });
  for (const reason of ['create-response-lost', 'after-create-abort', 'initial-oid-read-failed'])
    it(reason + '에서도 자기 catalog/OID/연결0과 원 관리자 닫힘을 관측한다', async () => {
      const boundary = new CreateOptionsBoundary();
      boundary.fail(reason, true);
      const { initialOid: _initialOid, ...unknown } = initial;
      void _initialOid;
      const result = await audit(boundary, {
        ...unknown,
        createOutcome: reason === 'initial-oid-read-failed' ? 'confirmed' : 'unknown',
      });
      expect(result.receipt).toMatchObject({
        attempted: true,
        complete: true,
        recoveredOid: '90',
        connections: 0,
        primaryConnections: 0,
      });
      expect(result.drops).toBe(0);
      expect(result.calls.filter((call) => call.sql.includes('pg_database'))).toHaveLength(2);
      expect(
        result.calls.filter((call) => call.sql.includes('pg_database')).every((call) => call.values[0] === name),
      ).toBe(true);
    });
  it('정확한 확정 OID·닫힘·연결0·성공 경계에서만 자기 DB를 지운다', async () => {
    const result = await audit(new CreateOptionsBoundary(), initial);
    expect(result.drops).toBe(1);
    expect(result.receipt).toMatchObject({ dropOutcome: 'confirmed', rowsAfterDrop: 0 });
  });
  it('중복/변경 OID·양수 연결·불명 primary·원 작업 미정산은 삭제0이다', async () => {
    for (const [catalog, connections, primary, patch] of [
      [[['90', '91'], ['90']], 0, 0, {}],
      [[['90'], ['91']], 0, 0, {}],
      [[['90'], ['90']], 1, 0, {}],
      [[['90'], ['90']], 0, 1, {}],
      [[['90'], ['90']], 0, 0, { baselineAbsent: false }],
      [[['90'], ['90']], 0, 0, { workSettled: false }],
    ] as Array<[string[][], number, number, Partial<OwnedCreateState>]>) {
      expect(
        (await audit(new CreateOptionsBoundary(), { ...initial, ...patch }, catalog, connections, primary)).drops,
      ).toBe(0);
    }
  });
  it('아직 정산되지 않은 실제 Promise가 남으면 연결0 관측 뒤에도 삭제0이다', async () => {
    const boundary = new CreateOptionsBoundary(),
      late = deferred<void>();
    boundary.retain(late.promise);
    expect((await audit(boundary, initial)).drops).toBe(0);
    expect(boundary.pending.size).toBe(1);
    late.resolve();
    await Promise.resolve();
  });
  it('실제 Vitest beforeAll timeout 후 늦은 성공에서도 후속 SQL/DROP0과 최종 원장을 남긴다', () => {
    const folder = mkdtempSync(join(tmpdir(), 'cu-options-hook-'));
    const config = join(folder, 'vitest.config.mjs'),
      receipt = join(folder, 'receipt.json');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const fixture = fileURLToPath(new URL('fixtures/admin-create-options-hook.case.ts', import.meta.url));
    writeFileSync(
      config,
      'export default ' +
        JSON.stringify({
          test: { include: [fixture.replaceAll('\\', '/')], maxWorkers: 1, fileParallelism: false, hookTimeout: 1000 },
        }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, CU_HOOK_PROBE_RECEIPT: receipt };
    delete env.DATABASE_URL;
    delete env.TEST_DATABASE_URL;
    const child = spawnSync(
      process.execPath,
      [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config],
      { cwd: root, env, encoding: 'utf8', timeout: 4000 },
    );
    writeFileSync(join(folder, 'child-output.log'), child.stdout + child.stderr);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).toContain('Hook timed out in 20ms.');
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      hookFailed: true,
      suiteState: 'fail',
      hookState: 'run',
      observedNativeFailure: true,
      failed: true,
      uncertain: true,
      laterSql: 0,
      drops: 0,
      pending: 0,
      finalAdminClosed: true,
      databaseIO: 0,
    });
    // 실패·skip이 예상된 이 자식은 수명 경계 반례이며 제품/인수 통과로 계산하지 않는다.
  });
});
