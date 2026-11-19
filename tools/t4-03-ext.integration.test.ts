import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, type Prisma } from '../packages/db/src/index';
import { commandPlayerDocs, resolverForRuleFeatures, parsePreset, type WorldPreset } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { saveFixtureWorld as saveInitialWorld } from '../e2e/worldFixture';
import { readWorldState } from '../apps/engine/src/world/persistence';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive, type ReplayArchiveV3 } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { readView } from '../apps/server/src/game/queries';
import { displaySlots, readSlots } from '../apps/server/src/game/slots';
import { ciGreenDatabaseName, testDatabaseUrl } from './test-database';

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
const ownName = ciGreenDatabaseName(`opensamguk_ci_green_${randomUUID().replaceAll('-', '').slice(0, 20)}_test`);
if (!(/^opensamguk_ci_green_[a-f0-9]{20}_test$/.test(ownName) || ownName === ciGreenDatabaseName('')))
  throw new Error('시험 DB 이름을 확인하세요.');
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
  const migrations = (await readdir(directory)).filter((name) => /^\d/.test(name)).sort();
  const requiredMigrationNames = [
    '20261020000000_initial_world',
    '20261020010000_world_clock',
    '20261020020000_accounts',
    '20261020030000_engine_turns',
    '20261020040000_monthly_replay',
    '20261021030000_commands_war',
    '20261021040000_rankings',
    '20261021080000_engine_heartbeat',
    '20261023000000_world_outcome',
    '20261023010000_public_map_snapshot',
    '20261023020000_nation_display_archive',
    '20261023030000_messaging_realtime',
    '20261023040000_world_presets',
    '20261023050000_default_policy',
    '20261023060000_operation_plans',
    '20261023071000_nation_offices',
    '20261023072000_world_ext_slices',
    '20261023073000_treaties',
  ];
  expect(migrations.slice(0, requiredMigrationNames.length)).toEqual(requiredMigrationNames);
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
        // Closing the client socket can precede PostgreSQL removing its backend.
        let activity = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [
          ownName,
        ]);
        for (let attempt = 0; activity.rows[0]?.count !== 0 && attempt < 20; attempt++) {
          await delay(50);
          activity = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [
            ownName,
          ]);
        }
        expect(activity.rows).toEqual([{ count: 0 }]);
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

async function fixture(options: { preset?: WorldPreset; status?: 'PAUSED' | 'RUNNING' } = {}) {
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
    replayFormat: 3,
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

it.each([false, true])('현행 생성·적재·표시는 intel 조각을 보존한다 (preset=%s)', async (withPreset) => {
  const f = await fixture(withPreset ? { preset } : {});
  const saved = await readWorldState(db, f.worldId);
  expect(saved.generals[0]!.userId).toBe(f.alice.id);
  const state = await db.$transaction((tx) => loadWorld(tx, f.worldId));
  const view = await db.$transaction((tx) => readView(tx, f.worldId));
  expect(state.generals[1]!.userId).toBe(f.alice.id);
  expect(state.generals[2]!.userId).toBe(f.bob.id);
  expect(saved).not.toHaveProperty('ext');
  for (const value of [state, view]) expect(value.ext).toEqual({ intel: {} });
  expect(await db.worldExtSlice.count({ where: { worldId: f.worldId } })).toBe(1);
  const list = await rpc('commands.list', { worldId: f.worldId }, f.alice.cookie);
  expect(list.status).toBe(200);
  expect(list.data).toEqual(
    resolverForRuleFeatures({})!
      .list('general')
      .map((command) => {
        const doc = commandPlayerDocs[command.key]!;
        return {
          key: command.key,
          name: command.name,
          category: command.category,
          argsSchema: z.toJSONSchema(command.args, { io: 'input' }),
          description: doc.summary,
          cost: doc.cost,
          requirements: doc.requires,
          turns: 1,
          available: expect.toSatisfy((value) => value === null || typeof value === 'boolean'),
          reason: expect.toSatisfy((value) => value === null || typeof value === 'string'),
        };
      }),
  );
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
  ).rejects.toThrow('월드별 명령 선택은 지원하지 않습니다.');
  expect(await db.world.count()).toBe(before);
});

it('저장된 non-null commands는 세 적재와 엔진 입력 처리 전에 거부된다', async () => {
  const f = await fixture();
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
  '현행 intel 손상과 commit 실패 뒤 같은 loop가 재검사한다 (%s)',
  async (status) => {
    const f = await fixture({ status });
    const input = await db.inputEvent.create({
      data: {
        worldId: f.worldId,
        userId: f.alice.id,
        generalId: 1,
        kind: 'general.setPolicy',
        idempotencyKey: randomUUID(),
        payload: { policy: 'farm' },
      },
    });
    let failCommit = true;
    const loop = await loopFor(f.worldId, {
      beforeCommit: async () => {
        if (failCommit) {
          failCommit = false;
          throw Error('intel-commit-boundary');
        }
      },
    });
    await client.query('INSERT INTO "WorldExtSlice" ("worldId","key","value") VALUES ($1,$2,$3::jsonb)', [
      f.worldId,
      'orphan',
      'null',
    ]);
    const before = await snapshot(f.worldId);
    await expect(loop.advanceTo(1000)).rejects.toThrow();
    expect(await snapshot(f.worldId)).toEqual(before);
    await db.worldExtSlice.deleteMany({ where: { worldId: f.worldId, key: 'orphan' } });
    const clean = await snapshot(f.worldId);
    await expect(loop.advanceTo(1000)).rejects.toThrow('intel-commit-boundary');
    expect(await snapshot(f.worldId)).toEqual(clean);
    await client.query('INSERT INTO "WorldExtSlice" ("worldId","key","value") VALUES ($1,$2,$3::jsonb)', [
      f.worldId,
      'orphan',
      'null',
    ]);
    const retried = await snapshot(f.worldId);
    await expect(loop.advanceTo(1000)).rejects.toThrow();
    expect(await snapshot(f.worldId)).toEqual(retried);
    await db.worldExtSlice.deleteMany({ where: { worldId: f.worldId, key: 'orphan' } });
    await loop.advanceTo(1000);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: input.id } })).toMatchObject({ status: 'APPLIED' });
    expect((await db.$transaction((tx) => loadWorld(tx, f.worldId))).ext).toEqual({ intel: {} });
  },
);

