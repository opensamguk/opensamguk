import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildInitialWorld, type WorldInit } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { warFixture } from '../apps/engine/test/warFixture';
import { readFixture } from '../apps/server/test/readFixture';

const root = new URL('../', import.meta.url);
const output = new URL('fixtures/t4-77-baseline.json', import.meta.url);
const resources = {
  map: 'resources/map/che.json',
  scenario: 'resources/scenario/1030.json',
  unitSet: 'resources/unitset/basic.json',
  statRules: 'resources/scenario/default.json',
  portraitMap: 'resources/portraits/rtk14-map.json',
} as const;

// 각 시드의 실제 입력 호출은 sourceFingerprints에도 묶는다. 시험 모듈은 실행하지 않는다.
const seedInputs = [
  ['t2-02-legacy-baseline', 'tools/world-presets.test.ts', true],
  ['1', 'tools/season-throughput.ts', true],
  ['loader', 'apps/engine/src/world/resources.test.ts', true],
  ['test-world', 'tools/world-bootstrap.test.ts', false],
  ['command-fixture', 'tools/commands.test.ts', false],
  ['portraits', 'tools/portrait-map/convert.test.ts', true],
  ['T1-12-visibility', 'apps/server/test/readFixture.ts', false],
  ['memory-replay', 'apps/engine/src/simulation.test.ts', true],
  ['engine-test', 'apps/engine/src/turnLoop.integration.test.ts', true],
  ['clock', 'apps/engine/src/world/clock.integration.test.ts', true],
  ['e2e-ranking', 'e2e/rankingSeed.ts', true],
  ['e2e-ranking-fresh', 'e2e/rankingSeed.ts', true],
  ['t4-76-che', 'tools/resource-validate.test.ts', true],
] as const;

// export되지 않은 smallWorld 사영이다. 원 함수가 달라지면 채록을 멈춘다.
const smallWorldSource = `async function smallWorld(): Promise<WorldInit> {
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'memory-replay' });
  initial.generals = initial.generals
    .slice(0, 5)
    .map((general, i) => ({ ...general, activeFromYear: i === 4 ? initial.startYear + 1 : initial.startYear }));
  return initial;
}`;

async function smallWorld(): Promise<WorldInit> {
  const source = await readFile(new URL('apps/engine/src/simulation.test.ts', root), 'utf8');
  assert.ok(source.replaceAll('\r\n', '\n').includes(smallWorldSource), 'smallWorld 원 함수가 바뀌었습니다.');
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'memory-replay' });
  initial.generals = initial.generals
    .slice(0, 5)
    .map((general, i) => ({ ...general, activeFromYear: i === 4 ? initial.startYear + 1 : initial.startYear }));
  return initial;
}

async function collectBaseline() {
  // 기존 함수를 호출하되 DB 모듈까지 도구 타입 검사에 끌어오지 않는다.
  const replayModule = '../apps/engine/src/replay';
  const { resourceHash } = (await import(replayModule)) as { resourceHash: (initial: WorldInit) => string };
  const raw = await Promise.all(Object.values(resources).map((path) => readFile(new URL(path, root))));
  const parsed: unknown[] = raw.map((value) => JSON.parse(value.toString('utf8')));
  const [map, scenario, unitSet, statRules, portraitMap] = parsed;
  const record = (initial: WorldInit) => ({
    initialStateHash: hashState(initial),
    resourceHash: resourceHash(initial),
    cities: initial.cities.length,
    nations: initial.nations.length,
    generals: initial.generals.length,
    diplomacies: initial.diplomacies.length,
    portraits: initial.generals.filter((general) => general.portraitId !== null).length,
  });
  const seeds = Object.fromEntries(
    await Promise.all(
      seedInputs.map(async ([seed, , withPortraitMap]) => {
        const initial = withPortraitMap
          ? await loadInitialWorld({ scenario: '1030', map: 'che', seed })
          : buildInitialWorld({ map, scenario, unitSet, statRules, seed });
        return [seed, { ...record(initial), inputResourceCount: withPortraitMap ? 5 : 4 }];
      }),
    ),
  );
  // 이 비교는 순수 계산의 중단 조건이다. 골든 시험 실행으로 세지 않는다.
  assert.equal(
    seeds['t2-02-legacy-baseline']!.initialStateHash,
    '2952fcf863e11af5879fd8af160d9a729b9032ce443d838eb633d8d901189e16',
    '기존 초기 해시와 다릅니다.',
  );
  assert.equal(
    hashState(buildInitialWorld({ map, scenario, unitSet, statRules, portraitMap, seed: 't4-76-che' })),
    seeds['t4-76-che']!.initialStateHash,
  );
  assert.equal(
    hashState(buildInitialWorld({ map, scenario, unitSet, statRules, portraitMap, seed: 'portraits' })),
    seeds['portraits']!.initialStateHash,
  );
  assert.equal(seeds['portraits']!.portraits, 429);
  const [monthly, war, full, small] = await Promise.all([monthlyFixture(), warFixture(), readFixture(), smallWorld()]);
  const subset = {
    ...full,
    cities: full.cities.slice(0, 3),
    nations: full.nations.slice(0, 2),
    generals: full.generals.slice(0, 4),
  };
  assert.equal(full.cities.length, 94);
  assert.deepEqual([subset.cities.length, subset.nations.length, subset.generals.length], [3, 2, 4]);
  assert.notEqual(hashState(full), hashState(subset));
  const sources = [
    ...new Set([
      ...seedInputs.map(([, path]) => path),
      'apps/engine/src/world/resources.ts',
      'apps/engine/src/replay.ts',
      'apps/engine/test/monthlyFixture.ts',
      'apps/engine/test/warFixture.ts',
      'apps/server/test/readFixture.ts',
      'packages/rules/src/world/bootstrap.ts',
      'packages/shared/src/node/hashState.ts',
    ]),
  ].sort();
  return {
    version: 1,
    resources: Object.fromEntries(
      Object.values(resources).map((path, i) => [
        path,
        {
          contentHash: hashState(parsed[i]),
          lfBytes: Buffer.byteLength(raw[i]!.toString('utf8').replaceAll('\r\n', '\n')),
        },
      ]),
    ),
    sourceFingerprints: Object.fromEntries(
      await Promise.all(
        sources.map(async (path) => [
          path,
          createHash('sha256')
            .update((await readFile(new URL(path, root), 'utf8')).replaceAll('\r\n', '\n'))
            .digest('hex'),
        ]),
      ),
    ),
    seeds,
    fixtures: {
      monthlyFixture: record(monthly),
      warFixture: record(war),
      readFixtureFull: record(full),
      visibilitySubset: record(subset),
      smallWorld: record(small),
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: 'string' }, check: { type: 'boolean' } } });
  if (values.source !== 'file') throw new Error('--source file을 지정하세요. DB 채록은 S6에서 붙입니다.');
  const first = await collectBaseline();
  assert.deepEqual(await collectBaseline(), first, '같은 입력의 두 계산 결과가 다릅니다.');
  const serialized = `${JSON.stringify(first, null, 2)}\n`;
  if (values.check) {
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), first, '저장한 기준표와 계산 결과가 다릅니다.');
  } else {
    await writeFile(output, serialized);
  }
  console.log(`${values.check ? '일치' : '채록'}: ${fileURLToPath(output)} (자원 5, 시드 13, 고정물 5)`);
  console.log('전체 unit·int·골든 시험·시뮬레이션·처리량: UNRUN');
}

await main();
