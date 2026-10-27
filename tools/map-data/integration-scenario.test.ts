import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildInitialWorld } from '../../packages/rules/src/world/bootstrap';
import { validateWorldResources } from '../../packages/rules/src/world/validate';
import { hashState } from '../../packages/shared/src/node/hashState';
import { loadInitialWorld } from '../../apps/engine/src/world/resources';
import { integrationResourceRows } from '../integration-resources';
import { buildIntegrationScenario } from './integration-scenario';
import { buildOperationalMap } from './operational';

const root = new URL('../../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const resources = () => ({
  map: buildOperationalMap(),
  scenario: buildIntegrationScenario().scenario,
  unitSet: read('resources/unitset/basic.json'),
  statRules: read('resources/scenario/five-stats.json'),
  portraitMap: read('resources/portraits/191-map.json'),
});

it('INT-04 정식191년21국491명 자원은 생성 결과와 같고 연결 검증을 모두 통과한다', () => {
  const values = resources();
  expect(values.scenario).toEqual(read('resources/scenario/integration191.json'));
  expect(validateWorldResources(values).status).toBe('pass');
  const initial = buildInitialWorld({ ...values, seed: 'integration191-contract' });
  expect([initial.startYear, initial.nations.length, initial.generals.length, initial.cities.length]).toEqual([
    191, 21, 491, 61,
  ]);
  expect(initial.generals.every((general) => general.portraitId !== null)).toBe(true);
  expect(
    initial.nations.every(
      (nation) => initial.cities.find((city) => city.cityKey === nation.capitalCityKey)?.kind === 'CITY',
    ),
  ).toBe(true);
});

it('INT-04 인물 ID·소속·시기·성격·초기병력·금/쌀과 개인 시드 오프셋을 보존한다', () => {
  const seed = 'integration191-contract';
  const old = buildInitialWorld({
    map: read('resources/map/che.json'),
    scenario: read('resources/scenario/1030.json'),
    unitSet: read('resources/unitset/basic.json'),
    statRules: read('resources/scenario/default.json'),
    seed,
  });
  const current = buildInitialWorld({ ...resources(), seed });
  const keys = [
    'id',
    'userId',
    'name',
    'nationId',
    'affinity',
    'officerLevel',
    'birthYear',
    'deathYear',
    'activeFromYear',
    'personality',
    'special',
    'gold',
    'rice',
    'crew',
    'crewType',
    'train',
    'atmos',
    'experience',
    'dedication',
    'nextTurnTick',
  ] as const;
  expect(current.generals.map((general) => Object.fromEntries(keys.map((key) => [key, general[key]])))).toEqual(
    old.generals.map((general) => Object.fromEntries(keys.map((key) => [key, general[key]]))),
  );
  for (const nation of current.nations) {
    const withoutCapital = (value: object) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'capitalCityKey'));
    expect(withoutCapital(nation)).toEqual(withoutCapital(old.nations.find((row) => row.id === nation.id)!));
  }
});

it('INT-04 원본491행과 검수 원장의5값·출처·인물ID를 모두 보존하며 원본 파일을 바꾸지 않는다', () => {
  const original = read('resources/scenario/1030.json');
  const before = hashState(original);
  const generated = buildIntegrationScenario();
  expect(generated.scenario.general).toEqual(original.general);
  expect(generated.scenario.generalStats).toEqual(
    read('resources/officers/191-five-stats.json').rows.map(
      ({
        generalId,
        stats,
        sourceId,
        sourceRevision,
        officerId,
      }: {
        generalId: number;
        stats: unknown;
        sourceId: string;
        sourceRevision: string;
        officerId: number;
      }) => ({ generalId, stats, sourceId, sourceRevision, officerId }),
    ),
  );
  expect(hashState(read('resources/scenario/1030.json'))).toBe(before);
  const initial = buildInitialWorld({ ...resources(), seed: 'sourced' });
  for (const row of generated.scenario.generalStats) {
    const general = initial.generals.find((general) => general.id === row.generalId)!;
    expect(
      Object.fromEntries(
        ['leadership', 'strength', 'intel', 'politics', 'charm'].map((key) => [
          key,
          general[key as keyof typeof general],
        ]),
      ),
    ).toEqual(row.stats);
  }
});

it('INT-04 수도2건과 전장4건은 명시적 대응표로 남고 같은 이름의 양평을 섞지 않는다', () => {
  const generated = buildIntegrationScenario();
  expect({ removed: generated.removed, relocations: generated.relocations }).toEqual(
    read('resources/scenario/integration191-correspondence.json'),
  );
  expect(
    generated.removed
      .filter((row) => row.role === 'FIELD')
      .map((row) => row.legacyCityId)
      .sort((a, b) => a - b),
  ).toEqual([77, 81, 82, 89]);
  const initial = buildInitialWorld({ ...resources(), seed: 'mapping' });
  expect(initial.nations.find((nation) => nation.id === 12)?.capitalCityKey).toBe(21);
  expect(initial.nations.find((nation) => nation.id === 17)?.capitalCityKey).toBe(99);
  expect(initial.cities.find((city) => city.cityKey === 75)).toMatchObject({
    name: '양평관',
    nationId: 11,
    kind: 'PASS',
  });
  expect(initial.cities.find((city) => city.cityKey === 99)).toMatchObject({
    name: '양평',
    nationId: 17,
    kind: 'CITY',
  });
});

it('INT-04 새 규칙·초상 선택으로 정식 파일을 읽고 옛 기본 선택은 유지한다', async () => {
  const current = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'selection',
  });
  expect(current).toEqual(buildInitialWorld({ ...resources(), seed: 'selection' }));
  const legacy = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'selection' });
  expect(legacy).not.toHaveProperty('operationalMap');
  expect(legacy.generals[0]).not.toHaveProperty('politics');
  await expect(
    loadInitialWorld({ scenario: '1030', map: 'che', statRules: '../secret', seed: 'selection' }),
  ).rejects.toThrow('리소스 ID');
});

it('INT-04 게시 자원4종은 고정 명세의 이름·판·내용 해시·출처와 같다', async () => {
  const rows = await integrationResourceRows();
  expect(
    rows.map(({ kind, name, version, contentHash, source }) => ({ kind, name, version, contentHash, source })),
  ).toEqual(read('resources/integration-manifest.json'));
  expect(rows.map((row) => `${row.kind}/${row.name}/${row.version}`)).toEqual([
    'MAP/integration/1',
    'SCENARIO/integration191/1',
    'STAT_RULES/five-stats/1',
    'PORTRAIT_MAP/191-map/1',
  ]);
});
