import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, it } from 'vitest';
import { auditOwnedCreate, CreateOptionsBoundary, type OwnedCreateAudit } from '../admin-create-options-boundary';

// 명시적인 하위 pure probe만 이 파일을 수집한다. 실제 DB·HTTP·브라우저는 없다.
const boundary = new CreateOptionsBoundary();
let laterSql = 0,
  drops = 0,
  finalAdminClosed = false;
beforeAll(async () => {
  const setup = boundary.phase('setup-native-hook-probe', 1000, true);
  const original = (async () => {
    await setup.run(() => new Promise<void>((resolve) => setTimeout(resolve, 120)));
    await setup.run(async () => {
      laterSql++;
    });
  })();
  await setup.guard(original);
}, 20);
it('hook 실패 뒤 본문을 인수 통과로 세지 않는다', () => {
  throw new Error('실행되면 안 되는 본문입니다.');
});
// Vitest5 suite hook은 첫 fixture 인자에 구조 분해를 요구한다.
// eslint-disable-next-line no-empty-pattern
afterAll(async ({}, suite) => {
  boundary.observeHooks(suite.result);
  boundary.sealWork();
  const cleanup = boundary.phase('cleanup-probe', 500);
  await cleanup.run(() => new Promise<void>((resolve) => setTimeout(resolve, 160)));
  boundary.finish(cleanup);
  const audit = boundary.phase('independent-audit-probe', 500);
  const receipt: OwnedCreateAudit = {
    attempted: false,
    complete: false,
    identityKnown: false,
    dropOutcome: 'not-sent',
  };
  await auditOwnedCreate(
    boundary,
    audit,
    {
      name: 't305_create_options_' + 'a'.repeat(32) + '_test',
      baselineAbsent: true,
      createSent: true,
      createOutcome: 'unknown',
      workSettled: true,
      clientsClosed: true,
      primaryApplicationName: 'probe-primary',
    },
    async (sql) => {
      if (sql.startsWith('DROP')) {
        drops++;
        return { rows: [] };
      }
      return { rows: sql.includes('pg_stat_activity') ? [{ count: 0 }] : [{ oid: '90' }] };
    },
    receipt,
  );
  boundary.finish(audit);
  const close = boundary.phase('final-close-probe', 100);
  await close.run(async () => {
    finalAdminClosed = true;
  });
  boundary.finish(close);
  const file = process.env.CU_HOOK_PROBE_RECEIPT;
  if (!file) throw new Error('pure probe 원장 경로가 필요합니다.');
  writeFileSync(
    file,
    JSON.stringify({
      // 설치된 Vitest5는 실패 hook을 run으로 남기고 suite.state를 fail로 고정한다.
      hookFailed: suite.result?.state === 'fail' && suite.result?.hooks?.beforeAll !== 'pass',
      suiteState: suite.result?.state,
      hookState: suite.result?.hooks?.beforeAll,
      observedNativeFailure: boundary.reasons.has('vitest-hook-or-suite-failed'),
      failed: boundary.failed,
      uncertain: boundary.uncertain,
      laterSql,
      drops,
      pending: boundary.pending.size,
      finalAdminClosed,
      databaseIO: 0,
    }),
  );
});
