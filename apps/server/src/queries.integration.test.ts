import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { saveTestWorld } from '../test/saveTestWorld';
import { readWorld } from './queries';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let worldId: string;
beforeAll(async () => {
  worldId = (await saveTestWorld(db, { name: 'read snapshot', status: 'RUNNING' })).id;
});
afterAll(async () => {
  if (worldId) await db.world.delete({ where: { id: worldId } });
  await db.$disconnect();
});

it('AC-M1-07/09: a 30-procedure read burst survives more than the default 2s pool wait', async () => {
  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      readWorld(db, worldId, async (tx, world) => {
        await tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(1.1)`;
        return world.id;
      }),
    ),
  );
  expect(results).toEqual(Array.from({ length: 30 }, () => worldId));
});

it('AC-M1-07/09: a delayed read survives the default 5s execution budget', async () => {
  await expect(
    readWorld(db, worldId, async (tx, world) => {
      await tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(5.2)`;
      return world.id;
    }),
  ).resolves.toBe(worldId);
});

it('AC-M1-07/08: a concurrent commit cannot change the read snapshot', async () => {
  await readWorld(db, worldId, async (tx, world) => {
    const isolation = await tx.$queryRaw<Array<{ transaction_isolation: string }>>`SHOW transaction_isolation`;
    expect(isolation[0]!.transaction_isolation).toBe('repeatable read');
    await db.world.update({ where: { id: worldId }, data: { name: 'committed during read' } });
    expect((await tx.world.findUniqueOrThrow({ where: { id: worldId } })).name).toBe(world.name);
  });
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).name).toBe('committed during read');
});

it('AC-M1-07: missing worlds and callback errors still propagate', async () => {
  await expect(readWorld(db, '00000000-0000-4000-8000-000000000000', async () => null)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  const failure = new Error('read failed');
  await expect(
    readWorld(db, worldId, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
