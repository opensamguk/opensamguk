import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const tails = [
  ['map', 'che'],
  ['scenario', '1030'],
  ['unitset', 'basic'],
  ['scenario', 'default'],
  ['portraits', 'rtk14-map'],
].map((parts) => parts.join('/'));
const files = [
  ...new Set(
    execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'tools', 'e2e'],
      { cwd: root, encoding: 'utf8' },
    ).split('\0'),
  ),
]
  .filter((file) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file) && existsSync(new URL(file, root)))
  .sort();
const sources = new Map<string, string>();
for (const file of files) sources.set(file, await readFile(new URL(file, root), 'utf8'));

function references(source: string) {
  return tails.filter((tail) => new RegExp(`(?:^|[^\\w-])${tail}(?=$|[^\\w-])`).test(source));
}

it('AC-P2-26 초기화 SQL로 옮긴 다섯 원본 파일은 없다', async () => {
  expect(tails).toHaveLength(5);
  for (const tail of tails)
    await expect(access(new URL('resources/' + tail + '.json', root))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('AC-P2-26 소스에 다섯 원본 참조가 없고 조립한 import도 잡는다', () => {
  expect(files.length).toBeGreaterThan(1000);
  expect(files).toContain('tools/resources-removed.test.ts');
  expect([...sources].flatMap(([file, source]) => references(source).map((tail) => ({ file, tail })))).toEqual([]);
  for (const tail of tails) {
    const assembled = ['resources', tail + '.json'].join('/');
    expect(references(`import resource from ${JSON.stringify(assembled)};`)).toEqual([tail]);
  }
  expect(references('map_che.json scenario_1030.json')).toEqual([]);
  expect(references(tails.map((tail) => tail + '-another.json').join(' '))).toEqual([]);
});

it('AC-P2-26 남는 동적 자원 소비자는 확인한 위치와 개수 그대로다', () => {
  const patterns = [
    /(?<![-\w])(?:map|scenario|unitset|portraits)\/\$\{/g,
    /resources\/\$\{/g,
    /['"]resources\/['"]\s*\+/g,
    /\[\s*['"]resources['"]\s*,[^\]]*\]\.join\(['"]\/['"]\)/g,
    /Object\.keys\(baseline\.resources\)/g,
  ];
  const found = Object.fromEntries(
    [...sources].flatMap(([file, source]) => {
      const count = patterns.reduce((total, pattern) => total + [...source.matchAll(pattern)].length, 0);
      return count ? [[file, count]] : [];
    }),
  );
  expect(found).toEqual({
    // 공개 초상 URL과 남는 JSON 입력·출처 메타데이터를 구분한다.
    'apps/web/src/portrait/portraitUrl.ts': 1,
    'e2e/portrait.spec.ts': 1,
    'tools/battle-sim-resources.integration.test.ts': 1,
    'tools/create-options-resources.integration.test.ts': 1,
    'tools/integration-resources.ts': 1,
    'tools/map-data/build-san10-resources.ts': 2,
    'tools/map-data/integration-scenario.ts': 2,
    'tools/officer-sex-ledger.integration.test.ts': 1,
    'tools/reset-preparation-resources.integration.test.ts': 1,
    'tools/resource-catalog.integration.test.ts': 2,
    'tools/resource-init.integration.test.ts': 1,
    'tools/resources-removed.test.ts': 2,
    'tools/resources-sql/convert.ts': 1,
    'tools/resources-sql/generate-scenarios.ts': 1,
    'tools/scenarios.integration.test.ts': 1,
    'tools/scenarios.test.ts': 1,
  });
});

it('AC-P2-26 파일 초기화 API와 과거 기준 재생성 명령은 없다', async () => {
  expect(sources.get('apps/engine/src/world/resources.ts')).not.toMatch(/\bloadInitialWorld\b|\breadJson\b/);
  expect(sources.get('apps/server/src/routers/lobby.ts')).not.toMatch(/node:fs|\breadFile(?:Sync)?\b/);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
    scripts: Record<string, string>;
  };
  expect(manifest.scripts).not.toHaveProperty('resources:sql');
  for (const path of ['tools/resources-sql/generate.ts', 'tools/resource-baseline.ts'])
    await expect(access(new URL(path, root))).rejects.toMatchObject({ code: 'ENOENT' });
});
