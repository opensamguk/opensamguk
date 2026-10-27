import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ENGINE_INTEGRATION_FILES, integrationPartition } from './integration-partition';

describe('INT-01 / AC-INT-01 PostgreSQL CI 분할', () => {
  it('기본은 전체이며 잘못된 묶음은 DB 접속 전에 거부한다', () => {
    expect(integrationPartition(undefined)).toEqual([]);
    expect(integrationPartition('all')).toEqual([]);
    for (const value of ['', 'API', 'other', 'api,engine'])
      expect(() => integrationPartition(value)).toThrow('INTEGRATION_SUITE');
  });

  it('실제 통합 파일은 두 CI 묶음에 빠짐없이 한 번씩 속한다', async () => {
    const files = (
      await Promise.all(
        ['apps', 'tools'].map(async (directory) =>
          (await readdir(new URL(`../${directory}/`, import.meta.url), { recursive: true })).map(
            (file) => `${directory}/${file}`,
          ),
        ),
      )
    )
      .flat()
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => /^(apps\/.*|tools\/[^/]+)\.integration\.test\.ts$/.test(file))
      .sort();
    const engine = integrationPartition('engine');
    const exclusions = integrationPartition('api').filter((value) => value !== '--exclude');
    expect(new Set(engine).size).toBe(engine.length);
    expect(exclusions).toEqual(engine);
    for (const file of engine) expect(files).toContain(file);
    const api = files.filter((file) => !exclusions.includes(file));
    expect([...api, ...engine].sort()).toEqual(files);
    expect(api).toContain('tools/int06-campaign.integration.test.ts');
  });

  it('권한 기록이 없는 엔진 검사만 분리하고 HTTP 권한 대조는 그대로 남긴다', async () => {
    for (const file of ENGINE_INTEGRATION_FILES) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\bauthzCase\s*\(/);
    }
  });
});
