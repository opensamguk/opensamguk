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
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { prepareWorldReset } from '../apps/engine/src/admin/resetPreparation';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { processAdminSetting } from '../apps/engine/src/admin/settings';
import { lockLease, assertLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive, replayToEnd, readArchive } from '../apps/engine/src/replay';
import {
  initialReplayState,
  applyRecordedInput,
  ruleRegistry,
  parsePreset,
  presetRules,
  TICKS_PER_MONTH,
  nowTick,
  isInactive,
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
const name = 'int24_settings_' + randomUUID().replaceAll('-', '') + '_test';
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
async function call<T = unknown>(path: string, input: unknown, cookie?: string) {
  const mutation = ['admin.world.requestSetting', 'admin.world.requestReset'].includes(path);
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
    JSON.stringify({ event: 'int24-settings-cleanup', name, oid, failed, ready, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError(errors, '운영 조치 시험의 자기 자원 정리 실패');
});

for (const path of ['admin.world.requestSetting', 'admin.world.settingRequest', 'admin.world.settings'])
  for (const category of categories)
    it(
      path + ' ' + category,
      authzCase(path, category, async () => {
        const worldId = await world(),
          input = command(worldId, { kind: 'admin.world.rename', name: '새 이름' });
        expect((await call('admin.world.requestSetting', input, actor.cookie)).status).toBe(200);
        const cookie =
          category === 'unauthenticated'
            ? undefined
            : category === 'otherUser'
              ? ordinary.cookie
              : category === 'sanctioned'
                ? sanctioned.cookie
                : actor.cookie;
        const requested =
          category === 'invalidInput'
            ? {}
            : path === 'admin.world.requestSetting'
              ? input
              : path === 'admin.world.settingRequest'
                ? statusInput(input)
                : { worldId };
        expect((await call(path, requested, cookie)).status).toBe(
          category === 'success' ? 200 : category === 'invalidInput' ? 400 : category === 'otherUser' ? 403 : 401,
        );
      }),
    );

it('AC-INT-24 API는 입력만 접수하고 같은 요청·다른 계정·키 충돌을 구분한다', async () => {
  const worldId = await world(),
    input = command(worldId, { kind: 'admin.world.rename', name: '새 이름' });
  const before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const results = await Promise.all([
    call('admin.world.requestSetting', input, actor.cookie),
    call('admin.world.requestSetting', input, actor.cookie),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({
    status: 200,
    data: { status: 'PENDING', sequence: null, tick: null, result: null },
  });
  expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(before);
  expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
  expect(await db.auditLog.count({ where: { worldId, action: 'world.setting.request' } })).toBe(1);
  expect((await call('admin.world.requestSetting', { ...input, reason: '다른 사유' }, actor.cookie)).status).toBe(409);
  expect((await call('admin.world.settingRequest', statusInput(input), otherAdmin.cookie)).status).toBe(401);
  expect(
    (
      await call(
        'admin.world.settingRequest',
        { ...statusInput(input), expectedUserId: otherAdmin.id },
        otherAdmin.cookie,
      )
    ).status,
  ).toBe(404);
  await advance(worldId);
  expect(await call('admin.world.settingRequest', statusInput(input), actor.cookie)).toMatchObject({
    status: 200,
    data: { status: 'APPLIED' },
  });
  expect(await db.message.findFirstOrThrow({ where: { worldId } })).toMatchObject({
    fromParty: { kind: 'admin', name: '운영' },
    body: '월드 이름을 새 이름(으)로 변경했습니다.',
  });
  expect(JSON.stringify(await db.message.findMany({ where: { worldId } }))).not.toContain(input.reason);
  await expectReplayedState(worldId);
});

it('AC-INT-24 접수 뒤 관리자 권한·제재를 다시 확인하고 API 거절 감사를 남긴다', async () => {
  for (const change of ['role', 'sanction'] as const) {
    const worldId = await world(),
      operator = await user('ADMIN');
    const input = command(worldId, { kind: 'admin.world.rename', name: '거절 이름' }, operator.id);
    expect((await call('admin.world.requestSetting', input, operator.cookie)).status).toBe(200);
    if (change === 'role') await db.user.update({ where: { id: operator.id }, data: { role: 'USER' } });
    else
      await db.sanction.create({
        data: { userId: operator.id, worldId: null, createdBy: actor.id, reason: '처리 전 제재' },
      });
    await advance(worldId);
    expect(await db.inputEvent.findFirstOrThrow({ where: { worldId } })).toMatchObject({
      status: 'REJECTED',
      result: { code: change === 'role' ? 'ADMIN_REQUIRED' : 'ACTOR_SANCTIONED' },
    });
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).name).toBe('생성 이름');
    expect(await db.message.count({ where: { worldId } })).toBe(0);
    await expectReplayedState(worldId);
  }
  const worldId = await world();
  expect(
    (
      await call(
        'admin.world.requestSetting',
        command(worldId, { kind: 'admin.world.rename', name: '거절 이름' }, ordinary.id),
        ordinary.cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    await db.auditLog.count({ where: { actorUserId: ordinary.id, action: 'world.setting.request.rejected', worldId } }),
  ).toBe(1);
});

it('AC-INT-24 변경 불가 키·값·월드 상태·옛 형식과 지난 종료 연도·같은 값을 거부한다', async () => {
  const worldId = await world(false);
  for (const setting of [
    { kind: 'admin.world.setOption', key: 'commands', value: null },
    { kind: 'admin.world.setOption', key: 'npc.fillRatio', value: 0 },
    { kind: 'admin.world.setTurnTerm', turnTermMinutes: 0 },
    { kind: 'admin.world.rename', name: ' ' },
    { kind: 'admin.world.rename', name: '\u0000' },
    { kind: 'admin.world.rename', name: '\ud800' },
  ])
    expect(
      (
        await call(
          'admin.world.requestSetting',
          { ...command(worldId, { kind: 'admin.world.rename', name: 'x' }), setting },
          actor.cookie,
        )
      ).status,
    ).toBe(400);
  for (const [setting, code] of [
    [{ kind: 'admin.world.setEndYear', endYear: 190 }, 'END_YEAR_PASSED'],
    [{ kind: 'admin.world.rename', name: '생성 이름' }, 'UNCHANGED'],
    [{ kind: 'admin.world.setOption', key: 'npc.aggression', value: 0.5 }, 'NO_PRESET'],
  ] as const) {
    const input = command(worldId, setting);
    expect((await call('admin.world.requestSetting', input, actor.cookie)).status).toBe(200);
    await advance(worldId);
    expect(await call('admin.world.settingRequest', statusInput(input), actor.cookie)).toMatchObject({
      status: 200,
      data: { status: 'REJECTED', result: { code } },
    });
  }
  expect(await call('admin.world.settings', { worldId }, actor.cookie)).toMatchObject({
    status: 200,
    data: { canChangeRules: false, rules: null },
  });
  await expectReplayedState(worldId);
  for (const data of [{ status: 'PREOPEN' as const }, { replayFormat: 1 }]) {
    await db.world.update({ where: { id: worldId }, data });
    expect(
      (
        await call(
          'admin.world.requestSetting',
          command(worldId, { kind: 'admin.world.rename', name: 'x' }),
          actor.cookie,
        )
      ).status,
    ).toBe(data.replayFormat === 1 ? 400 : 409);
  }
});

it('AC-INT-24 설정·메시지·결과·감사와 시계 갱신은 한 트랜잭션에서 롤백된다', async () => {
  const worldId = await world(),
    input = command(worldId, { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 });
  expect((await call('admin.world.requestSetting', input, actor.cookie)).status).toBe(200);
  const before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 리스 필요');
  try {
    await expect(
      new TurnLoop(db, lease, {
        beforeCommit: async () => {
          throw Error('int24 rollback');
        },
      }).advanceTo(0),
    ).rejects.toThrow('int24 rollback');
  } finally {
    await releaseLease(db, lease);
  }
  expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(before);
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId } })).toMatchObject({
    status: 'PENDING',
    sequence: null,
    result: null,
  });
  expect(await db.message.count({ where: { worldId } })).toBe(0);
  expect(await db.auditLog.count({ where: { worldId, action: 'world.setting.applied' } })).toBe(0);
  await advance(worldId);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockRevision).toBe(before.clockRevision + 1);
  await expectReplayedState(worldId);
});

