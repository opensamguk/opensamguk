import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { emptyQueue, parsePreset, toWorldState, type WorldPreset } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive, type ReplayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { readView } from '../apps/server/src/game/queries';
import { displaySlots, readSlots } from '../apps/server/src/game/slots';
import { commandList } from '../apps/server/src/routers/commands';
import { testDatabaseUrl } from './test-database';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 테스트 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const ownName = `t403_off_${randomUUID().replaceAll('-', '')}_test`;
if (!/^t403_off_[a-f0-9]{32}_test$/.test(ownName)) throw new Error('시험 DB 이름을 확인하세요.');
const ownUrl = new URL(source),
  adminUrl = new URL(source);
ownUrl.pathname = `/${ownName}`;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href });
const client = new Client({ connectionString: ownUrl.href });
const db = createDb(ownUrl.href);
const now = 1_800_000_000_000;
const origin = 'http://127.0.0.1:5173';
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let base: string;
let preset: WorldPreset;
let created = false;
const leases: NonNullable<Awaited<ReturnType<typeof acquireLease>>>[] = [];

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${ownName}"`);
  created = true;
  await client.connect();
  const directory = new URL('../packages/db/prisma/migrations/', import.meta.url);
  const migrations = (await readdir(directory))
    .filter((name) => /^\d/.test(name) && name <= '20261023072000_world_ext_slices')
    .sort();
  expect(migrations).toHaveLength(17);
  expect(migrations.at(-1)).toBe('20261023072000_world_ext_slices');
  for (const name of migrations)
    await client.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
  preset = parsePreset(
    JSON.parse(await readFile(new URL('../resources/preset/regular.json', import.meta.url), 'utf8')),
  );
  app = await buildServer({ db, now: () => now, logging: false, publicOrigin: origin });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  try {
    if (created) for (const lease of leases) await releaseLease(db, lease);
    await app?.close();
  } finally {
    try {
      await Promise.all([db.$disconnect(), client.end()]);
      if (created) {
        expect(
          (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [ownName])).rows,
        ).toEqual([{ count: 0 }]);
        await admin.query(`DROP DATABASE "${ownName}"`);
        expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [ownName])).rows).toEqual([]);
      }
    } finally {
      await admin.end();
    }
  }
});

async function user(status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE') {
  const row = await db.user.create({
    data: { email: `t403-${randomUUID()}@example.invalid`, passwordHash: 'unused-fixture', status },
  });
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: row.id, expiresAt: session.expiresAt } });
  return { id: row.id, cookie: `sid=${session.token}` };
}

async function fixture(options: { preset?: WorldPreset; legacy?: boolean; status?: 'PAUSED' | 'RUNNING' } = {}) {
  const alice = await user(),
    bob = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.map((general, index) => ({
    ...general,
    userId: index === 0 ? alice.id : index === 1 ? bob.id : null,
    nextTurnTick: 1000 + index,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '확장 끈 월드',
    turnTermMinutes: 60,
    endYear: null,
    ...(options.legacy ? { replayFormat: 'legacy' as const } : {}),
    ...(options.preset ? { preset: { key: 'off', value: options.preset } } : {}),
  });
  await db.world.update({
    where: { id: worldId },
    data: { status: options.status ?? 'PAUSED', clockTick: 600, clockAnchorAt: new Date(now) },
  });
  return { worldId, alice, bob, initial };
}

async function loopFor(worldId: string, hooks: ConstructorParameters<typeof TurnLoop>[2] = {}) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  return new TurnLoop(db, lease, hooks);
}

async function snapshot(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    slots: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    events: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    months: await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } }),
    logs: await db.generalLog.findMany({ where: { worldId }, orderBy: [{ tick: 'asc' }, { generalId: 'asc' }] }),
    slices: await client.query(
      'SELECT "key", "value", xmin::text FROM "WorldExtSlice" WHERE "worldId"=$1 ORDER BY "key"',
      [worldId],
    ),
  };
}

