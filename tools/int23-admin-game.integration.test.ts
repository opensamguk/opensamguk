import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive, readArchive } from '../apps/engine/src/replay';
import {
  initialReplayState,
  applyRecordedInput,
  ruleRegistry,
  type AdminGameAction,
  type RecordedInput,
} from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw Error('자기 loopback 시험 DB가 필요합니다.');
const name = 'int23_admin_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href }),
  gate = new Client({ connectionString: target.href }),
  db = createDb(target.href);
const origin = 'http://127.0.0.1:5173',
  now = Date.now();
let requestNow = now;
let app: Awaited<ReturnType<typeof buildServer>> | undefined,
  address: string,
  oid: string | undefined,
  ready = false,
  failed = false;
let actor: { id: string; cookie: string },
  otherAdmin: { id: string; cookie: string },
  ordinary: { id: string; cookie: string },
  sanctioned: { id: string; cookie: string };
async function user(role: 'ADMIN' | 'USER', status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE') {
  const row = await db.user.create({
    data: {
      email: randomUUID() + '@example.test',
      passwordHash: await hashPassword(randomUUID()),
      role,
      status,
      emailVerifiedAt: new Date(now),
    },
  });
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: row.id, expiresAt: session.expiresAt } });
  return { id: row.id, cookie: 'sid=' + session.token };
}
async function call(path: string, input: unknown, cookie?: string) {
  const mutation = [
    'admin.game.request',
    'general.create',
    'general.setPolicy',
    'operation.create',
    'turns.set',
    'personnel.appoint',
    'nationTurns.set',
    'offers.respond',
    'treaty.propose',
  ].includes(path);
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    address + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
      signal: AbortSignal.timeout(10000),
    },
  );
  const [body] = (await response.json()) as [{ result?: { data: unknown }; error?: { data: { code: string } } }];
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
async function world(quietNpcs = false, withTreaty = false) {
  const initial = commandInitial();
  initial.ruleFeatures = ['personnel', 'policy', ...(withTreaty ? ['treaty'] : [])];
  initial.generals[2]!.officerLevel = 11;
  if (quietNpcs) for (const general of initial.generals) general.activeFromYear = 192;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '운영 조치 검증',
    turnTermMinutes: 60,
    endYear: 231,
    replayFormat: 3,
  });
  await controlClock(db, worldId, 'start');
  await controlClock(db, worldId, 'pause');
  return worldId;
}
async function advance(worldId: string, tick = 0) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 시험 월드의 리스를 얻지 못했습니다.');
  try {
    await new TurnLoop(db, lease).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
function command(worldId: string, action: AdminGameAction, userId = actor.id) {
  return { expectedUserId: userId, worldId, idempotencyKey: randomUUID(), reason: '공개하지 않는 운영 사유', action };
}
function statusInput(input: ReturnType<typeof command>) {
  return { expectedUserId: input.expectedUserId, worldId: input.worldId, idempotencyKey: input.idempotencyKey };
}
async function expectReplayedState(worldId: string) {
  const stored = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const origin = stored.replayOrigin as unknown as {
    initial: ReturnType<typeof commandInitial>;
    featureData: Record<string, import('../packages/rules/src/index').JsonValue>;
  };
  let replay = initialReplayState(origin.initial, origin.featureData);
  const rows = await db.inputEvent.findMany({ where: { worldId }, orderBy: { sequence: 'asc' } });
  for (const row of rows) {
    expect(row.status).not.toBe('PENDING');
    replay = applyRecordedInput(
      replay,
      {
        sequence: row.sequence!,
        tick: row.tick,
        generalId: row.generalId,
        kind: row.kind,
        status: row.status,
        payload: row.payload,
        result: row.result,
      } as RecordedInput,
      ruleRegistry,
      { unitSet: origin.initial.unitSet },
    );
  }
  expect(hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)))).toBe(hashState(replay));
}
beforeAll(async () => {
  await admin.connect();
  expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
  await admin.query(`CREATE DATABASE "${name}"`);
  oid = String((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]!.oid);
  await gate.connect();
  const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
  for (const entry of (await readdir(migrations)).filter((value) => /^\d{14}_/.test(value)).sort())
    await gate.query(await readFile(new URL(entry + '/migration.sql', migrations), 'utf8'));
  actor = await user('ADMIN');
  otherAdmin = await user('ADMIN');
  ordinary = await user('USER');
  sanctioned = await user('ADMIN', 'SANCTIONED');
  app = await buildServer({
    db,
    now: () => requestNow,
    publicOrigin: origin,
    emailVerificationRequired: true,
    logStream: { write() {} },
  });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  ready = true;
});
afterEach(({ task }) => {
  if (task.result?.state === 'fail') failed = true;
  // 각 시험은 새 분에서 시작하고 시험 안에서는 실제 120회 제한을 유지한다.
  requestNow += 60_000;
});
afterAll(async () => {
  const errors: unknown[] = [];
  for (const close of [() => app?.close(), () => db.$disconnect(), () => gate.end()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  let dropped = false;
  try {
    if (oid) {
      await confirmDisconnectedDatabase(admin, name, oid);
      if (ready && !failed && !errors.length) {
        await admin.query(`DROP DATABASE "${name}"`);
        dropped = true;
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await admin.end();
  } catch (error) {
    errors.push(error);
  }
  console.info(
    JSON.stringify({ event: 'int23-admin-cleanup', name, oid, failed, ready, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError(errors, '운영 조치 시험의 자기 자원 정리 실패');
});

for (const path of ['admin.game.request', 'admin.game.requestStatus'])
  for (const category of categories)
    it(
      path + ' ' + category,
      authzCase(path, category, async () => {
        const worldId = await world(),
          input = command(worldId, { kind: 'admin.general.rename', generalId: 1, name: '새이름' });
        expect((await call('admin.game.request', input, actor.cookie)).status).toBe(200);
        const cookie =
          category === 'unauthenticated'
            ? undefined
            : category === 'otherUser'
              ? ordinary.cookie
              : category === 'sanctioned'
                ? sanctioned.cookie
                : actor.cookie;
        const requested = category === 'invalidInput' ? {} : path === 'admin.game.request' ? input : statusInput(input);
        const response = await call(path, requested, cookie);
        expect(response.status).toBe(
          category === 'success' ? 200 : category === 'invalidInput' ? 400 : category === 'otherUser' ? 403 : 401,
        );
      }),
    );

for (const path of [
  'admin.game.general',
  'admin.game.generalLogs',
  'admin.game.generalInputs',
  'admin.game.nationLogs',
  'admin.game.battles',
])
  for (const category of categories)
    it(
      path + ' ' + category,
      authzCase(path, category, async () => {
        const worldId = await world();
        const cookie =
          category === 'unauthenticated'
            ? undefined
            : category === 'otherUser'
              ? ordinary.cookie
              : category === 'sanctioned'
                ? sanctioned.cookie
                : actor.cookie;
        const input =
          category === 'invalidInput' ? {} : path === 'admin.game.nationLogs' ? { worldId } : { worldId, generalId: 1 };
        const before = await db.auditLog.count({ where: { worldId, action: 'admin.game.read' } });
        const response = await call(path, input, cookie);
        expect(response.status).toBe(
          category === 'success' ? 200 : category === 'invalidInput' ? 400 : category === 'otherUser' ? 403 : 401,
        );
        expect(await db.auditLog.count({ where: { worldId, action: 'admin.game.read' } })).toBe(
          before + (category === 'success' ? 1 : 0),
        );
      }),
    );

it('AC-INT-23 같은 tick 운영 기록은 개인 30행·관리자100행에서 누락 없이 이어지고 읽기는 감사한다', async () => {
  const worldId = await world(true);
  await controlClock(db, worldId, 'resume');
  const creating = call(
    'general.create',
    { worldId, name: '기록장수', leadership: 70, strength: 70, intel: 60, portraitId: null },
    ordinary.cookie,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await advance(worldId);
  expect((await creating).status).toBe(200);
  const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: ordinary.id } } });
  for (let i = 0; i < 105; i++) {
    expect(
      (
        await call(
          'admin.game.request',
          command(worldId, { kind: 'admin.general.rename', generalId: general.id, name: `기록${i}` }),
          actor.cookie,
        )
      ).status,
    ).toBe(200);
  }
  await advance(worldId);
  let cursor: string | undefined;
  const personal: string[] = [];
  do {
    const response = await call('records.general', { worldId, ...(cursor ? { cursor } : {}) }, ordinary.cookie);
    expect(response.status).toBe(200);
    const data = response.data as {
      items: { id: string; tick: number; kind: string; text: string }[];
      nextCursor: string | null;
    };
    expect(data.items.length).toBeLessThanOrEqual(30);
    for (const row of data.items) {
      expect(row).toMatchObject({ tick: 0, kind: 'admin' });
      expect(row.text).not.toContain('공개하지 않는 운영 사유');
      personal.push(row.id);
    }
    cursor = data.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(personal).size).toBe(105);
  const home = await call('home.get', { worldId }, ordinary.cookie);
  expect(home.status).toBe(200);
  expect((home.data as { recentLogs: { id: string }[] }).recentLogs.map((row) => row.id)).toEqual(
    personal.slice(0, 10),
  );
  const first = await call(
    'admin.game.generalLogs',
    { worldId, generalId: general.id, fromTick: 0, toTick: 0 },
    actor.cookie,
  );
  expect(first.status).toBe(200);
  const a = first.data as { items: { id: string }[]; nextCursor: string };
  expect(a.items).toHaveLength(100);
  const second = await call(
    'admin.game.generalLogs',
    { worldId, generalId: general.id, fromTick: 0, toTick: 0, cursor: a.nextCursor },
    actor.cookie,
  );
  const b = second.data as { items: { id: string }[]; nextCursor: string | null };
  expect(b.items).toHaveLength(5);
  expect(b.nextCursor).toBeNull();
  expect([...a.items, ...b.items].map((row) => row.id)).toEqual(personal);
  expect((await call('admin.game.general', { worldId, generalId: general.id }, actor.cookie)).data).toMatchObject({
    userId: ordinary.id,
    name: '기록104',
    removedAt: null,
  });
  const inputs = await call('admin.game.generalInputs', { worldId, generalId: general.id }, actor.cookie);
  expect((inputs.data as { items: { kind: string }[] }).items).toHaveLength(100);
  expect(await db.auditLog.count({ where: { worldId, action: 'admin.game.read' } })).toBe(4);
  expect(await db.auditLog.findMany({ where: { worldId, action: 'admin.game.read' } })).toMatchObject([
    { targetType: 'General', targetId: String(general.id) },
    { targetType: 'General', targetId: String(general.id) },
    { targetType: 'General', targetId: String(general.id) },
    { targetType: 'General', targetId: String(general.id) },
  ]);
  const missing = await call('admin.game.general', { worldId, generalId: 9999 }, actor.cookie);
  expect(missing.status).toBe(404);
  expect(await db.auditLog.count({ where: { worldId, action: 'admin.game.read' } })).toBe(5);
  expect(
    (await call('admin.game.generalLogs', { worldId, generalId: general.id, cursor: '%%%25' }, actor.cookie)).status,
  ).toBe(400);
  await expectReplayedState(worldId);
}, 30000);

it('AC-INT-23 운영 쪽지는 실제 엔진에서 한 번 보내고 개인 수신 범위·게임 재생을 보존한다', async () => {
  const worldId = await world(true);
  await controlClock(db, worldId, 'resume');
  const people: number[] = [];
  for (const identity of [actor, ordinary]) {
    const creating = call(
      'general.create',
      {
        worldId,
        name: identity === actor ? '운영장수' : '수신장수',
        leadership: 70,
        strength: 70,
        intel: 60,
        portraitId: null,
      },
      identity.cookie,
    );
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
      .toBe(1);
    await advance(worldId);
    expect((await creating).status).toBe(200);
    people.push(
      (await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: identity.id } } })).id,
    );
  }
  const input = command(worldId, {
    kind: 'admin.message.send',
    scope: 'PRIVATE',
    generalId: people[1]!,
    body: '개인 운영 안내',
  });
  const response = await call('admin.game.request', input, actor.cookie);
  expect(response.status).toBe(200);
  expect((await call('admin.game.request', input, actor.cookie)).data).toEqual(response.data);
  await advance(worldId);
  expect(await db.message.count({ where: { worldId, body: '개인 운영 안내' } })).toBe(1);
  const mine = await call('message.list', { worldId, scope: 'PRIVATE' }, ordinary.cookie);
  expect(mine.status).toBe(200);
  expect(mine.data).toMatchObject({
    items: [{ body: '개인 운영 안내', from: { name: '운영', kind: 'admin', generalId: null, nation: null } }],
  });
  expect((await call('message.list', { worldId, scope: 'PRIVATE' }, actor.cookie)).data).toMatchObject({ items: [] });
  const worldMessage = command(worldId, { kind: 'admin.message.send', scope: 'WORLD', body: '월드 운영 안내' });
  expect((await call('admin.game.request', worldMessage, actor.cookie)).status).toBe(200);
  expect(
    (
      await call(
        'admin.game.request',
        command(worldId, {
          kind: 'admin.city.adjust',
          cityKey: 1,
          changes: { population: { expected: 20000, value: 21000 } },
        }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  for (const identity of [actor, ordinary]) {
    const data = (await call('message.list', { worldId, scope: 'WORLD' }, identity.cookie)).data as {
      items: { body: string }[];
    };
    expect(data.items).toHaveLength(2);
    expect(data.items.map((row) => row.body).join('\n')).not.toContain('공개하지 않는 운영 사유');
    expect(data.items.map((row) => row.body)).toContain('월드 운영 안내');
  }
  await expectReplayedState(worldId);
}, 30000);

it('AC-INT-23 보관 전투·국가 기록은 동률 커서와 틱·대상 범위를 유지한다', async () => {
  const worldId = await world();
  await db.battleLog.createMany({
    data: Array.from({ length: 153 }, (_, i) => ({
      worldId,
      tick: Math.floor(i / 3),
      attackerId: 1,
      generalId: 2 + (i % 3),
      text: `보관 전투 ${i}`,
    })),
  });
  await db.nationHistory.createMany({
    data: Array.from({ length: 102 }, (_, i) => ({
      worldId,
      tick: Math.floor(i / 3),
      nationId: 1 + (i % 3),
      data: { events: [`보관 국가 기록 ${i}`] },
    })),
  });
  for (const [path, expected] of [
    ['admin.game.battles', 153],
    ['admin.game.nationLogs', 102],
  ] as const) {
    const rows: unknown[] = [];
    let cursor: string | undefined;
    do {
      const response = await call(path, { worldId, ...(cursor ? { cursor } : {}) }, actor.cookie);
      expect(response.status).toBe(200);
      const data = response.data as { items: unknown[]; nextCursor: string | null };
      expect(data.items.length).toBeLessThanOrEqual(100);
      rows.push(...data.items);
      cursor = data.nextCursor ?? undefined;
    } while (cursor);
    expect(rows).toHaveLength(expected);
    expect(new Set(rows.map((row) => JSON.stringify(row))).size).toBe(expected);
  }
  expect(
    (await call('admin.game.battles', { worldId, generalId: 2, fromTick: 2, toTick: 3 }, actor.cookie)).data,
  ).toMatchObject({
    items: [
      { tick: 3, generalId: 2 },
      { tick: 2, generalId: 2 },
    ],
    nextCursor: null,
  });
  expect(
    (await call('admin.game.nationLogs', { worldId, nationId: 2, fromTick: 2, toTick: 3 }, actor.cookie)).data,
  ).toMatchObject({
    items: [
      { tick: 3, nationId: 2 },
      { tick: 2, nationId: 2 },
    ],
    nextCursor: null,
  });
  expect((await call('admin.game.battles', { worldId, fromTick: 3, toTick: 2 }, actor.cookie)).status).toBe(400);
  expect((await call('admin.game.generalLogs', { worldId, generalId: 1 }, otherAdmin.cookie)).data).toEqual({
    items: [],
    nextCursor: null,
  });
});

it('AC-INT-23 운영 쪽지도 commit 실패 시 함께 되돌고 새 리스에서 한 번 보낸다', async () => {
  const worldId = await world();
  const input = command(worldId, { kind: 'admin.message.send', scope: 'WORLD', body: '원자적 운영 쪽지' });
  expect((await call('admin.game.request', input, actor.cookie)).status).toBe(200);
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 시험 리스를 얻지 못했습니다.');
  try {
    await expect(
      new TurnLoop(db, lease, {
        beforeCommit: async () => {
          throw Error('의도한 쪽지 commit 실패');
        },
      }).advanceTo(0),
    ).rejects.toThrow('의도한 쪽지 commit 실패');
  } finally {
    await releaseLease(db, lease);
  }
  expect(await db.message.count({ where: { worldId } })).toBe(0);
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId } })).toMatchObject({
    status: 'PENDING',
    sequence: null,
  });
  expect(await db.auditLog.count({ where: { worldId, action: 'game.applied' } })).toBe(0);
  await advance(worldId);
  expect(await db.message.count({ where: { worldId, body: '원자적 운영 쪽지' } })).toBe(1);
  await expectReplayedState(worldId);
});