it('AC-INT-24 정지 중 간격은 기준 시각·활동 틱을 유지하고 재개·재시작에 새 간격을 쓴다', async () => {
  const worldId = await world(),
    before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const activity = (await db.$transaction((tx) => loadReplayState(tx, worldId))).policy!;
  expect(
    (
      await call(
        'admin.world.requestSetting',
        command(worldId, { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  const after = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(after.clockAnchorAt).toEqual(before.clockAnchorAt);
  expect(after.clockTick).toBe(before.clockTick);
  expect((await db.$transaction((tx) => loadReplayState(tx, worldId))).policy).toEqual({
    ...activity,
    turnTermMinutes: 30,
  });
  await expectReplayedState(worldId);
  const resumed = await controlClock(db, worldId, 'resume', now);
  expect(resumed.turnTermMinutes).toBe(30);
  const running = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(nowTick({ ...running, clockAnchorAt: running.clockAnchorAt!.getTime() }, now + 30000)).toBe(
    Math.floor(TICKS_PER_MONTH / 60),
  );
  expect(isInactive(0, TICKS_PER_MONTH * 337, 60)).toBe(true);
  expect(isInactive(0, TICKS_PER_MONTH * 337, 30)).toBe(false);
});

it('AC-INT-24 실행 중 옛 간격의 체크포인트를 확정한 뒤 새 간격으로 흐른다', async () => {
  const worldId = await world();
  await controlClock(db, worldId, 'resume', Date.now() - 120000);
  const before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(
    (
      await call(
        'admin.world.requestSetting',
        command(worldId, { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  // 관리자 입력을 처리한 commit에서 멈춰 다음 일반 틱을 실제로 관찰한다.
  let elapsed = 0;
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 리스 필요');
  try {
    await new TurnLoop(db, lease, { elapsedNow: () => (elapsed += 1000) }).poll();
  } finally {
    await releaseLease(db, lease);
  }
  const after = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(after.turnTermMinutes).toBe(30);
  expect(after.clockRevision).toBe(before.clockRevision + 1);
  expect(after.clockTick).toBeGreaterThanOrEqual(Math.floor((2 * TICKS_PER_MONTH) / 60));
  expect(after.clockAnchorAt!.getTime()).toBeGreaterThan(before.clockAnchorAt!.getTime());
  expect(
    nowTick({ ...after, clockAnchorAt: after.clockAnchorAt!.getTime() }, after.clockAnchorAt!.getTime() + 30000),
  ).toBe(after.clockTick + Math.floor(TICKS_PER_MONTH / 60));
  await controlClock(db, worldId, 'pause');
  await expectReplayedState(worldId);
});

it('AC-INT-24 옵션은 깊게 병합되고 로더·조회·재시작·엄격한 재생에서 같은 해시가 된다', async () => {
  const worldId = await world(),
    before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  for (const setting of [
    { kind: 'admin.world.setOption', key: 'protection.peaceMonths', value: 12 },
    { kind: 'admin.world.setOption', key: 'npc.aggression', value: 0.5 },
    { kind: 'admin.world.setOption', key: 'protection.foundUntilMonths', value: 3 },
  ] as const) {
    expect((await call('admin.world.requestSetting', command(worldId, setting), actor.cookie)).status).toBe(200);
    await advance(worldId);
  }
  const stored = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(stored.preset).toEqual(before.preset);
  expect(stored.initialStateHash).toBe(before.initialStateHash);
  expect(stored.runtimeOptions).toEqual({
    rules: { protection: { peaceMonths: 12, foundUntilMonths: 3 }, npc: { aggression: 0.5 } },
  });
  const state = await db.$transaction((tx) => loadReplayState(tx, worldId));
  expect(state.state.presetRules).toEqual({
    ...presetRules(preset),
    protection: { ...preset.protection, peaceMonths: 12, foundUntilMonths: 3 },
    npc: { aggression: 0.5 },
  });
  expect(await call('admin.world.settings', { worldId }, actor.cookie)).toMatchObject({
    status: 200,
    data: { rules: state.state.presetRules },
  });
  await expectReplayedState(worldId);
  const archive = await exportReplay(db, worldId);
  expect(() => readArchive(JSON.parse(JSON.stringify(archive)))).not.toThrow();
});

it('AC-INT-24 원본 설정으로 A→B 초기화하고 B 변경 뒤 A 내보내기·B 재초기화가 유지된다', async () => {
  const worldId = await world(true, true),
    born = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  async function change(id: string) {
    for (const setting of [
      { kind: 'admin.world.rename', name: '바꾼 이름' },
      { kind: 'admin.world.setEndYear', endYear: 232 },
      { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 },
      { kind: 'admin.world.setOption', key: 'npc.aggression', value: 0.5 },
    ] as const)
      expect((await call('admin.world.requestSetting', command(id, setting), actor.cookie)).status).toBe(200);
    await advance(id);
  }
  await change(worldId);
  expect(
    (await prepareWorldReset(db, worldId, 'int24-reset-b', AbortSignal.timeout(20000))).prepared.stateHash,
  ).not.toBe('');
  const changed = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const reset = {
    expectedUserId: actor.id,
    worldId,
    idempotencyKey: randomUUID(),
    reason: '설정 복원 검증',
    confirmName: changed.name,
    expectedRevision: changed.clockRevision,
  };
  expect((await call('admin.world.requestReset', reset, actor.cookie)).status).toBe(200);
  await advance(worldId);
  const row = await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: 'admin.world.reset' } });
  expect(row.status).toBe('APPLIED');
  const result = row.result as { newWorldId: string };
  const child = await db.world.findUniqueOrThrow({ where: { id: result.newWorldId } });
  expect(child).toMatchObject({
    name: born.name,
    turnTermMinutes: born.turnTermMinutes,
    endYear: born.endYear,
    preset: born.preset,
    runtimeOptions: null,
    status: 'PREOPEN',
  });
  const sourceArchive = await exportReplay(db, worldId);
  expect(sourceArchive.config.endYear).toBe(232);
  const forged = JSON.parse(JSON.stringify(sourceArchive));
  forged.inputs.find((input: { kind: string }) => input.kind === 'admin.world.reset').result.settings.name =
    '기록 없는 생성 이름';
  expect(() => readArchive(forged)).toThrow();

  expect(() => replayToEnd(readArchive(JSON.parse(JSON.stringify(sourceArchive))))).not.toThrow();
  await controlClock(db, child.id, 'start');
  await advance(child.id, TICKS_PER_MONTH);
  const firstMonth = await exportReplay(db, child.id);
  expect(replayArchive(readArchive(JSON.parse(JSON.stringify(firstMonth))), 1)[0]!.stateHash).toBe(
    hashState(await db.$transaction((tx) => loadReplayState(tx, child.id))),
  );
  await controlClock(db, child.id, 'pause');
  await change(child.id);
  expect(() => readArchive(JSON.parse(JSON.stringify(sourceArchive)))).not.toThrow();
  const exportedAgain = await exportReplay(db, worldId);
  expect(() => replayToEnd(readArchive(JSON.parse(JSON.stringify(exportedAgain))))).not.toThrow();
  const again = await prepareWorldReset(db, child.id, 'int24-reset-c', AbortSignal.timeout(20000));
  expect(again.evidence.sourceSettingsHash).not.toBe('');
  const current = await db.world.findUniqueOrThrow({ where: { id: child.id } });
  expect(
    (
      await call(
        'admin.world.requestReset',
        {
          ...reset,
          worldId: child.id,
          idempotencyKey: randomUUID(),
          confirmName: current.name,
          expectedRevision: current.clockRevision,
        },
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(child.id);
  expect(
    (await db.inputEvent.findFirstOrThrow({ where: { worldId: child.id, kind: 'admin.world.reset' } })).status,
  ).toBe('APPLIED');
});

it('AC-INT-24 간격 변경 전후 월간 해시와 재시작 뒤 정책이 엄격한 재생과 같다', async () => {
  const worldId = await world();
  // 작은 전쟁 고정물이 먼저 통일하지 않도록 실제 보호 옵션을 켠다.
  expect(
    (
      await call(
        'admin.world.requestSetting',
        command(worldId, {
          kind: 'admin.world.setOption',
          key: 'protection.peaceMonths',
          value: 12,
        }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  await controlClock(db, worldId, 'resume');
  await advance(worldId, TICKS_PER_MONTH);
  await controlClock(db, worldId, 'pause');
  expect(
    (
      await call(
        'admin.world.requestSetting',
        command(worldId, { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  await controlClock(db, worldId, 'resume');
  await advance(worldId, 2 * TICKS_PER_MONTH);
  await controlClock(db, worldId, 'pause');
  expect(await db.nation.count({ where: { worldId } })).toBe(2);
  const archive = await exportReplay(db, worldId);
  const replayed = replayArchive(JSON.parse(JSON.stringify(archive)), 2);
  expect(replayed).toHaveLength(2);
  expect(replayed[1]!.stateHash).toBe(hashState(await db.$transaction((tx) => loadReplayState(tx, worldId))));
  expect((await db.$transaction((tx) => loadReplayState(tx, worldId))).policy!.turnTermMinutes).toBe(30);
});

it('AC-INT-24 오래된 clockRevision의 적용은 결과·상태·메시지를 모두 되돌린다', async () => {
  const worldId = await world(),
    stale = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(
    (
      await call(
        'admin.world.requestSetting',
        command(worldId, { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 }),
        actor.cookie,
      )
    ).status,
  ).toBe(200);
  const event = await db.inputEvent.findFirstOrThrow({ where: { worldId } });
  await controlClock(db, worldId, 'resume');
  await controlClock(db, worldId, 'pause');
  const current = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 리스 필요');
  try {
    await expect(
      db.$transaction(async (tx) => {
        await lockLease(tx, lease);
        await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
        await processAdminSetting(tx, stale, event, 0);
        await assertLease(tx, lease);
      }),
    ).rejects.toThrow('다른 명령이 먼저 시계를 바꿨습니다.');
  } finally {
    await releaseLease(db, lease);
  }
  expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(current);
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId } })).toMatchObject({
    status: 'PENDING',
    sequence: null,
    result: null,
  });
  expect(await db.message.count({ where: { worldId } })).toBe(0);
  await advance(worldId);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).turnTermMinutes).toBe(30);
});
