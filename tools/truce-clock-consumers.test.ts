import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('AC-P2-19 운영 소비자는 휴전을 빠뜨리는 직접 시계 펼침을 만들지 않는다', () => {
  const root = new URL('../', import.meta.url).pathname;
  const offenders: string[] = [];
  function inspect(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) inspect(file);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.test\.ts$/.test(entry.name)) {
        if (/\b(?:nowTick|checkpointClock)\s*\(\s*\{/.test(readFileSync(file, 'utf8')))
          offenders.push(file.pathname.slice(root.length));
      }
    }
  }
  for (const directory of ['apps/engine/src/', 'apps/server/src/', 'tools/'])
    inspect(new URL(directory, new URL('../', import.meta.url)));
  expect(offenders).toEqual([]);
});
