import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { testDatabaseUrl } from './test-database';

const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
afterAll(async () => {
  await db.$disconnect();
});

describe('T2-02 배포 프리셋 파일', () => {
  it('프리셋 없는 1030 초기 해시가 구현 전 골든과 같다', async () => {
    const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 't2-02-legacy-baseline' });
    expect(Object.hasOwn(initial, 'presetRules')).toBe(false);
    expect(hashState(initial)).toBe('2952fcf863e11af5879fd8af160d9a729b9032ce443d838eb633d8d901189e16');
  });
});