async function marker(worldId: string) {
  const generals = await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
  await db.generalTurn.createMany({
    data: generals.flatMap((general) =>
      emptyQueue().map((turn, slot) => ({ ...turn, args: {}, worldId, generalId: general.id, slot })),
    ),
  });
  return db.inputEvent.create({
    data: {
      worldId,
      userId: 'system:policy',
      kind: 'system.policy.enable',
      idempotencyKey: 'system.policy.enable:5',
      payload: { version: 5, emptySlots: generals.map((general) => general.id) },
    },
  });
}

async function rpc(path: string, input: unknown, cookie?: string, mutation = false) {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const body = (
    (await response.json()) as Array<{
      result?: { data: Record<string, unknown> };
      error?: { data: { code: string }; message: string };
    }>
  )[0]!;
  return {
    status: response.status,
    data: body.result?.data,
    error: body.error?.data.code,
    message: body.error?.message,
  };
}
const slots = () => Array.from({ length: 30 }, () => ({ commandKey: 'farm', args: {} }));

it.each([false, true])('off 생성·적재·표시는 ext 키와 행을 만들지 않는다 (preset=%s)', async (withPreset) => {
  const f = await fixture(withPreset ? { preset } : {});
  const saved = await readWorldState(db, f.worldId);
  expect(hashState(saved)).toBe((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).initialStateHash);
  const state = await db.$transaction((tx) => loadWorld(tx, f.worldId));
  const view = await db.$transaction((tx) => readView(tx, f.worldId));
  expect(state).toEqual(toWorldState(saved));
  for (const value of [saved, state, view]) expect(Object.hasOwn(value, 'ext')).toBe(false);
  expect(await db.worldExtSlice.count({ where: { worldId: f.worldId } })).toBe(0);
  const list = await rpc('commands.list', { worldId: f.worldId }, f.alice.cookie);
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.data)).toBe(JSON.stringify(commandList));
  const turns = await rpc('turns.get', { worldId: f.worldId }, f.alice.cookie);
  expect(JSON.stringify(turns.data?.slots)).toBe(
    JSON.stringify(displaySlots(await db.$transaction((tx) => readSlots(tx, f.worldId, 1)))),
  );
});

it('무상태 계략도 생성 트랜잭션 전에 거부하며 월드가 늘지 않는다', async () => {
  const before = await db.world.count();
  await expect(
    saveInitialWorld(db, commandInitial(), {
      name: '거부',
      turnTermMinutes: 60,
      endYear: null,
      preset: { key: 'enabled', value: { ...preset, commands: { general: ['fire_attack'], nation: [] } } },
    }),
  ).rejects.toThrow('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
  expect(await db.world.count()).toBe(before);
});

it('저장된 non-null commands는 세 적재와 엔진 입력 처리 전에 거부된다', async () => {
  const f = await fixture({ legacy: true });
  await marker(f.worldId);
  await db.world.update({
    where: { id: f.worldId },
    data: { preset: { ...preset, commands: { general: ['fire_attack'], nation: [] } } as Prisma.InputJsonValue },
  });
  const before = await snapshot(f.worldId);
  const loop = await loopFor(f.worldId);
  for (const read of [
    () => readWorldState(db, f.worldId),
    () => db.$transaction((tx) => loadWorld(tx, f.worldId)),
    () => db.$transaction((tx) => readView(tx, f.worldId)),
    () => loop.advanceTo(600),
  ])
    await expect(read()).rejects.toThrow('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
  expect(await snapshot(f.worldId)).toEqual(before);
});

it.each(['PAUSED', 'RUNNING'] as const)(
  'D1/D5 실패와 commit 실패 뒤 같은 loop가 다시 대조하고 T 표지를 보존한다 (%s)',
  async (status) => {
    const f = await fixture({ legacy: true, status });
    const event = await marker(f.worldId);
    let failCommit = true;
    const loop = await loopFor(f.worldId, {
      beforeCommit: async () => {
        if (failCommit) {
          failCommit = false;
          throw new Error('off commit boundary');
        }
      },
    });
    const orphan = () =>
      client.query('INSERT INTO "WorldExtSlice" ("worldId", "key", "value") VALUES ($1,$2,$3::jsonb)', [
        f.worldId,
        'orphan',
        'null',
      ]);
    await orphan();
    const corrupt = await snapshot(f.worldId);
    await expect(loop.advanceTo(600)).rejects.toThrow();
    expect(await snapshot(f.worldId)).toEqual(corrupt);
    await db.worldExtSlice.deleteMany({ where: { worldId: f.worldId } });
    const clean = await snapshot(f.worldId);
    await expect(loop.advanceTo(600)).rejects.toThrow('off commit boundary');
    expect(await snapshot(f.worldId)).toEqual(clean);
    await orphan();
    const retried = await snapshot(f.worldId);
    await expect(loop.advanceTo(600)).rejects.toThrow();
    expect(await snapshot(f.worldId)).toEqual(retried);
    await db.worldExtSlice.deleteMany({ where: { worldId: f.worldId } });
    await loop.advanceTo(600);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'APPLIED',
      result: { baselineActiveTick: 600 },
    });
    const humans = await db.general.findMany({ where: { worldId: f.worldId, userId: { not: null } } });
    expect(humans.map((general) => general.lastActiveTick)).toEqual([600, 600]);
    expect(
      (await db.general.findMany({ where: { worldId: f.worldId, userId: null } })).every(
        (general) => general.lastActiveTick === null,
      ),
    ).toBe(true);
    expect(Object.hasOwn(await db.$transaction((tx) => loadWorld(tx, f.worldId)), 'ext')).toBe(false);
  },
);