it('AC-INT-23 숫자0과 -0의 같은 JSON 요청은 같은 추적 번호를 반환한다', async () => {
  const worldId = await world();
  const input = command(worldId, {
    kind: 'admin.general.adjust',
    generalId: 1,
    changes: { gold: { expected: 100000, value: 0 } },
  });
  const before = await call('admin.game.request', input, actor.cookie);
  expect(before.status).toBe(200);
  const body = JSON.stringify({ 0: input }).replace('"value":0', '"value":-0');
  const response = await fetch(address + '/trpc/admin.game.request?batch=1', {
    method: 'POST',
    headers: { origin, cookie: actor.cookie, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([{ result: { data: before.data } }]);
  expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
  expect(await db.auditLog.count({ where: { worldId, action: 'game.request' } })).toBe(1);
});

it('AC-INT-23 접수 뒤 권한·제재와 같은 칸의 expected를 엔진에서 다시 검사한다', async () => {
  for (const change of ['role', 'sanction'] as const) {
    const worldId = await world(),
      operator = await user('ADMIN');
    const input = command(worldId, { kind: 'admin.general.rename', generalId: 1, name: '거절이름' }, operator.id);
    expect((await call('admin.game.request', input, operator.cookie)).status).toBe(200);
    if (change === 'role') await db.user.update({ where: { id: operator.id }, data: { role: 'USER' } });
    else
      await db.sanction.create({
        data: { userId: operator.id, worldId: null, createdBy: actor.id, reason: '접수 뒤 제재' },
      });
    await advance(worldId);
    expect(await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: input.action.kind } })).toMatchObject({
      status: 'REJECTED',
      result: { code: change === 'role' ? 'ADMIN_REQUIRED' : 'ACTOR_SANCTIONED' },
    });
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).name).toBe('장수1');
    expect(await db.auditLog.count({ where: { worldId, action: { in: ['game.request', 'game.rejected'] } } })).toBe(2);
  }
  const worldId = await world();
  for (const value of [500, 600])
    expect(
      (
        await call(
          'admin.game.request',
          command(worldId, {
            kind: 'admin.general.adjust',
            generalId: 1,
            changes: { gold: { expected: 100000, value } },
          }),
          actor.cookie,
        )
      ).status,
    ).toBe(200);
  await advance(worldId);
  const rows = await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
  expect(rows.map((row) => row.status)).toEqual(['APPLIED', 'REJECTED']);
  expect(rows[1]!.result).toMatchObject({ code: 'TARGET_CHANGED' });
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).gold).toBe(500);
});

