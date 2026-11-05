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
  const mutation = path === 'admin.game.request' || path === 'general.create';
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
async function world() {
  const initial = commandInitial();
  initial.ruleFeatures = ['personnel', 'policy'];
  initial.generals[2]!.officerLevel = 11;
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
    now: () => now,
    publicOrigin: origin,
    emailVerificationRequired: true,
    logStream: { write() {} },
  });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  ready = true;
});
afterEach(({ task }) => {
  if (task.result?.state === 'fail') failed = true;
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

it('AC-INT-23 정식491명 부곡 월드는 장수 병력 변경을 거절하고 금 조정·재생을 보존한다', async () => {
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
});
