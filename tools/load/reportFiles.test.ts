import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLoadReport, saveLoadReport } from './reportFiles';

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-load-report-'));
  const errors: unknown[] = [];
  try {
    await run(directory);
  } catch (error) {
    errors.push(error);
  }
  for (const name of ['run.json', 'report.json']) {
    try {
      await unlink(join(directory, name));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) errors.push(error);
    }
  }
  try {
    await rmdir(directory);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, 'LOAD_REPORT_TEST_FAILED');
}

describe('L3 원자료 보존과 재집계', () => {
  it('잘못된schema는파일을쓰지않는다', async () => {
    await withDirectory(async (directory) => {
      await expect(saveLoadReport(directory, { body: 'not-allowed' })).rejects.toThrow('LOAD_REPORT_SCHEMA_INVALID');
      expect(await readdir(directory)).toEqual([]);
    });
  });
  it('잘못된JSON입력조각을결과에복사하지않는다', async () => {
    await withDirectory(async (directory) => {
      const canary = 'private-raw-json-canary';
      await writeFile(join(directory, 'run.json'), `{"broken":${canary}`);
      const result = await readLoadReport(directory);
      expect(result).toMatchObject({ verdict: 'INVALID', invalid: ['RAW_FILE_UNREADABLE'] });
      expect(JSON.stringify(result).includes(canary)).toBe(false);
    });
  });
  it('무효실행도저장·재집계하며기존증거를덮어쓰지않는다', async () => {
    await withDirectory(async (directory) => {
      // 의도적으로 내용이 빈 무효 실행이다. 성능 통과 고정물이 아니다.
      const raw = {
        version: 2,
        mode: 'smoke',
        sourceHead: 'a'.repeat(40),
        sourceSha256: 'b'.repeat(64),
        warmupStartedAt: 1,
        measurementStartedAt: 2,
        measurementFinishedAt: 3,
        fixtureAccounts: 0,
        workloadSeed: 'invalid-raw-fixture',
        workers: [],
        attempts: [],
        generatorFailures: [],
        worlds: [],
        sse: [],
        requests: [],
        metrics: [],
        databaseWitnesses: [],
        databaseCoverage: [],
        environment: {
          admissionAccepted: false,
          admissionSha256: 'c'.repeat(64),
          maxGeneratorCpuFraction: 0,
          maxExternalHostCpuFraction: 0,
          oomCount: 0,
          sourceUnchanged: true,
          complete: false,
          observations: [],
        },
      };
      const original = await saveLoadReport(directory, raw);
      expect(original.verdict).toBe('INVALID');
      const bytes = await readFile(join(directory, 'run.json'), 'utf8');
      expect(await readLoadReport(directory)).toEqual(original);
      await expect(saveLoadReport(directory, raw)).rejects.toThrow();
      expect(await readFile(join(directory, 'run.json'), 'utf8')).toBe(bytes);
    });
  });
});