it('실제 턴·월간 저장은 방침 입력·intel 조각과 snapshot 해시를 보존한다', async () => {
  const f = await fixture({ status: 'RUNNING' });
  await db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: f.alice.id,
      generalId: 1,
      kind: 'general.setPolicy',
      idempotencyKey: randomUUID(),
      payload: { policy: 'farm' },
    },
  });
  const loop = await loopFor(f.worldId);
  await loop.advanceTo(1000);
  expect(
    await db.generalLog.findFirst({
      where: { worldId: f.worldId, generalId: 1, commandKey: 'farm' },
      orderBy: { tick: 'asc' },
    }),
  ).toMatchObject({ commandKey: 'farm', kind: 'success' });
  await loop.advanceTo(10000);
  const month = await db.yearbookSnapshot.findUniqueOrThrow({
    where: { worldId_tick: { worldId: f.worldId, tick: 10000 } },
  });
  expect(month.stateHash).toBe(hashState(await db.$transaction((tx) => loadReplayState(tx, f.worldId))));
  expect(await db.worldExtSlice.count({ where: { worldId: f.worldId } })).toBe(1);
  expect(loop.state!.ext).toEqual({ intel: {} });
});

it('현행 형식3 12개월 골든은 적재 뒤에도 동일하다', async () => {
  const archive = JSON.parse(
    await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
  ) as ReplayArchiveV3;
  const { worldId } = await saveInitialWorld(db, archive.origin.initial, {
    name: '기존 골든',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
  });
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const loop = await loopFor(worldId);
  await loop.advanceTo(120000);
  const before = await exportReplay(db, worldId);
  expect(before.version).toBe(3);
  expect(replayArchive(before, 12).at(-1)?.stateHash).toBe(archive.months.at(-1)!.stateHash);
  await readWorldState(db, worldId);
  await db.$transaction((tx) => readView(tx, worldId));
  expect(JSON.stringify(await exportReplay(db, worldId))).toBe(JSON.stringify(before));
  expect(await db.worldExtSlice.count({ where: { worldId } })).toBe(1);
});

for (const path of ['commands.list', 'turns.get', 'turns.set', 'turns.edit', 'turns.precheck'] as const)
  it(`${path} 성공·무인증·제재·다른 사용자·잘못된 입력을 실제 HTTP로 확인한다`, async () => {
    const f = await fixture();
    const sanctioned = await user('SANCTIONED');
    const mutation = path === 'turns.set' || path === 'turns.edit';
    const input = {
      worldId: f.worldId,
      ...(path === 'turns.set'
        ? { revision: 1, slots: slots() }
        : path === 'turns.edit'
          ? { revision: 1, op: { put: { from: 0, to: 0, commandKey: 'farm', args: {} } } }
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
    revision: 100,
    slots: [{ commandKey: 'fire_attack', args: {} }, ...slots().slice(1)],
  };
  expect(await rpc('turns.set', bad, f.alice.cookie, true)).toMatchObject({
    error: 'BAD_REQUEST',
    message: '명령과 인자를 확인하세요.',
  });
  expect((await rpc('turns.set', { ...bad, slots: slots() }, f.alice.cookie, true)).error).toBe('NOT_FOUND');
  await db.world.update({ where: { id: f.worldId }, data: { status: 'ENDED' } });
  expect(
    await rpc('turns.set', { worldId: f.worldId, revision: 100, slots: slots() }, f.alice.cookie, true),
  ).toMatchObject({ message: '종료된 월드입니다.' });
  await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED' } });
  expect(
    await rpc('turns.set', { worldId: f.worldId, revision: 100, slots: slots() }, f.alice.cookie, true),
  ).toMatchObject({ data: { ok: false, reason: 'STALE', revision: 1 } });
  const before = await snapshot(f.worldId);
  const stale = await rpc('turns.set', { worldId: f.worldId, revision: 100, slots: slots() }, f.alice.cookie, true);
  expect(stale.data).toMatchObject({ ok: false, reason: 'STALE', revision: 1 });
  expect(await snapshot(f.worldId)).toEqual(before);
  const saved = await rpc('turns.set', { worldId: f.worldId, revision: 1, slots: slots() }, f.alice.cookie, true);
  expect(saved.data).toMatchObject({ ok: true, revision: 2 });
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).toMatchObject({
    lastActiveTick: 600,
    turnRevision: 2,
  });
  expect(
    (await db.generalTurn.findMany({ where: { worldId: f.worldId, generalId: 1 } })).every((turn) => turn.explicit),
  ).toBe(true);
  expect(JSON.stringify(saved.data?.slots)).toBe(
    JSON.stringify(displaySlots(await db.$transaction((tx) => readSlots(tx, f.worldId, 1)))),
  );
});
