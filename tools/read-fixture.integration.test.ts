import { afterAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb, loadSexLedger } from '../apps/engine/src/world/resources';
import { loadWorld } from '../apps/engine/src/worldLoader';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || process.env.DATABASE_URL !== connectionString)
  throw Error('고정물과 저장에 같은 전용 시험 DB가 필요합니다.');
const url = new URL(connectionString);
if (!url.pathname.endsWith('_test')) throw Error('전용 시험 DB가 필요합니다.');
const db = createDb(connectionString);
afterAll(() => db.$disconnect());
const options = { name: 'AC-INT-27 합성 고정물 회귀', turnTermMinutes: 60, endYear: null };

it.each([4, 6])('AC-INT-27 readFixture 장수 %i명의 합성 월드를 실제 DB에 만들고 지운다', async (count) => {
  const initial = await readFixture();
  expect(initial.scenarioKey).toBe('test-visibility');
  expect(loadSexLedger(initial.scenarioKey)).toBeUndefined();
  if (count === 6) {
    initial.generals.push({ ...initial.generals[2]!, id: 5 }, { ...initial.generals[0]!, id: 6 });
    initial.generals = initial.generals.map((general, index) => ({ ...general, name: `시험장수${index + 1}` }));
  }
  const { worldId } = await saveInitialWorld(db, initial, options);
  try {
    expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toMatchObject({
      scenarioKey: 'test-visibility',
      mapKey: initial.mapKey,
    });
    const generals = await db.general.findMany({ where: { worldId } });
    expect(generals).toHaveLength(count);
    expect(generals.every((general) => general.sex === 'UNKNOWN')).toBe(true);
    expect(Object.keys((await loadWorld(db, worldId)).generals)).toHaveLength(count);
  } finally {
    await db.world.delete({ where: { id: worldId } });
    expect(await db.world.count({ where: { id: worldId } })).toBe(0);
    expect(await db.general.count({ where: { worldId } })).toBe(0);
  }
});

it('AC-INT-27 실제 1030/che는 원장을 적용하고 인물 손상을 저장 전에 거부한다', async () => {
  const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 'int27-fixture-ledger' });
  const ledger = loadSexLedger(initial.scenarioKey);
  expect(ledger).toBeDefined();
  const { worldId } = await saveInitialWorld(db, initial, options);
  try {
    for (const row of ledger!.rows) {
      expect(
        await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: row.generalId } } }),
      ).toMatchObject({
        name: row.name,
        sex: row.sex,
      });
    }
  } finally {
    await db.world.delete({ where: { id: worldId } });
    expect(await db.world.count({ where: { id: worldId } })).toBe(0);
  }
  const before = await db.world.count();
  const damaged = structuredClone(initial);
  damaged.generals.find((general) => general.id === ledger!.rows[0]!.generalId)!.name = '손상된이름';
  await expect(saveInitialWorld(db, damaged, options)).rejects.toThrow('ID·이름');
  damaged.generals = initial.generals.filter((general) => general.id !== ledger!.rows[0]!.generalId);
  await expect(saveInitialWorld(db, damaged, options)).rejects.toThrow('ID·이름');
  expect(await db.world.count()).toBe(before);
});
