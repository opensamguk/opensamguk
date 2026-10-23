import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { assertStorableJson } from '../packages/db/src/storableJson';
import { readWorldExtRows, writeWorldExtChanges } from '../packages/db/src/worldExt';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl(process.env);
const schema = `t403_${randomUUID().replaceAll('-', '')}`;
url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDb(url.href);

beforeAll(async () => {
  // 식별자는 위 UUID로만 만든다. 다른 시험과 겹치지 않는 스키마에서 DB 함수만 검증한다.
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await db.$executeRaw`CREATE TABLE "WorldExtSlice" (
    "worldId" text NOT NULL, "key" text NOT NULL, "value" jsonb NOT NULL,
    PRIMARY KEY ("worldId", "key")
  )`;
  await db.$executeRaw`CREATE TABLE "T4ExtMarker" ("worldId" text NOT NULL)`;
});
afterAll(async () => {
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await db.$disconnect();
  }
});

async function seed(worldId: string, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values))
    await db.$executeRaw`INSERT INTO "WorldExtSlice" ("worldId", "key", "value")
      VALUES (${worldId}, ${key}, ${JSON.stringify(value)}::jsonb)`;
}
async function revisions(worldId: string) {
  return db.$queryRaw<{ key: string; revision: string }[]>`
    SELECT "key", xmin::text AS revision FROM "WorldExtSlice" WHERE "worldId" = ${worldId} ORDER BY "key"
  `;
}

it('원시 JSON 조각을 읽고 바뀐 행만 갱신하며 다른 월드에는 쓰지 않는다', async () => {
  const world = randomUUID();
  const other = randomUUID();
  const before = { same: { a: 1, b: [2] }, changed: null, scalar: '한글\ud83d\ude00', zero: 0 };
  await seed(world, before);
  await seed(other, before);
  const old = await revisions(world);
  const otherOld = await revisions(other);
  expect(await db.$transaction((tx) => readWorldExtRows(tx, world))).toEqual(before);
  const next = { same: { b: [2], a: 1 }, changed: [true, false, {}, []], scalar: before.scalar, zero: 0 };
  await db.$transaction((tx) => writeWorldExtChanges(tx, world, before, next));
  expect(await db.$transaction((tx) => readWorldExtRows(tx, world))).toEqual(next);
  for (const row of await revisions(world)) {
    const previous = old.find(({ key }) => key === row.key)!.revision;
    if (row.key === 'changed') expect(row.revision).not.toBe(previous);
    else expect(row.revision).toBe(previous);
  }
  expect(await revisions(other)).toEqual(otherOld);
  expect(await db.$transaction((tx) => readWorldExtRows(tx, other))).toEqual(before);
});

it('끈 월드에는 행이 없고 undefined 저장은 아무 행도 만들지 않는다', async () => {
  const world = randomUUID();
  await db.$transaction((tx) => writeWorldExtChanges(tx, world, undefined, undefined));
  expect(await db.$transaction((tx) => readWorldExtRows(tx, world))).toBeUndefined();
});

it('커밋 직전 예외면 조각과 같은 트랜잭션의 기록을 모두 되돌린다', async () => {
  const world = randomUUID();
  const before = { a: { count: 1 }, b: true };
  await seed(world, before);
  await expect(
    db.$transaction(async (tx) => {
      await writeWorldExtChanges(tx, world, before, { a: { count: 2 }, b: false });
      await tx.$executeRaw`INSERT INTO "T4ExtMarker" ("worldId") VALUES (${world})`;
      throw new Error('commit boundary');
    }),
  ).rejects.toThrow('commit boundary');
  expect(await db.$transaction((tx) => readWorldExtRows(tx, world))).toEqual(before);
  expect(await db.$queryRaw`SELECT * FROM "T4ExtMarker" WHERE "worldId" = ${world}`).toEqual([]);
});

it('key 집합 변경과 잘못된 뒤쪽 조각은 앞쪽 행을 쓰기 전에 거부한다', async () => {
  const world = randomUUID();
  const before = { a: 1, b: 2 };
  await seed(world, before);
  const old = await revisions(world);
  for (const next of [undefined, {}, { a: 3 }, { a: 3, b: 2, c: 4 }, { a: 3, b: '\u0000' }]) {
    await db.$transaction(async (tx) => {
      await expect(writeWorldExtChanges(tx, world, before, next)).rejects.toThrow();
    });
    expect(await revisions(world)).toEqual(old);
  }
  for (const previous of [undefined, {}, { a: '\ud800', b: 2 }])
    await expect(db.$transaction((tx) => writeWorldExtChanges(tx, world, previous, before))).rejects.toThrow();
});

it('없어진 행은 update 0건 오류로 거부하고 앞서 쓴 행도 롤백한다', async () => {
  const world = randomUUID();
  await seed(world, { a: 1 });
  await expect(
    db.$transaction((tx) => writeWorldExtChanges(tx, world, { a: 1, b: 2 }, { a: 3, b: 4 })),
  ).rejects.toThrow('저장된 확장 상태의 조각을 확인하세요.');
  expect(await db.$transaction((tx) => readWorldExtRows(tx, world))).toEqual({ a: 1 });
});

it('U+0000·짝 없는 대리 코드·-0은 쓰기 전에 거부하며 DB 값과 revision이 같다', async () => {
  const world = randomUUID();
  const before = { value: 1 };
  await seed(world, before);
  const old = await revisions(world);
  for (const value of ['\u0000', '\ud800', '\udfff', -0, { nested: [-0] }, { '\u0000': 1 }]) {
    await expect(db.$transaction((tx) => writeWorldExtChanges(tx, world, before, { value }))).rejects.toThrow();
    expect(await db.$transaction((tx) => readWorldExtRows(tx, world))).toEqual(before);
    expect(await revisions(world)).toEqual(old);
  }
});

it('PostgreSQL JSONB는 금지 문자열을 거부하고 -0은 0으로 바꾼다', async () => {
  for (const value of ['\u0000', '\ud800', '\udfff'])
    await expect(db.$queryRaw`SELECT ${JSON.stringify(value)}::jsonb AS value`).rejects.toThrow();
  const rows = await db.$queryRaw<{ value: unknown }[]>`SELECT '-0'::jsonb AS value`;
  expect(rows[0]!.value).toBe(0);
  expect(Object.is(rows[0]!.value, -0)).toBe(false);
  expect(() => assertStorableJson(JSON.parse('-0'), 'archive')).toThrow();
});

it('DB에서 읽은 예약 key와 조각 안의 예약 key를 거부한다', async () => {
  for (const values of [JSON.parse('{"__proto__":1}'), { value: { constructor: 1 } }]) {
    const world = randomUUID();
    await seed(world, values);
    await expect(db.$transaction((tx: Prisma.TransactionClient) => readWorldExtRows(tx, world))).rejects.toThrow();
  }
});