it('AC-INT-23 commit 실패는 변경·완료 입력·감사를 함께 되돌리고 새 리스에서 한 번 적용한다', async () => {
  const worldId = await world();
  const input = command(worldId, { kind: 'admin.general.rename', generalId: 1, name: '원자적변경' });
  expect((await call('admin.game.request', input, actor.cookie)).status).toBe(200);
  const before = hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)));
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 시험 리스를 얻지 못했습니다.');
  try {
    await expect(
      new TurnLoop(db, lease, {
        beforeCommit: async () => {
          throw Error('의도한 commit 실패');
        },
      }).advanceTo(0),
    ).rejects.toThrow('의도한 commit 실패');
  } finally {
    await releaseLease(db, lease);
  }
  expect(hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)))).toBe(before);
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId } })).toMatchObject({
    status: 'PENDING',
    sequence: null,
    tick: null,
    result: null,
  });
  expect(await db.auditLog.count({ where: { worldId, action: 'game.applied' } })).toBe(0);
  await advance(worldId);
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).name).toBe('원자적변경');
  expect(await db.auditLog.count({ where: { worldId, action: 'game.applied' } })).toBe(1);
});

it('AC-INT-23 접수는 게임 상태를 바꾸지 않고 8종 입력·감사·인사 후처리는 재생과 같은 해시를 만든다', async () => {
  const worldId = await world();
  await controlClock(db, worldId, 'resume');
  const creating = call(
    'general.create',
    { worldId, name: '사람장수', leadership: 70, strength: 70, intel: 60, portraitId: null },
    ordinary.cookie,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await advance(worldId);
  expect((await creating).status).toBe(200);
  await controlClock(db, worldId, 'pause');
  const human = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: ordinary.id } } });
  const actions: AdminGameAction[] = [
    { kind: 'admin.general.rename', generalId: 1, name: '운영장수' },
    { kind: 'admin.general.clearTurns', generalId: human.id },
    {
      kind: 'admin.general.adjust',
      generalId: 1,
      changes: {
        gold: { expected: 100000, value: 1234 },
        cityKey: { expected: 1, value: 3 },
        crewType: { expected: 1100, value: 1200 },
      },
    },
    { kind: 'admin.city.adjust', cityKey: 1, changes: { population: { expected: 20000, value: 30000 } } },
    { kind: 'admin.nation.adjust', nationId: 1, changes: { tech: { expected: 0, value: 100.5 } } },
    { kind: 'admin.nation.rename', nationId: 1, name: '운영국가' },
    { kind: 'admin.nation.dismissOffice', nationId: 2, generalId: 3 },
    { kind: 'admin.general.release', generalId: human.id },
  ];
  const before = hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)));
  const inputs = actions.map((action) => command(worldId, action));
  for (const input of inputs) expect((await call('admin.game.request', input, actor.cookie)).status).toBe(200);
  expect(hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)))).toBe(before);
  expect((await call('admin.game.request', inputs[0], actor.cookie)).data).toMatchObject({ status: 'PENDING' });
  expect((await call('admin.game.request', { ...inputs[0], reason: '다른 사유' }, actor.cookie)).status).toBe(409);
  await advance(worldId);
  expect((await call('admin.game.requestStatus', statusInput(inputs[0]!), actor.cookie)).data).toMatchObject({
    status: 'APPLIED',
    result: { after: { name: '운영장수' } },
  });
  expect(
    (
      await call(
        'admin.game.requestStatus',
        { ...statusInput(inputs[0]!), expectedUserId: otherAdmin.id },
        otherAdmin.cookie,
      )
    ).status,
  ).toBe(404);
  await expectReplayedState(worldId);
  expect(await db.auditLog.count({ where: { worldId, action: 'game.request' } })).toBe(8);
  expect(await db.auditLog.count({ where: { worldId, action: { in: ['game.applied', 'game.rejected'] } } })).toBe(8);
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: human.id } } })).toMatchObject({
    userId: null,
    residenceTick: null,
    lastActiveTick: null,
    turnRevision: 1,
  });
  await controlClock(db, worldId, 'resume');
  await advance(worldId, 10000);
  const archive = await exportReplay(db, worldId);
  expect(archive.version).toBe(3);
  expect(replayArchive(archive, 1)).toHaveLength(1);
  expect(() => readArchive({ ...archive, version: 1 })).toThrow();
}, 30000);

