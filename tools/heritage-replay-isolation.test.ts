import { readdir, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('T4-96 AC-P2-33 규칙·재생·상태 적재는 전역 유산 잔액을 읽지 않는다', async () => {
  const rules = new URL('../packages/rules/src/', import.meta.url);
  const files = (await readdir(rules, { recursive: true }))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => new URL(file.replaceAll('\\', '/'), rules));
  for (const path of ['replay.ts', 'monthly.ts', 'worldLoader.ts', 'generalStats.ts'])
    files.push(new URL(`../apps/engine/src/${path}`, import.meta.url));
  for (const file of files)
    expect(await readFile(file, 'utf8'), file.pathname).not.toMatch(
      /HeritageAccount|HeritageEntry|PgHeritage|heritageBalance/,
    );
  for (const path of ['end.ts', 'reset.ts'])
    expect(await readFile(new URL(`../apps/engine/src/admin/${path}`, import.meta.url), 'utf8')).not.toMatch(
      /creditHeritageSeason|seasonHeritageAwards/,
    );
});
