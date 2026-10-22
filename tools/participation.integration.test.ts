import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { probeHttp } from './participation/http';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
let base: string;
const sourceSHA = (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim();
beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.$disconnect();
});
const counts = async () =>
  Promise.all([
    db.world.count(),
    db.user.count(),
    db.session.count(),
    db.general.count(),
    db.generalTurn.count(),
    db.inputEvent.count(),
  ]);

describe('T2-18/T3-15 current server TCP HTTP / isolated PostgreSQL evidence probe', () => {
  it('runs the real CLI successfully, but leaves participation NOT_READY and every game table unchanged', async () => {
    const before = await counts();
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'tools/participation/cli.ts', 'probe', '--base-url', base, '--source-sha', sourceSHA],
      { timeout: 20_000 },
    );
    const report = JSON.parse(result.stdout);
    expect(report.toolStatus).toBe('VALID');
    expect(report.checks).toEqual({ serverAndDatabase: true, unauthenticatedWorldDenied: true });
    expect(report.productStatus).toBe('NOT_READY');
    expect(report.sourceVerification).toBe('OPERATOR_CLAIM_ONLY');
    expect(report.notReadyReasons).toContain('NATIVE_PARTICIPANTS_NOT_COLLECTED');
    expect(report.acStatus).toBe('NOT_ASSESSED');
    expect(await counts()).toEqual(before);
    console.log(
      JSON.stringify({
        actualProbe: 'CURRENT_SERVER_TCP_AND_ISOLATED_PG',
        sourceSHA,
        report,
        stateCountsUnchanged: true,
      }),
    );
  });
  it('rejects unreachable HTTP without printing endpoint or raw response', async () => {
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'tools/participation/cli.ts',
          'probe',
          '--base-url',
          'http://127.0.0.1:1',
          '--source-sha',
          sourceSHA,
        ],
        { timeout: 10_000 },
      ),
    ).rejects.toMatchObject({ code: 2 });
  });
  it('never calls a source claim verified simply because health and protected routes respond', async () => {
    const report = await probeHttp(base, 'b'.repeat(40));
    expect(report.sourceVerification).toBe('OPERATOR_CLAIM_ONLY');
    expect(report.productStatus).toBe('NOT_READY');
  });
});