it('AC-INT-23 장수 내보내기는 직책·병력을 정리하고 실제 조회·턴·월 정산·재생에서 제외한다', async () => {
  const worldId = await world();
  const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
  const city = await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: before.cityKey } } });
  const input = command(worldId, { kind: 'admin.general.remove', generalId: 3 });
  expect((await call('admin.game.request', input, actor.cookie)).status).toBe(200);
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).removedAt).toBeNull();
  await advance(worldId);
  expect((await call('admin.game.requestStatus', statusInput(input), actor.cookie)).data).toMatchObject({
    status: 'APPLIED',
    result: { after: { removedAt: 0, nationId: null, officerLevel: 0, crew: 0 } },
  });
  const removed = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
  expect(removed).toMatchObject({
    removedAt: 0,
    userId: null,
    lastActiveTick: null,
    lastActiveAt: null,
    residenceTick: null,
    nextTurnTick: before.nextTurnTick,
  });
  expect(
    (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: city.cityKey } } })).population,
  ).toBe(Math.min(city.populationMax, city.population + before.crew));
  const response = await call('city.get', { worldId, cityKey: city.cityKey }, actor.cookie);
  expect(response.status).toBe(200);
  expect((response.data as { generals: { id: number }[] }).generals.some((g) => g.id === 3)).toBe(false);
  await expectReplayedState(worldId);
  await controlClock(db, worldId, 'resume');
  await advance(worldId, 10_000);
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).nextTurnTick).toBe(
    before.nextTurnTick,
  );
  expect(await db.generalLog.findMany({ where: { worldId, generalId: 3 } })).toMatchObject([
    { commandKey: 'admin.general.remove', kind: 'admin', text: '월드에서 내보냄' },
  ]);
  expect(replayArchive(await exportReplay(db, worldId), 1)).toHaveLength(1);
}, 30000);

