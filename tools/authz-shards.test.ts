import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { categories, compareAuthz } from '../apps/server/src/authz/coverage';
import { buildShardRecord, mergeShardRecords, parseAuthzArgs, readShardDir } from './authz-shards';
import { AUTHZ_SHARD_TOTAL, ENGINE_SHARD_TOTAL, integrationShardArgs } from './integration-partition';

const sha = 'a'.repeat(40);
const root = resolve('authz-test-fixture');
const files = ['tools/one.integration.test.ts', 'tools/two.integration.test.ts', 'tools/three.integration.test.ts'];
const expected = { sha, runId: '42', shardsResult: 'success', files };
function records() {
  return files.map((file, i) =>
    buildShardRecord(
      {
        sha,
        runId: '42',
        runAttempt: '1',
        suite: 'api',
        shard: { index: i + 1, total: 3 },
        evidence: categories.filter((_, j) => j % 3 === i).map((category) => ({ path: 'health', category })),
      },
      { success: true, testResults: [{ name: join(root, file), status: 'passed' }] },
      root,
    ),
  );
}

describe('T3-04 AC-M3-03 권한 조각 합본', () => {
  it('모든 파일과 증거를 합친 뒤 기존 전역 대조가 누락·오래된 면제를 판정한다', () => {
    const router = { _def: { procedures: { health: { _def: { type: 'query' } } } } };
    const merged = mergeShardRecords(records(), expected);
    expect(compareAuthz(router, merged, []).missing).toEqual([]);
    const missing = records();
    missing[1]!.evidence = [];
    expect(compareAuthz(router, mergeShardRecords(missing, expected), []).missing).toHaveLength(2);
    expect(compareAuthz(router, merged, [{ path: 'health', category: 'success', reason: 'old' }]).missing).toEqual([
      'stale exemption: health success',
    ]);
    const retried = records();
    retried[1]!.runAttempt = '2';
    expect(mergeShardRecords(retried, expected)).toEqual(merged);
  });
  it.each(['failure', 'cancelled', 'skipped', ''])('전체 조각 결과 %s는 실패다', (shardsResult) => {
    expect(() => mergeShardRecords(records(), { ...expected, shardsResult })).toThrow('shards-result');
  });
  it('빠진 조각·중복·파일 중복·누락·예상 밖 파일은 실패한다', () => {
    expect(() => mergeShardRecords(records().slice(0, 2), expected)).toThrow('shard-missing');
    expect(() => mergeShardRecords([records()[0], records()[0], records()[2]], expected)).toThrow('shard-duplicate');
    const overlap = records();
    overlap[1]!.vitest.files = [files[0]!];
    expect(() => mergeShardRecords(overlap, expected)).toThrow('file-overlap');
    expect(() =>
      mergeShardRecords(records(), { ...expected, files: [...files, 'tools/missing.integration.test.ts'] }),
    ).toThrow('file-union');
    const extra = records();
    extra[1]!.vitest.files = ['tools/other.integration.test.ts'];
    expect(() => mergeShardRecords(extra, expected)).toThrow('file-union');
    expect(() => mergeShardRecords(records(), { ...expected, files: [] })).toThrow('expected-files');
  });
  it.each([
    { sha: 'b'.repeat(40) },
    { runId: '43' },
    { suite: 'engine' },
    { schema: 'other' },
    { shard: { index: 0, total: 3 } },
    { shard: { index: 4, total: 3 } },
    { shard: { index: 1, total: 4 } },
    { evidence: [{ path: 'health', category: 'other' }] },
    { evidence: [{ path: 1, category: 'success' }] },
    { secret: 'must not enter artifact' },
    { vitest: { success: false, files: [files[0]] } },
  ])('출처·기록 형식 오류를 거부한다: %j', (change) => {
    const [first, ...rest] = records();
    expect(() => mergeShardRecords([{ ...first, ...change }, ...rest], expected)).toThrow();
  });
  it('실제 보고에서 허용 필드만 추출하고 실패·저장소 밖 파일을 거부한다', () => {
    const input = records()[0]!;
    const report = {
      success: true,
      testResults: [{ name: join(root, files[0]!), status: 'passed', stdout: 'private' }],
    };
    expect(JSON.stringify(buildShardRecord(input, report, root))).not.toContain('private');
    expect(() => buildShardRecord(input, { ...report, success: false }, root)).toThrow('vitest-failed');
    expect(() =>
      buildShardRecord(
        input,
        { success: true, testResults: [{ name: join(root, '..', 'escape.integration.test.ts'), status: 'passed' }] },
        root,
      ),
    ).toThrow('report-path');
    expect(() =>
      buildShardRecord(
        input,
        { success: true, testResults: [{ name: join(root, files[0]!), status: 'failed' }] },
        root,
      ),
    ).toThrow('vitest-failed');
  });
  it('인자 없는 실행은 유지하고 분할과 합본의 정확한 인자만 받는다', () => {
    expect(parseAuthzArgs([])).toEqual({ mode: 'full' });
    expect(parseAuthzArgs(['--merge', root])).toEqual({ mode: 'merge', directory: root });
    expect(parseAuthzArgs(['--shard', '2/3', '--out', join(root, 'record.json')]).mode).toBe('shard');
    for (const args of [
      ['--shard=1/3'],
      ['--shard', '1/3'],
      ['--merge', 'relative'],
      ['--merge', root, 'extra'],
      ...['0/3', '4/3', '1/4', '1-3'].map((s) => ['--shard', s, '--out', root]),
    ])
      expect(() => parseAuthzArgs(args)).toThrow('usage');
  });
  it('분할 인자는 API·엔진의 정해진 조각만 허용하고 잘못된 경로를 DB 전에 거부한다', () => {
    expect(integrationShardArgs(undefined, undefined, undefined)).toEqual([]);
    expect(integrationShardArgs('engine', undefined, undefined)).toEqual([]);
    expect(integrationShardArgs('api', '1/3', join(root, 'report.json'))).toContain('--shard=1/3');
    for (const shard of ['1/2', '2/2'])
      expect(integrationShardArgs('engine', shard, join(root, 'report.json'))).toEqual([
        `--shard=${shard}`,
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${join(root, 'report.json')}`,
      ]);
    for (const suite of [undefined, 'all']) expect(() => integrationShardArgs(suite, '1/3', root)).toThrow('suite');
    for (const [shard, report] of [
      [undefined, root],
      ['1/3', undefined],
      ['1/3', 'relative'],
      ['0/3', root],
      ['4/3', root],
      ['1/4', root],
    ])
      expect(() => integrationShardArgs('api', shard, report)).toThrow('shard-spec');
    for (const [shard, report] of [
      [undefined, root],
      ['1/2', undefined],
      ['1/2', 'relative'],
      ['0/2', root],
      ['3/2', root],
      ['1/3', root],
      ['1-2', root],
    ])
      expect(() => integrationShardArgs('engine', shard, report)).toThrow('shard-spec');
  });
  it('자기 artifact 디렉터리 이름·파일 수·형식을 확인한다', () => {
    const prefix = join(tmpdir(), 'opensamguk-authz-');
    const directory = mkdtempSync(prefix);
    const cleanup = () => {
      if (!resolve(directory).startsWith(resolve(prefix))) throw new Error('test cleanup path');
      rmSync(directory, { recursive: true });
    };
    try {
      for (const record of records()) {
        const d = join(directory, `authz-evidence-${sha}-shard-${record.shard.index}-of-3`);
        mkdirSync(d);
        writeFileSync(join(d, 'record.json'), JSON.stringify(record));
      }
      expect(mergeShardRecords(readShardDir(directory), expected)).toHaveLength(5);
      writeFileSync(join(directory, `authz-evidence-${sha}-shard-1-of-3`, 'extra'), 'x');
      expect(() => readShardDir(directory)).toThrow('artifact-layout');
    } finally {
      cleanup();
    }
  });
  it('필수 합본 이름·모든 조각·격리 PG·T2-15 정리와 전체 관문을 유지한다', () => {
    const jobs = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs;
    const shard = jobs['database-authz-shard'],
      merge = jobs['database-authz'];
    expect(shard.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3] } });
    expect(shard.strategy.matrix.shard).toHaveLength(AUTHZ_SHARD_TOTAL);
    expect(shard['timeout-minutes']).toBe(75);
    expect(shard.services).toEqual(jobs['database-engine'].services);
    const engine = jobs['database-engine'];
    expect(engine.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } });
    expect(engine.strategy.matrix.shard).toHaveLength(ENGINE_SHARD_TOTAL);
    expect(engine['timeout-minutes']).toBe(30);
    expect(engine.env.INTEGRATION_SHARD).toBe('${{ matrix.shard }}/2');
    expect(engine.env.INTEGRATION_REPORT).toBe('${{ runner.temp }}/engine-${{ matrix.shard }}.json');
    const cleanup = shard.steps.findIndex((s: { name?: string }) => s.name === 'Clean T2-15 binding files');
    expect(shard.steps[cleanup].if).toBe('always()');
    expect(shard.steps[cleanup + 1].if).toBe('success()');
    expect(shard.steps.some((s: { name?: string }) => s.name === 'Bind T2-15 restore inputs')).toBe(true);
    expect(merge.name).toBe('opensamguk-database-authz');
    expect(merge.needs).toEqual(['database-authz-shard']);
    expect(merge.if).toMatch(/^always\(\)/);
    expect(jobs['database-browser'].needs).toEqual(['database-authz', 'database-engine', 'database-e2e']);
    expect(jobs['database-browser'].steps[0].run).toContain('test "$AUTHZ" = success');
    expect(jobs['database-browser'].steps[0].run).toContain('test "$ENGINE" = success');
  });
});
