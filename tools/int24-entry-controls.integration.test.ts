import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayToEnd, readArchive } from '../apps/engine/src/replay';
import {
  initialReplayState,
  applyRecordedInput,
  ruleRegistry,
  parsePreset,
  type AdminSetting,
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
const name = 'int24_entry_' + randomUUID().replaceAll('-', '') + '_test';
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
let actor: { id: string; cookie: string }, ordinary: { id: string; cookie: string };
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
async function call<T = unknown>(path: string, input: unknown, cookie?: string) {
  const mutation = ['admin.world.requestSetting', 'admin.world.requestReset', 'general.create'].includes(path);
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
  const [body] = (await response.json()) as [{ result?: { data: T }; error?: { data: { code: string } } }];
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
const preset = parsePreset({
  name: '설정 검증',
  turnTermMinutes: 60,
  scenario: 'integration191',
  map: 'integration',
  unitSet: 'basic',
  commands: null,
  npc: { fillRatio: 1, aggression: 1 },
  protection: { foundUntilMonths: 0, peaceMonths: 0, maxGeneralsPerNation: null },
  boost: { smallWorld: null, lateJoin: null },
  features: { advisor: false },
});
async function world(withPreset = true, published = false) {
  const initial = published
    ? await loadInitialWorldFromDb(db, {
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: randomUUID(),
      })
    : commandInitial();
  if (!published) initial.scenarioKey = 'integration191';
  initial.ruleFeatures = [...new Set([...(initial.ruleFeatures ?? []), 'personnel', 'policy'])].sort();
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '생성 이름',
    turnTermMinutes: 60,
    endYear: 231,
    replayFormat: 3,
    ...(withPreset ? { preset: { key: 'int24-test', value: preset } } : {}),
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
function command(worldId: string, setting: AdminSetting, userId = actor.id) {
  return { expectedUserId: userId, worldId, idempotencyKey: randomUUID(), reason: '공개하지 않는 운영 사유', setting };
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
  await initializeResources(
    db,
    await readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
  );
  await initializeIntegrationResources(db);
  actor = await user('ADMIN');
  ordinary = await user('USER');
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
  requestNow += 60000;
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
    JSON.stringify({ event: 'int24-entry-cleanup', name, oid, failed, ready, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError(errors, '운영 조치 시험의 자기 자원 정리 실패');
});

const entrant = (worldId: string) => ({
  worldId,
  name: '새참가',
  leadership: 70,
  strength: 70,
  intel: 60,
  portraitId: null,
});
async function setEntry(worldId: string, value: 'open' | 'closed') {
  const input = command(worldId, { kind: 'admin.world.setOption', key: 'entry.generalCreation', value });
  expect((await call('admin.world.requestSetting', input, actor.cookie)).status).toBe(200);
  await advance(worldId);
  expect(await call('admin.world.settingRequest', statusInput(input), actor.cookie)).toMatchObject({
    status: 200,
    data: { status: 'APPLIED' },
  });
}

it('AC-INT-24 프리셋 없는 월드도 닫기·재개하고 조회와 로비가 같은 상태를 보인다', async () => {
  const worldId = await world(false);
  expect(await call('general.mine', { worldId }, ordinary.cookie)).toMatchObject({
    status: 200,
    data: { creationRules: { generalCreationEnabled: true } },
  });
  await setEntry(worldId, 'closed');
  expect(await call('general.mine', { worldId }, ordinary.cookie)).toMatchObject({
    status: 200,
    data: { creationRules: { generalCreationEnabled: false } },
  });
  expect(await call('admin.world.settings', { worldId }, actor.cookie)).toMatchObject({
    status: 200,
    data: { canChangeRules: false, rules: null, entry: { generalCreation: 'closed' } },
  });
  await controlClock(db, worldId, 'resume');
  expect((await call('general.create', entrant(worldId), ordinary.cookie)).status).toBe(412);
  expect(await db.inputEvent.count({ where: { worldId, kind: 'general.create' } })).toBe(0);
  const lobby = await call<Array<{ id: string; createBlockedReason: string | null }>>(
    'lobby.worlds',
    undefined,
    ordinary.cookie,
  );
  expect(lobby.status).toBe(200);
  expect(lobby.data!.find((row) => row.id === worldId)!.createBlockedReason).toBe('지금은 새 장수를 받지 않습니다');
  await controlClock(db, worldId, 'pause');
  await setEntry(worldId, 'open');
  expect(await call('general.mine', { worldId }, ordinary.cookie)).toMatchObject({
    status: 200,
    data: { creationRules: { generalCreationEnabled: true } },
  });
  await expectReplayedState(worldId);
});

it('AC-INT-24 이미 접수된 생성은 닫기 적용 뒤 엔진에서 거절하고 장수를 만들지 않는다', async () => {
  const worldId = await world();
  await controlClock(db, worldId, 'resume');
  const creating = call('general.create', entrant(worldId), ordinary.cookie);
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  const input = command(worldId, { kind: 'admin.world.setOption', key: 'entry.generalCreation', value: 'closed' });
  expect((await call('admin.world.requestSetting', input, actor.cookie)).status).toBe(200);
  await advance(worldId);
  expect((await creating).status).toBe(412);
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: 'general.create' } })).toMatchObject({
    status: 'REJECTED',
    result: { code: 'ENTRY_CLOSED', message: '지금은 새 장수를 받지 않습니다.' },
  });
  expect(await db.general.count({ where: { worldId, userId: ordinary.id } })).toBe(0);
  expect(await call('general.mine', { worldId }, ordinary.cookie)).toMatchObject({
    status: 200,
    data: { general: null, creation: { status: 'rejected', code: 'ENTRY_CLOSED' } },
  });
  await expectReplayedState(worldId);
});