it('AC-INT-23 사람 내보내기는 먼저 접수된 요청을 거절하고 같은 계정의 새 장수 생성을 허용한다', async () => {
  const worldId = await world();
  await controlClock(db, worldId, 'resume');
  const creating = call(
    'general.create',
    { worldId, name: '퇴장전장수', leadership: 70, strength: 70, intel: 60, portraitId: null },
    ordinary.cookie,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await advance(worldId);
  expect((await creating).status).toBe(200);
  const human = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: ordinary.id } } });
  const pending = call('general.setPolicy', { worldId, policy: 'none' }, ordinary.cookie);
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.setPolicy', status: 'PENDING' } }))
    .toBe(1);
  const input = command(worldId, { kind: 'admin.general.remove', generalId: human.id });
  expect((await call('admin.game.request', input, actor.cookie)).status).toBe(200);
  await advance(worldId);
  expect((await pending).status).toBe(400);
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: 'general.setPolicy' } })).toMatchObject({
    status: 'REJECTED',
    result: { code: 'GENERAL_REMOVED' },
  });
  expect((await call('general.mine', { worldId }, ordinary.cookie)).data).toMatchObject({ general: null });
  const next = call(
    'general.create',
    { worldId, name: '퇴장후장수', leadership: 70, strength: 70, intel: 60, portraitId: null },
    ordinary.cookie,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await advance(worldId);
  expect((await next).status).toBe(200);
  expect(
    (await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: ordinary.id } } })).id,
  ).not.toBe(human.id);
  await expectReplayedState(worldId);
}, 30000);

