import { afterAll, beforeAll, expect, it } from 'vitest';
import { hashState } from '../packages/shared/src/node/hashState';
import { composeInitialWorld, loadInitialWorldFromDb, readInitialResources } from '../apps/engine/src/world/resources';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';
import { initializeIntegrationResources } from './integration-resources';
const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
beforeAll(async () => {
  await initializeIntegrationResources(db);
});
afterAll(async () => {
  await db.$disconnect();
});

const selection = {
  map: 'integration',
  scenario: 'integration191',
  unitSet: 'basic',
  statRules: 'five-stats',
  portraitMap: '191-map',
};
let resources: Awaited<ReturnType<typeof readInitialResources>>;
beforeAll(async () => {
  resources = await readInitialResources(db, selection);
});
it('AC-P2-27 1판 별칭은 기존 파일·합성 결과와 해시가 같다', async () => {
  const plain = await loadInitialWorldFromDb(db, { ...selection, seed: 'resource-version' });
  const alias = Object.fromEntries(
    Object.entries(selection).map(([slot, key]) => [slot, `${key}@1`]),
  ) as typeof selection;
  expect(await loadInitialWorldFromDb(db, { ...alias, seed: 'resource-version' })).toEqual(plain);
  expect(hashState(composeInitialWorld(resources, 'resource-version'))).toBe(hashState(plain));
});
it('AC-P2-27 2판 합성은 내용 id를 보존하고 월드의 세 키만 정규형으로 고정한다', () => {
  const next = structuredClone(resources);
  for (const row of Object.values(next)) row.version = 2;
  const plain = composeInitialWorld(resources, 'resource-version');
  expect(composeInitialWorld(next, 'resource-version')).toEqual({
    ...plain,
    mapKey: 'integration@2',
    scenarioKey: 'integration191@2',
    unitSetKey: 'basic@2',
  });
  expect(next.unitSet.content).toEqual(resources.unitSet.content);
});