it('실제 턴·월간 저장은 off 행 없이 정책 options와 snapshot 해시를 보존한다', async () => {
  const f = await fixture({ status: 'RUNNING' });
  await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { defaultPolicy: 'farm' } });
  const loop = await loopFor(f.worldId);
  await loop.advanceTo(1000);
  expect(
    await db.generalLog.findFirst({ where: { worldId: f.worldId, generalId: 1 }, orderBy: { tick: 'asc' } }),
  ).toMatchObject({ commandKey: 'farm', kind: 'success' });
  await loop.advanceTo(10000);
  const month = await db.yearbookSnapshot.findUniqueOrThrow({
    where: { worldId_tick: { worldId: f.worldId, tick: 10000 } },
  });
  expect(month.stateHash).toBe(hashState(await db.$transaction((tx) => loadReplayState(tx, f.worldId))));
  expect(await db.worldExtSlice.count({ where: { worldId: f.worldId } })).toBe(0);
  expect(Object.hasOwn(loop.state!, 'ext')).toBe(false);
});

it('legacy 12개월 골든과 archive 2 바이트는 off 적재 뒤에도 같다', async () => {
  const archive = JSON.parse(
    await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
  ) as ReplayArchive;
  const { worldId } = await saveInitialWorld(db, archive.origin.initial, {
    name: '기존 골든',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'legacy',
  });
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const loop = await loopFor(worldId);
  await loop.advanceTo(120000);
  const before = await exportReplay(db, worldId);
  expect(before.version).toBe(2);
  expect(replayArchive(before, 12).at(-1)?.stateHash).toBe(
    'd60ad5f09185a889fc64926efe4e367e1b909710b227e76e3005698e71d80a0b',
  );
  await readWorldState(db, worldId);
  await db.$transaction((tx) => readView(tx, worldId));
  expect(JSON.stringify(await exportReplay(db, worldId))).toBe(JSON.stringify(before));
  expect(await db.worldExtSlice.count({ where: { worldId } })).toBe(0);
});

