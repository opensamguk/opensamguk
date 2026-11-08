import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadSexLedger, loadSexLedgers, readInitialResources } from '../apps/engine/src/world/resources';
import type { ScenarioResource } from '../packages/rules/src/world/resources';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';

const selectedResources = await (async () => {
  const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
  try {
    return await readInitialResources(db, { map: 'che', scenario: '1030' });
  } finally {
    await db.$disconnect();
  }
})();

const scenario = selectedResources.scenario.content as ScenarioResource;
const read = (path: string) => JSON.parse(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
it('AC-P2-32 검토된 성별 사실 해시와 191년 시나리오의 인물 대응을 대조한다', () => {
  const ledgers = loadSexLedgers(),
    identities = read('resources/officers/191-five-stats.json').rows;
  for (const ledger of ledgers)
    for (const row of ledger.rows) {
      expect(identities.find((person: { generalId: number }) => person.generalId === row.generalId)).toMatchObject({
        name: row.name,
        identity: row.identity,
      });
      for (const key of ledger.scenarios) {
        const file = key === 'san10-191@1' ? 'san10-191' : key === 'san10-191@2' ? 'san10-191-v2' : key;
        const general = key === '1030' ? scenario.general : read('resources/scenario/' + file + '.json').general;
        expect(general[row.generalId - 1]![1]).toBe(row.name);
      }
    }
  expect(ledgers[0]!.rows.map((row) => [row.generalId, row.sex])).toEqual([
    [108, 'MALE'],
    [439, 'FEMALE'],
  ]);
  expect(loadSexLedger().rows.map((row) => [row.generalId, row.sex])).toEqual([
    [108, 'MALE'],
    [439, 'FEMALE'],
    [47, 'MALE'],
    [281, 'MALE'],
    [322, 'MALE'],
    [314, 'MALE'],
    [318, 'MALE'],
    [321, 'MALE'],
    [229, 'MALE'],
    [167, 'MALE'],
    [169, 'MALE'],
    [381, 'MALE'],
    [394, 'MALE'],
    [385, 'MALE'],
    [266, 'MALE'],
    [271, 'MALE'],
    [267, 'MALE'],
    [276, 'MALE'],
    [291, 'MALE'],
    [100, 'MALE'],
    [103, 'MALE'],
    [99, 'MALE'],
    [93, 'MALE'],
  ]);
});