it('AC-INT-23 퇴장 참모의 인사·조약 대기 입력도 조회·아카이브를 보존하고 작전에서 제외한다', async () => {
  const worldId = await world(true, true);
  await controlClock(db, worldId, 'resume');
  for (const [identity, name] of [
    [actor, '작전군주'],
    [ordinary, '작전부하'],
  ] as const) {
    const creating = call(
      'general.create',
      { worldId, name, leadership: 70, strength: 70, intel: 60, portraitId: null },
      identity.cookie,
    );
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
      .toBe(1);
    await advance(worldId);
    expect((await creating).status).toBe(200);
  }
  const commander = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: actor.id } } });
  const member = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: ordinary.id } } });
  const adjustment = command(worldId, {
    kind: 'admin.general.adjust',
    generalId: commander.id,
    changes: {
      cityKey: { expected: commander.cityKey, value: 3 },
      gold: { expected: commander.gold, value: 100000 },
    },
  });
  expect((await call('admin.game.request', adjustment, actor.cookie)).status).toBe(200);
  await advance(worldId);
  const founderSlots: ({ commandKey: string; args: unknown } | null)[] = Array.from({ length: 30 }, () => null);
  founderSlots[0] = { commandKey: 'found', args: { name: '작전국가', color: '#123456' } };
  const memberSlots: ({ commandKey: string; args: unknown } | null)[] = Array.from({ length: 30 }, () => null);
  memberSlots[1] = { commandKey: 'join', args: { nationId: 3 } };
  expect(
    (await call('turns.set', { worldId, revision: commander.turnRevision, slots: founderSlots }, actor.cookie)).data,
  ).toMatchObject({ ok: true });
  expect(
    (await call('turns.set', { worldId, revision: member.turnRevision, slots: memberSlots }, ordinary.cookie)).data,
  ).toMatchObject({ ok: true });
  const tick = member.nextTurnTick + 10000;
  await advance(worldId, tick);
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: commander.id } } })).toMatchObject({
    nationId: 3,
    officerLevel: 12,
  });
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: member.id } } })).toMatchObject({
    nationId: 3,
    officerLevel: 1,
  });
  const treasury = await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
  expect(
    (
      await call(
        'admin.game.request',
        command(worldId, {
          kind: 'admin.nation.adjust',
          nationId: 3,
          changes: { gold: { expected: treasury.gold, value: 100000 } },
        }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  const appointing = call(
    'personnel.appoint',
    { worldId, requestId: randomUUID(), generalId: member.id, officerLevel: 11 },
    actor.cookie,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'personnel.appoint', status: 'PENDING' } }))
    .toBe(1);
  await advance(worldId, tick);
  expect((await appointing).status).toBe(200);
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: member.id } } })).officerLevel).toBe(
    11,
  );
  const input = {
    worldId,
    targetCityKey: 1,
    targetYear: 191,
    targetMonth: 4,
    min: { crew: 0, train: 0, atmos: 0 },
    memberIds: [commander.id, member.id],
  };
  const created = await call('operation.create', input, actor.cookie);
  expect(created.status).toBe(200);
  const id = (created.data as { id: string }).id;
  expect((await call('operation.get', { worldId, id }, actor.cookie)).data).toMatchObject({ members: 2 });
  const tabs = await call('nationTurns.get', { worldId }, actor.cookie);
  expect(tabs.status).toBe(200);
  const office = (
    tabs.data as {
      tabs: {
        officerLevel: number;
        office: { nationId: number; officerLevel: number; tenure: number };
        revision: number;
      }[];
    }
  ).tabs.find((tab) => tab.officerLevel === 12)!;
  const officeSlots: ({ commandKey: string; args: unknown } | null)[] = Array.from({ length: 12 }, () => null);
  officeSlots[0] = { commandKey: 'nation_assign', args: { generalId: member.id, cityKey: 3 } };
  expect(
    (
      await call(
        'nationTurns.set',
        { worldId, office: office.office, revision: office.revision, slots: officeSlots },
        actor.cookie,
      )
    ).data,
  ).toMatchObject({ ok: true });
  const assignmentTick = (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: commander.id } } }))
    .nextTurnTick;
  await advance(worldId, assignmentTick);
  const offer = await db.assignmentOffer.findFirstOrThrow({
    where: { worldId, targetGeneralId: member.id, status: 'PENDING' },
  });
  const personnelRequestId = randomUUID();
  const responding = call(
    'offers.respond',
    { worldId, requestId: personnelRequestId, offerId: offer.id, accept: true },
    ordinary.cookie,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'offer.respond', status: 'PENDING' } }))
    .toBe(1);
  const treatyRequestId = randomUUID();
  const proposing = call(
    'treaty.propose',
    { worldId, requestId: treatyRequestId, toNationId: 1, clauses: [{ kind: 'note', text: '퇴장 경계 검증' }] },
    ordinary.cookie,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'treaty.propose', status: 'PENDING' } }))
    .toBe(1);
  expect(
    (
      await call(
        'admin.game.request',
        command(worldId, { kind: 'admin.general.remove', generalId: member.id }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId, assignmentTick);
  expect((await responding).status).toBe(400);
  expect((await proposing).data).toMatchObject({ status: 'rejected', code: 'GENERAL_REMOVED' });
  expect(
    (await call('personnel.request', { worldId, requestId: personnelRequestId }, ordinary.cookie)).data,
  ).toMatchObject({ kind: 'offer.respond', state: { status: 'rejected', code: 'GENERAL_REMOVED' } });
  expect((await call('treaty.request', { worldId, requestId: treatyRequestId }, ordinary.cookie)).data).toMatchObject({
    status: 'rejected',
    code: 'GENERAL_REMOVED',
  });
  for (const kind of ['offer.respond', 'treaty.propose'])
    expect(await db.inputEvent.findFirstOrThrow({ where: { worldId, kind } })).toMatchObject({
      status: 'REJECTED',
      tick: assignmentTick,
      result: { code: 'GENERAL_REMOVED', tick: assignmentTick },
    });
  const cancelled = await db.generalLog.findFirstOrThrow({
    where: { worldId, generalId: member.id, commandKey: 'offer.cancel' },
  });
  expect(cancelled).toMatchObject({ tick: assignmentTick, ordinal: 1 });
  expect(cancelled.sequence).toBeGreaterThan(0);
  expect((await call('operation.get', { worldId, id }, actor.cookie)).data).toMatchObject({
    members: 1,
    timeline: [{ generalId: commander.id }],
  });
  expect((await call('operation.create', { ...input, memberIds: [member.id] }, actor.cookie)).status).toBe(400);
  expect(await db.operationMember.count({ where: { operationId: id } })).toBe(2);
  const months = Math.floor(assignmentTick / 10000) + 1;
  await advance(worldId, months * 10000);
  expect(replayArchive(await exportReplay(db, worldId), months)).toHaveLength(months);
}, 30000);

it('AC-INT-23 정식491명 부곡 월드는 병력 조정을 거절하고 금 조정·장수 내보내기·재생을 보존한다', async () => {
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'int23-campaign',
  });
  initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '정식 부곡 운영 조치',
    turnTermMinutes: 60,
    endYear: 231,
  });
  expect(await db.general.count({ where: { worldId } })).toBe(491);
  await controlClock(db, worldId, 'start');
  await controlClock(db, worldId, 'pause');
  const general = await db.general.findFirstOrThrow({ where: { worldId }, orderBy: { id: 'asc' } });
  for (const changes of [
    { crew: { expected: general.crew, value: 1 } },
    { gold: { expected: general.gold, value: general.gold + 1 } },
  ]) {
    expect(
      (
        await call(
          'admin.game.request',
          command(worldId, { kind: 'admin.general.adjust', generalId: general.id, changes }),
          actor.cookie,
        )
      ).status,
    ).toBe(200);
  }
  await advance(worldId);
  const rows = await db.inputEvent.findMany({ where: { worldId }, orderBy: { sequence: 'asc' } });
  expect(rows.map((row) => row.status)).toEqual(['REJECTED', 'APPLIED']);
  expect(rows[0]!.result).toMatchObject({ code: 'CAMPAIGN_FIELD' });
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: general.id } } })).toMatchObject({
    crew: 0,
    gold: general.gold + 1,
  });
  await expectReplayedState(worldId);
  const target = await db.general.findFirstOrThrow({
    where: { worldId, officerLevel: { not: 12 } },
    orderBy: { id: 'asc' },
  });
  expect(
    (
      await call(
        'admin.game.request',
        command(worldId, { kind: 'admin.general.remove', generalId: target.id }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: target.id } } })).removedAt).toBe(0);
  await expectReplayedState(worldId);
});