for (const path of ['commands.list', 'turns.get', 'turns.set', 'turns.edit', 'turns.precheck'] as const)
  it(`${path} 성공·무인증·제재·다른 사용자·잘못된 입력을 실제 HTTP로 확인한다`, async () => {
    const f = await fixture();
    const sanctioned = await user('SANCTIONED');
    const mutation = path === 'turns.set' || path === 'turns.edit';
    const input = {
      worldId: f.worldId,
      ...(path === 'turns.set'
        ? { revision: 0, slots: slots() }
        : path === 'turns.edit'
          ? { revision: 0, op: { put: { from: 0, to: 0, commandKey: 'farm', args: {} } } }
          : path === 'turns.precheck'
            ? { commandKey: 'farm', args: {} }
            : {}),
    };
    for (const [category, cookie] of [
      ['unauthenticated', undefined],
      ['sanctioned', sanctioned.cookie],
    ] as const)
      await authzCase(path, category, async () => {
        expect((await rpc(path, input, cookie, mutation)).error).toBe('UNAUTHORIZED');
      })();
    await authzCase(path, 'invalidInput', async () => {
      expect((await rpc(path, { ...input, worldId: '' }, f.alice.cookie, mutation)).error).toBe('BAD_REQUEST');
    })();
    await authzCase(path, 'success', async () => {
      expect((await rpc(path, input, f.alice.cookie, mutation)).status).toBe(200);
    })();
    const aliceBefore = await db.generalTurn.findMany({
      where: { worldId: f.worldId, generalId: 1 },
      orderBy: { slot: 'asc' },
    });
    await authzCase(path, 'otherUser', async () => {
      expect((await rpc(path, input, f.bob.cookie, mutation)).status).toBe(200);
      expect(
        await db.generalTurn.findMany({ where: { worldId: f.worldId, generalId: 1 }, orderBy: { slot: 'asc' } }),
      ).toEqual(aliceBefore);
    })();
  });

it('save의 오류 순서·STALE·explicit·활동 tick과 응답 이름을 보존한다', async () => {
  const f = await fixture();
  const bad = {
    worldId: 'missing',
    revision: 99,
    slots: [{ commandKey: 'fire_attack', args: {} }, ...slots().slice(1)],
  };
  expect(await rpc('turns.set', bad, f.alice.cookie, true)).toMatchObject({
    error: 'BAD_REQUEST',
    message: '명령과 인자를 확인하세요.',
  });
  expect((await rpc('turns.set', { ...bad, slots: slots() }, f.alice.cookie, true)).error).toBe('NOT_FOUND');
  await db.world.update({ where: { id: f.worldId }, data: { status: 'ENDED', policyFromSequence: null } });
  expect(
    await rpc('turns.set', { worldId: f.worldId, revision: 99, slots: slots() }, f.alice.cookie, true),
  ).toMatchObject({ message: '종료된 월드입니다.' });
  await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED' } });
  expect(
    await rpc('turns.set', { worldId: f.worldId, revision: 99, slots: slots() }, f.alice.cookie, true),
  ).toMatchObject({ message: '기본 방침 전환을 기다리고 있습니다.' });
  await db.world.update({ where: { id: f.worldId }, data: { policyFromSequence: 0 } });
  const before = await snapshot(f.worldId);
  const stale = await rpc('turns.set', { worldId: f.worldId, revision: 99, slots: slots() }, f.alice.cookie, true);
  expect(stale.data).toMatchObject({ ok: false, reason: 'STALE', revision: 0 });
  expect(await snapshot(f.worldId)).toEqual(before);
  const saved = await rpc('turns.set', { worldId: f.worldId, revision: 0, slots: slots() }, f.alice.cookie, true);
  expect(saved.data).toMatchObject({ ok: true, revision: 1 });
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).toMatchObject({
    lastActiveTick: 600,
    turnRevision: 1,
  });
  expect(
    (await db.generalTurn.findMany({ where: { worldId: f.worldId, generalId: 1 } })).every((turn) => turn.explicit),
  ).toBe(true);
  expect(JSON.stringify(saved.data?.slots)).toBe(
    JSON.stringify(displaySlots(await db.$transaction((tx) => readSlots(tx, f.worldId, 1)))),
  );
});
