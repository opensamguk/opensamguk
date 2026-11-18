import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorldFromDb, readInitialResources, composeInitialWorld } from '../apps/engine/src/world/resources';
import { testDatabaseUrl } from './test-database';

const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
afterAll(async () => {
  await db.$disconnect();
});

describe('T2-02 배포 프리셋 파일', () => {
  it('AC-INT-28 프리셋 없는 1030 초기 해시는 현재 원생성 함수와 같고 결정적이다', async () => {
    const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 't2-02-legacy-baseline' });
    expect(Object.hasOwn(initial, 'presetRules')).toBe(false);
    const resources = await readInitialResources(db, { scenario: '1030', map: 'che' });
    const generated = composeInitialWorld(resources, 't2-02-legacy-baseline');
    expect(hashState(initial)).toBe(hashState(generated));
    expect(hashState(await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: initial.seed }))).toBe(
      hashState(generated),
    );
  });
});
