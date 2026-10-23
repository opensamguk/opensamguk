import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endYearArchive } from './replayFixture';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay.ts', ...args], { cwd: root, encoding: 'utf8' });

describe('T1-26 replay CLI', () => {
  it('기존 v1 --months 경로를 유지한다', () => {
    const result = run('--from', 'apps/engine/test/fixtures/replay-v1-b8f5074.json', '--months', '1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^10000 [a-f0-9]{64} 일치\n$/);
  });

  it('--to-end로 v2 끝 번호·tick·사유·연월·해시를 출력한다', async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'replay-cli-'));
    try {
      const archive = await endYearArchive();
      const path = join(directory, 'ended.json');
      await writeFile(path, JSON.stringify(archive));
      const result = run('--from', path, '--to-end');
      expect(result.status, result.stderr).toBe(0);
      const end = archive.end!;
      expect(result.stdout).toBe(
        `${end.sequence} ${end.tick} END_YEAR ${end.year}년 12월 ${end.finalStateHash} 일치\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['--to-end'],
    ['--from', 'apps/engine/test/fixtures/replay-v1-b8f5074.json', '--to-end', '--months', '1'],
    ['--from', 'apps/engine/test/fixtures/replay-v1-b8f5074.json', '--to-end'],
  ])('잘못된 종료 재생 인자 %j를 거부한다', (...args) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/--to-end|종료 기록/);
  });
});
