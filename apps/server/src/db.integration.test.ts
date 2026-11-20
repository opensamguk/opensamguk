import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { createServerDb } from './db';
import { readTransactionOptions } from './readTransaction';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createServerDb(url);
const emailPrefix = `server-write-${randomUUID()}-`;

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { startsWith: emailPrefix } } });
  await db.$disconnect();
});

it('AC-M1-05/06: 30 default write transactions survive more than the default 2s pool wait', async () => {
  const users = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(1.1)`;
        return tx.user.create({ data: { email: `${emailPrefix}${index}@example.com`, passwordHash: 'unused' } });
      }),
    ),
  );
  expect(new Set(users.map((user) => user.id)).size).toBe(30);
  expect(await db.user.count({ where: { email: { startsWith: emailPrefix } } })).toBe(30);
});

it('AC-M1-05/06: the default execution timeout remains 5s and rolls writes back', async () => {
  await expect(
    db.$transaction(async (tx) => {
      await tx.user.create({ data: { email: `${emailPrefix}rollback@example.com`, passwordHash: 'unused' } });
      await tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(5.2)`;
    }),
  ).rejects.toMatchObject({ code: 'P2028', message: expect.stringContaining('5000 ms') });
  expect(await db.user.findUnique({ where: { email: `${emailPrefix}rollback@example.com` } })).toBeNull();
});

it('AC-M1-07/09: explicit read timeout and isolation still override client defaults', async () => {
  const isolation = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(5.2)`;
      return tx.$queryRaw<Array<{ transaction_isolation: string }>>`SHOW transaction_isolation`;
    },
    { ...readTransactionOptions },
  );
  expect(isolation[0]!.transaction_isolation).toBe('repeatable read');
});

it('AC-M1-05/06: the default isolation remains PostgreSQL read committed', async () => {
  const isolation = await db.$transaction(
    (tx) => tx.$queryRaw<Array<{ transaction_isolation: string }>>`SHOW transaction_isolation`,
  );
  expect(isolation[0]!.transaction_isolation).toBe('read committed');
});

it('AC-M1-05/06: an explicit maxWait still overrides the server default', async () => {
  let started = 0;
  let allStarted!: () => void;
  const occupied = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blockers = Array.from({ length: 10 }, () =>
    db.$transaction(async () => {
      if (++started === 10) allStarted();
      await held;
    }),
  );
  try {
    await occupied;
    const start = performance.now();
    await expect(db.$transaction(async () => null, { maxWait: 50 })).rejects.toMatchObject({
      code: 'P2028',
      message: expect.stringContaining('Unable to start a transaction'),
    });
    expect(performance.now() - start).toBeLessThan(1000);
  } finally {
    release();
    await Promise.all(blockers);
  }
});