it('AC-INT-24 다시 연 뒤 생성은 정상 적용하고 기존 장수의 접속은 닫기와 무관하다', async () => {
  const worldId = await world();
  await setEntry(worldId, 'closed');
  await setEntry(worldId, 'open');
  await controlClock(db, worldId, 'resume');
  const creating = call('general.create', entrant(worldId), ordinary.cookie);
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await advance(worldId);
  expect(await creating).toMatchObject({ status: 200, data: { status: 'created', general: { name: '새참가' } } });
  await setEntry(worldId, 'closed');
  expect(await call('general.mine', { worldId }, ordinary.cookie)).toMatchObject({
    status: 200,
    data: { general: { name: '새참가' }, creationRules: { generalCreationEnabled: false } },
  });
  const lobby = await call<Array<{ id: string; myGeneral: unknown; createBlockedReason: string | null }>>(
    'lobby.worlds',
    undefined,
    ordinary.cookie,
  );
  expect(lobby.status).toBe(200);
  expect(lobby.data!.find((row) => row.id === worldId)).toMatchObject({
    myGeneral: { name: '새참가' },
    createBlockedReason: null,
  });
  await expectReplayedState(worldId);
});

it('AC-INT-24 규칙 옵션 변경과 생성 닫기를 서로 지우지 않고 미래 단계의 키는 접수하지 않는다', async () => {
  const worldId = await world();
  await setEntry(worldId, 'closed');
  expect(
    (
      await call(
        'admin.world.requestSetting',
        command(worldId, { kind: 'admin.world.setOption', key: 'npc.aggression', value: 0.5 }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).runtimeOptions).toEqual({
    entry: { generalCreation: 'closed' },
    rules: { npc: { aggression: 0.5 } },
  });
  await setEntry(worldId, 'open');
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).runtimeOptions).toEqual({
    entry: { generalCreation: 'open' },
    rules: { npc: { aggression: 0.5 } },
  });
  for (const [key, value] of [
    ['entry.npcPlay', 'on'],
    ['entry.generalCreation', 'yes'],
  ] as const)
    expect(
      (
        await call(
          'admin.world.requestSetting',
          {
            ...command(worldId, { kind: 'admin.world.rename', name: 'x' }),
            setting: { kind: 'admin.world.setOption', key, value },
          },
          actor.cookie,
        )
      ).status,
    ).toBe(400);
  await expectReplayedState(worldId);
});

it('AC-INT-24 생성이 닫힌 판을 초기화하면 새 판은 원래대로 열린다', async () => {
  const worldId = await world(true, true);
  await setEntry(worldId, 'closed');
  const source = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(
    (
      await call(
        'admin.world.requestReset',
        {
          expectedUserId: actor.id,
          worldId,
          idempotencyKey: randomUUID(),
          reason: '생성 허용 초기화 검증',
          confirmName: source.name,
          expectedRevision: source.clockRevision,
        },
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  const row = await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: 'admin.world.reset' } });
  expect(row.status).toBe('APPLIED');
  const child = await db.world.findUniqueOrThrow({ where: { id: (row.result as { newWorldId: string }).newWorldId } });
  expect(child.runtimeOptions).toBeNull();
  expect(await call('general.mine', { worldId: child.id }, ordinary.cookie)).toMatchObject({
    status: 200,
    data: { creationRules: { generalCreationEnabled: true } },
  });
  const archive = await exportReplay(db, worldId);
  expect(() => replayToEnd(readArchive(JSON.parse(JSON.stringify(archive))))).not.toThrow();
});
