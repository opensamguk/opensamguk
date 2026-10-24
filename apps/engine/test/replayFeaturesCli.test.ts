import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const file = 'apps/engine/test/fixtures/replay-v3.json';
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay.ts', '--from', file, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });
it('T2-26 CLI는 DB 없이 archive 3 월간 기록을 재생한다', async () => {
  const archive = JSON.parse(await readFile(file, 'utf8'));
  const result = cli('--months', '1');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(`${archive.months[0].tick} ${archive.months[0].stateHash} 일치`);
});
it('T2-26 CLI는 DB 없이 archive 3 종료 기록을 재생한다', async () => {
  const archive = JSON.parse(await readFile(file, 'utf8'));
  const result = cli('--to-end');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`${archive.end.finalStateHash} 일치`);
});
