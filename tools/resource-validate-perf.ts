import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { cpus, platform, totalmem } from 'node:os';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  validateMap,
  validateScenario,
  validateUnitSet,
  validatePortraitMap,
} from '../packages/rules/src/world/validate/index';
import {
  makeCity,
  mapFixture,
  scenarioFixture,
  unitFixture,
  v2Fixture,
} from '../packages/rules/src/world/validate/testFixtures';

const cases = [
  'city-edges',
  'terrain-points',
  'canvas-layers',
  'scenario-owned',
  'unit-coefficients',
  'portraits',
  'context-budget',
  'diagnostics',
] as const;
type Case = (typeof cases)[number];
function sample(name: Case): () => { status: string; issues: { code: string }[]; truncated: boolean; ran: string[] } {
  if (name === 'city-edges') {
    const map = {
      ...mapFixture(),
      cities: Array.from({ length: 1000 }, (_, i) => ({
        ...makeCity(i + 1),
        connections: Array.from({ length: 32 }, (_, j) => [
          ((i + j + 1) % 1000) + 1,
          ((i - j - 1 + 1000) % 1000) + 1,
        ]).flat(),
      })),
    };
    return () => validateMap(map, { scenarios: [] });
  }
  if (name === 'terrain-points') {
    const map = v2Fixture();
    const line: [number, number][] = Array.from({ length: 10000 }, (_, i) => [i % 700, i % 500]);
    line[line.length - 1] = [0, 0];
    map.terrain.coast = Array(20).fill(line);
    return () => validateMap(map, { scenarios: [] });
  }
  if (name === 'canvas-layers') {
    const map = v2Fixture();
    map.canvas = { width: 4096, height: 1024 };
    const ring: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ];
    for (const layer of ['coast', 'lakes', 'mountains'] as const) map.terrain[layer] = Array(2000).fill(ring);
    map.terrain.rivers = Array(2000).fill({
      points: [
        [0, 0],
        [10, 10],
      ],
    });
    return () => validateMap(map, { scenarios: [] });
  }
  if (name === 'scenario-owned' || name === 'context-budget') {
    const scenario = scenarioFixture();
    scenario.nation = Array.from({ length: 500 }, (_, i) => [
      `국가${i}`,
      '#000000',
      0,
      0,
      '',
      0,
      '',
      0,
      Array(1000).fill('도시1'),
    ]);
    scenario.general = Array(10000).fill(scenario.general[0]!);
    scenario.diplomacy = Array(10000).fill([1, 2, 0, 1]);
    const map = mapFixture();
    if (name === 'scenario-owned') return () => validateScenario(scenario, { map });
    const empty = () => ({ ...scenarioFixture(), nation: [], general: [], diplomacy: [] });
    const contexts = [scenario, ...Array.from({ length: 31 }, empty)];
    return () => validateMap(map, { scenarios: contexts });
  }
  if (name === 'unit-coefficients') {
    const value = unitFixture();
    value.armTypes = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i + 1), `계통${i + 1}`]));
    const coef = Object.fromEntries(Object.keys(value.armTypes).map((key) => [key, 1]));
    value.crewTypes = Array.from({ length: 500 }, (_, i) => ({
      ...value.crewTypes[1]!,
      id: 1000 + i,
      armType: i === 0 ? 0 : 1,
      attackCoef: coef,
      defenceCoef: coef,
    }));
    value.defaultCrewTypeId = 1001;
    return () => validateUnitSet(value);
  }
  if (name === 'portraits') {
    const portraits = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`장수${i}`, 10001]));
    return () => validatePortraitMap({ portraits });
  }
  const map = { ...mapFixture(), cities: Array.from({ length: 600 }, () => makeCity()) };
  return () => validateMap(map, { scenarios: [] });
}
const requested = process.argv.indexOf('--case');
if (requested !== -1) {
  const name = process.argv[requested + 1] as Case;
  if (!cases.includes(name)) throw new Error('측정 표본 이름이 맞지 않습니다.');
  const run = sample(name);
  global.gc?.();
  const rssBeforeBytes = process.memoryUsage().rss;
  const start = performance.now();
  const result = run();
  const elapsedMs = performance.now() - start;
  const expected = name === 'scenario-owned' || name === 'diagnostics' ? 'fail' : 'pass';
  const terminal =
    name === 'scenario-owned'
      ? 'map-refs'
      : name === 'unit-coefficients'
        ? 'crew-types'
        : name === 'portraits'
          ? 'portraits'
          : 'scenario-refs';
  if (
    result.status !== expected ||
    !result.ran.includes(terminal) ||
    result.issues.some((item) => item.code === 'shape-invalid')
  )
    throw new Error('표본이 의도한 검사 단계에 도달하지 않았습니다.');
  console.log(
    JSON.stringify({
      name,
      pid: process.pid,
      elapsedMs,
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage().rss,
      processLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
      status: result.status,
      diagnostics: result.issues.length,
      truncated: result.truncated,
      ran: result.ran,
    }),
  );
} else {
  const script = fileURLToPath(import.meta.url);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const sourceFiles = [
    script,
    resolve(root, 'packages/rules/package.json'),
    resolve(root, 'packages/rules/src/world/resources.ts'),
    ...['map', 'validate'].flatMap((dir) =>
      readdirSync(resolve(root, `packages/rules/src/world/${dir}`))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => resolve(root, `packages/rules/src/world/${dir}/${name}`)),
    ),
  ].sort();
  const hash = createHash('sha256');
  const zodVersion = (
    JSON.parse(readFileSync(resolve(root, 'packages/rules/node_modules/zod/package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  hash.update('zod-version\0').update(zodVersion).update('\0');
  for (const file of sourceFiles)
    hash.update(relative(root, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
  const rows = cases.map((name) => {
    const child = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--import',
        pathToFileURL(resolve(root, 'node_modules/tsx/dist/loader.mjs')).href,
        script,
        '--case',
        name,
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true },
    );
    if (child.error || child.status !== 0) throw new Error(child.error?.message ?? child.stderr);
    return JSON.parse(child.stdout) as unknown;
  });
  console.log(
    JSON.stringify(
      {
        version: 1,
        node: process.version,
        zodVersion,
        platform: platform(),
        cpu: cpus()[0]?.model,
        totalMemoryBytes: totalmem(),
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
        sourceInputsSha256: hash.digest('hex'),
        repetitions: 1,
        scope:
          'One fresh process per fixture; time excludes module imports, fixture construction and JSON parsing. RSS includes the whole process; lifetime max includes imports and fixtures. No renderer or pixel buffer allocation. Results are measurements, not performance approval.',
        rows,
      },
      null,
      2,
    ),
  );
}
