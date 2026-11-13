import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadFeatureProfile, loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { initializeIntegrationResources } from './integration-resources';
import { initializeResources } from './init-resources';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { requestShutdown } from '../apps/engine/src/process-lifecycle';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, readArchive, replayArchive } from '../apps/engine/src/replay';
import { commandInitial } from '../packages/rules/test/commandFixture';
import {
  POSSESSION_KIND,
  STANDARD_EQUIPMENT_CONFIG,
  availableNpc,
  initialReplayStateWithRegistry,
  applyRecordedInput,
  runReplayAction,
  ruleRegistry,
  type RecordedInput,
  type AdminSetting,
  type ReplayOriginV3,
} from '../packages/rules/src/index';
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
const name = 'npc_entry_' + randomUUID().replaceAll('-', '') + '_test';
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
type Actor = { id: string; cookie: string; sessionId: string };
let operator: Actor, ordinary: Actor, other: Actor, sanctioned: Actor;
const children: ChildProcess[] = [];
async function user(role: 'ADMIN' | 'USER' = 'USER', status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE'): Promise<Actor> {
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
  return { id: row.id, cookie: 'sid=' + session.token, sessionId: session.id };
}
async function call<T = unknown>(path: string, input: unknown, cookie?: string) {
  const mutation = ['admin.world.requestSetting', 'admin.game.request', 'general.create', 'entry.possess'].includes(
    path,
  );
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
  const raw = await response.text();
  const [body] = JSON.parse(raw) as [
    { result?: { data: T }; error?: { data: { code: string; reason: string | null } } },
  ];
  return { status: response.status, data: body.result?.data, code: body.error?.data.code, raw };
}
async function world(features = true) {
  const initial = commandInitial();
  initial.ruleFeatures = features ? ['personnel', 'policy'] : [];
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '역할 입장 검증',
    turnTermMinutes: 60,
    endYear: 231,
    replayFormat: 3,
  });
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
function claim(worldId: string, generalId: number, actor = ordinary) {
  return { worldId, generalId, expectedUserId: actor.id, idempotencyKey: randomUUID() };
}
function receipt(input: ReturnType<typeof claim>) {
  return { worldId: input.worldId, expectedUserId: input.expectedUserId, idempotencyKey: input.idempotencyKey };
}
async function requestOption(worldId: string, value: 'on' | 'off') {
  const input = {
    worldId,
    expectedUserId: operator.id,
    idempotencyKey: randomUUID(),
    reason: '입장 설정 검증',
    setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value } satisfies AdminSetting,
  };
  expect(await call('admin.world.requestSetting', input, operator.cookie)).toMatchObject({ status: 200 });
  return input;
}
async function enable(worldId: string) {
  await requestOption(worldId, 'on');
  await advance(worldId);
  expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toMatchObject({
    runtimeOptions: { entry: { npcPlay: 'on' } },
  });
}
async function applyClaim(input: ReturnType<typeof claim>, actor = ordinary) {
  const waiting = call('entry.possess', input, actor.cookie);
  await expect
    .poll(() =>
      db.inputEvent.count({
        where: { worldId: input.worldId, userId: actor.id, idempotencyKey: input.idempotencyKey, status: 'PENDING' },
      }),
    )
    .toBe(1);
  await advance(input.worldId);
  return waiting;
}
async function expectReplayed(worldId: string) {
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const origin = world.replayOrigin as unknown as ReplayOriginV3;
  let replay = initialReplayStateWithRegistry(origin.initial, ruleRegistry, origin.featureData);
  const inputs = new Map(
    (await db.inputEvent.findMany({ where: { worldId, sequence: { not: null } } })).map((row) => [row.sequence!, row]),
  );
  for (let sequence = 1; sequence <= world.actionSequence; sequence++) {
    const row = inputs.get(sequence);
    replay = row
      ? applyRecordedInput(
          replay,
          {
            sequence,
            tick: row.tick,
            generalId: row.generalId,
            kind: row.kind,
            status: row.status,
            payload: row.payload,
            result: row.result,
          } as RecordedInput,
          ruleRegistry,
          { unitSet: origin.initial.unitSet },
        )
      : runReplayAction(replay, origin.initial.seed, origin.initial.unitSet, undefined, ruleRegistry);
  }
  expect(hashState(replay)).toBe(hashState(await db.$transaction((tx) => loadReplayState(tx, worldId))));
}
function supervisor() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/supervisorWorker.ts'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATABASE_URL: target.href, TEST_DATABASE_URL: target.href },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Drain pipes so diagnostics cannot block the real supervisor or worker.
  child.stdout!.resume();
  child.stderr!.resume();
  children.push(child);
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  requestShutdown(child, 'SIGTERM');
  await exited;
  expect(child.exitCode).toBe(0);
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
  operator = await user('ADMIN');
  ordinary = await user();
  other = await user();
  sanctioned = await user('USER', 'SANCTIONED');
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
afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') failed = true;
  await Promise.all(children.splice(0).map(stop));
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
    JSON.stringify({ event: 'npc-entry-cleanup', name, oid, failed, ready, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError(errors, '장수 맡기 시험의 자기 자원 정리 실패');
});

it('AC-M3-14 정식491명 확장 판에서5능력치 후보를 맡고 장비·자원·가계 상태를 보존한다', async () => {
  const { value: profile } = await loadFeatureProfile('expanded-191-v1');
  const initial = await loadInitialWorldFromDb(db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'npc-expanded-ownership',
  });
  expect(initial.generals).toHaveLength(491);
  const features = [...profile.ruleFeatures, 'equipment-v1'].sort();
  initial.ruleFeatures = features;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '정식 확장 맡기',
    turnTermMinutes: 60,
    endYear: 231,
    replayFormat: 3,
    ruleFeatures: features,
    featureData: { ...profile.featureData, 'equipment-v1': STANDARD_EQUIPMENT_CONFIG },
  });
  await enable(worldId);
  const before = await db.$transaction((tx) => loadReplayState(tx, worldId));
  const candidate = Object.values(before.state.generals).find(
    (row) => row.officerLevel !== 12 && availableNpc(before.state, row.id, 0),
  )!;
  expect(candidate).toBeDefined();
  const response = await call<{ roles: Record<string, Array<Record<string, unknown>>> }>(
    'entry.roles',
    { worldId },
    ordinary.cookie,
  );
  expect(
    Object.values(response.data!.roles)
      .flat()
      .find((row) => row.generalId === candidate.id),
  ).toMatchObject({ politics: candidate.politics, charm: candidate.charm });
  expect((await applyClaim(claim(worldId, candidate.id))).data).toEqual({
    status: 'possessed',
    generalId: candidate.id,
  });
  const after = await db.$transaction((tx) => loadReplayState(tx, worldId));
  expect(after.state.generals[candidate.id]).toEqual({ ...candidate, userId: ordinary.id });
  for (const key of ['equipment', 'logistics', 'lineage', 'governance'] as const) {
    expect(before.state[key], key).toBeDefined();
    expect(after.state[key], key).toEqual(before.state[key]);
  }
  expect(after.residenceAnchors?.[candidate.id]).toBe(0);
  expect(after.policy?.lastActiveTicks[candidate.id]).toBe(0);
  await expectReplayed(worldId);
});

it('AC-M3-14·AC-INT-24 기본 off PREOPEN을 실제 감독이 운영 API로 열고 시계를 움직이지 않고 맡긴다', async () => {
  const worldId = await world();
  const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  const queue = await db.generalTurn.findMany({ where: { worldId, generalId: 1 }, orderBy: { slot: 'asc' } });
  const clock = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect(await call('entry.possess', claim(worldId, 1), ordinary.cookie)).toMatchObject({ status: 412 });
  expect((await call('general.mine', { worldId }, ordinary.cookie)).raw).not.toContain('npcPlayEnabled');
  const child = supervisor();
  const opening = await requestOption(worldId, 'on');
  await expect
    .poll(
      async () =>
        (await call('admin.world.settingRequest', receipt({ ...opening, generalId: 1 }), operator.cookie)).data,
      { timeout: 25000 },
    )
    .toMatchObject({ status: 'APPLIED' });
  expect(await call('admin.world.settings', { worldId }, operator.cookie)).toMatchObject({
    data: { canChangeNpcPlay: true, canChangeRules: false, entry: { npcPlay: 'on' } },
  });
  const input = claim(worldId, 1);
  const response = await call('entry.possess', input, ordinary.cookie);
  if ((response.data as { status: string }).status === 'pending')
    await expect
      .poll(async () => (await call('entry.possessStatus', receipt(input), ordinary.cookie)).data, { timeout: 25000 })
      .toEqual({ status: 'possessed', generalId: 1 });
  else expect(response.data).toEqual({ status: 'possessed', generalId: 1 });
  await stop(child);
  const after = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  expect(after).toEqual({
    ...before,
    userId: ordinary.id,
    turnRevision: before.turnRevision + 1,
    residenceTick: 0,
    lastActiveTick: 0,
    lastActiveAt: expect.any(Date),
  });
  expect(await db.generalTurn.findMany({ where: { worldId, generalId: 1 }, orderBy: { slot: 'asc' } })).toEqual(queue);
  expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
    isNpc: false,
  });
  expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toMatchObject({
    status: 'PREOPEN',
    clockTick: clock.clockTick,
    monthlyTick: clock.monthlyTick,
    clockAnchorAt: clock.clockAnchorAt,
  });
  expect((await call('general.mine', { worldId }, ordinary.cookie)).data).toMatchObject({
    general: { id: 1 },
    creationRules: { npcPlayEnabled: true },
  });
  const unused = await user();
  expect(
    (
      await call(
        'general.create',
        { worldId, name: '직접입장', leadership: 70, strength: 70, intel: 60, portraitId: null },
        unused.cookie,
      )
    ).status,
  ).toBe(412);
  await expectReplayed(worldId);
});

for (const path of ['entry.roles', 'entry.possess', 'entry.possessStatus'] as const) {
  it(
    `${path} 무인증`,
    authzCase(path, 'unauthenticated', async () => {
      const worldId = await world(),
        input = claim(worldId, 3);
      expect(
        (await call(path, path === 'entry.roles' ? { worldId } : path === 'entry.possess' ? input : receipt(input)))
          .status,
      ).toBe(401);
    }),
  );
  it(
    `${path} 제재 계정`,
    authzCase(path, 'sanctioned', async () => {
      const worldId = await world(),
        input = claim(worldId, 3, sanctioned);
      expect(
        (
          await call(
            path,
            path === 'entry.roles' ? { worldId } : path === 'entry.possess' ? input : receipt(input),
            sanctioned.cookie,
          )
        ).status,
      ).toBe(401);
    }),
  );
  it(
    `${path} 잘못된 입력`,
    authzCase(path, 'invalidInput', async () => {
      const input = claim('missing-world', 3);
      expect(
        (
          await call(
            path,
            path === 'entry.roles'
              ? { worldId: 'missing-world' }
              : path === 'entry.possess'
                ? { ...input, generalId: 0 }
                : { ...receipt(input), idempotencyKey: 'invalid' },
            ordinary.cookie,
          )
        ).status,
      ).toBe(400);
    }),
  );
}

it(
  '역할 목록은 공개 후보 필드만 반환한다',
  authzCase('entry.roles', 'success', async () => {
    const worldId = await world();
    await enable(worldId);
    const response = await call<{ roles: Record<string, Array<Record<string, unknown>>> }>(
      'entry.roles',
      { worldId },
      ordinary.cookie,
    );
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ canPossess: true, mine: null, quota: { humans: 0, max: 500 } });
    expect(response.data!.roles.ruler!.map((row) => row.generalId)).toEqual([1, 2]);
    expect(response.data!.roles.core!.map((row) => row.generalId)).toEqual([3]);
    expect(response.data!.roles.free![0]).toMatchObject({ generalId: 4, recommendedNation: { id: 1 } });
    for (const candidate of Object.values(response.data!.roles).flat())
      expect(Object.keys(candidate).sort()).toEqual(
        [
          'generalId',
          'name',
          'portraitId',
          'nation',
          'city',
          'leadership',
          'strength',
          'intel',
          'officerLevel',
          'recommendedNation',
        ].sort(),
      );
  }),
);

it(
  '사람 소유 후보를 숨기고 기존 장수 사용자는 후보를 받지 않는다',
  authzCase('entry.roles', 'otherUser', async () => {
    const worldId = await world();
    await enable(worldId);
    expect((await applyClaim(claim(worldId, 3))).data).toEqual({ status: 'possessed', generalId: 3 });
    const response = await call<{ roles: Record<string, Array<{ generalId: number }>> }>(
      'entry.roles',
      { worldId },
      other.cookie,
    );
    expect(
      Object.values(response.data!.roles)
        .flat()
        .some((row) => row.generalId === 3),
    ).toBe(false);
    expect((await call('entry.roles', { worldId }, ordinary.cookie)).data).toMatchObject({
      roles: { ruler: [], core: [], retainer: [], free: [] },
      canPossess: false,
    });
  }),
);

it(
  '비군주 맡기는 소유권·revision·활동만 바꾸고 재전송은 기록을 늘리지 않는다',
  authzCase('entry.possess', 'success', async () => {
    const worldId = await world();
    await enable(worldId);
    const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
    const input = claim(worldId, 3),
      result = await applyClaim(input);
    expect(result.data).toEqual({ status: 'possessed', generalId: 3 });
    const event = await db.inputEvent.findUniqueOrThrow({
      where: { worldId_userId_idempotencyKey: { worldId, userId: ordinary.id, idempotencyKey: input.idempotencyKey } },
    });
    expect(event).toMatchObject({
      status: 'APPLIED',
      generalId: 3,
      sequence: expect.any(Number),
      result: {
        generalId: 3,
        userId: ordinary.id,
        revision: before.turnRevision + 1,
        rulerNationId: null,
        activeTick: 0,
      },
    });
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toEqual({
      ...before,
      userId: ordinary.id,
      turnRevision: before.turnRevision + 1,
      residenceTick: 0,
      lastActiveTick: 0,
      lastActiveAt: expect.any(Date),
    });
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } })).toMatchObject({
      isNpc: true,
    });
    const logs = await db.generalLog.findMany({ where: { worldId, generalId: 3 }, orderBy: { ordinal: 'asc' } });
    expect(logs.filter((row) => row.kind === 'possess')).toHaveLength(1);
    expect(new Set(logs.map((row) => `${row.sequence}:${row.ordinal}`)).size).toBe(logs.length);
    const replay = await db.$transaction((tx) => loadReplayState(tx, worldId));
    expect(replay.residenceAnchors?.[3]).toBe(0);
    expect(replay.policy?.lastActiveTicks[3]).toBe(0);
    expect((await call('entry.possess', input, ordinary.cookie)).data).toEqual(result.data);
    expect(await db.generalLog.findMany({ where: { worldId, generalId: 3 }, orderBy: { ordinal: 'asc' } })).toEqual(
      logs,
    );
    expect(await db.inputEvent.count({ where: { worldId, kind: POSSESSION_KIND } })).toBe(1);
    expect((await call('entry.possess', { ...input, generalId: 4 }, ordinary.cookie)).status).toBe(409);
    await expectReplayed(worldId);
  }),
);

it(
  '남이 맡은 인물과 계정 전환은 접수하지 않는다',
  authzCase('entry.possess', 'otherUser', async () => {
    const worldId = await world();
    await enable(worldId);
    await applyClaim(claim(worldId, 3));
    expect(await call('entry.possess', claim(worldId, 3, other), other.cookie)).toMatchObject({
      status: 200,
      data: { status: 'rejected', rejectCode: 'TAKEN' },
    });
    expect((await call('entry.possess', claim(worldId, 4, ordinary), other.cookie)).status).toBe(401);
    expect(await db.inputEvent.count({ where: { worldId, kind: POSSESSION_KIND } })).toBe(1);
  }),
);

it(
  '내 완료 요청만 영수증으로 조회한다',
  authzCase('entry.possessStatus', 'success', async () => {
    const worldId = await world();
    await enable(worldId);
    const input = claim(worldId, 4);
    await applyClaim(input);
    expect((await call('entry.possessStatus', receipt(input), ordinary.cookie)).data).toEqual({
      status: 'possessed',
      generalId: 4,
    });
  }),
);
it(
  '다른 사용자 요청 키는 보이지 않는다',
  authzCase('entry.possessStatus', 'otherUser', async () => {
    const worldId = await world();
    await enable(worldId);
    const input = claim(worldId, 3);
    await applyClaim(input);
    expect(
      (await call('entry.possessStatus', { ...receipt(input), expectedUserId: other.id }, other.cookie)).status,
    ).toBe(404);
    expect((await call('entry.possessStatus', receipt(input), other.cookie)).status).toBe(401);
  }),
);

it('같은 인물의 동시 접수는 엔진에서 하나만 적용하고 같은 계정의 두 번째 접수는 API에서 막는다', async () => {
  for (const sameUser of [false, true]) {
    const worldId = await world();
    await enable(worldId);
    const a = claim(worldId, 3),
      b = claim(worldId, sameUser ? 4 : 3, sameUser ? ordinary : other);
    const requests = [
      call('entry.possess', a, ordinary.cookie),
      call('entry.possess', b, sameUser ? ordinary.cookie : other.cookie),
    ];
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: POSSESSION_KIND, status: 'PENDING' } }))
      .toBe(sameUser ? 1 : 2);
    if (sameUser) expect(await Promise.race(requests)).toMatchObject({ status: 409, code: 'CONFLICT' });
    await advance(worldId);
    const results = await Promise.all(requests);
    expect(
      results.filter((result) => (result.data as { status: string } | undefined)?.status === 'possessed'),
    ).toHaveLength(1);
    if (sameUser) expect(results).toContainEqual(expect.objectContaining({ status: 409, code: 'CONFLICT' }));
    else
      expect(results).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ rejectCode: 'TAKEN' }) }),
      );
    expect(await db.generalLog.count({ where: { worldId, kind: 'possess' } })).toBe(1);
    await expectReplayed(worldId);
  }
});

it('NPC 무장 맡기가 대기 중인 계정은 신규 장수를 함께 만들 수 없다', async () => {
  const worldId = await world();
  await enable(worldId);
  const input = claim(worldId, 3);
  const pending = call('entry.possess', input, ordinary.cookie);
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: POSSESSION_KIND, status: 'PENDING' } }))
    .toBe(1);
  expect(
    await call(
      'general.create',
      { worldId, name: '새장수', leadership: 70, strength: 70, intel: 60, portraitId: null },
      ordinary.cookie,
    ),
  ).toMatchObject({ status: 409, code: 'CONFLICT' });
  await advance(worldId);
  expect(await pending).toMatchObject({ data: { status: 'possessed', generalId: 3 } });
});

it('엔진이 없는 pending은 회수하고 꺼진 뒤에는 엔진 거절 결과를 보존한다', async () => {
  const worldId = await world();
  await enable(worldId);
  await requestOption(worldId, 'off');
  const input = claim(worldId, 3);
  expect((await call('entry.possess', input, ordinary.cookie)).data).toEqual({ status: 'pending' });
  const event = await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: POSSESSION_KIND } });
  expect(event).toMatchObject({ generalId: null, status: 'PENDING', sequence: null });
  await advance(worldId);
  expect((await call('entry.possessStatus', receipt(input), ordinary.cookie)).data).toMatchObject({
    status: 'rejected',
    rejectCode: 'ENTRY_CLOSED',
  });
  expect((await call('entry.possess', input, ordinary.cookie)).data).toMatchObject({
    status: 'rejected',
    rejectCode: 'ENTRY_CLOSED',
  });
  expect(await db.generalLog.count({ where: { worldId, kind: 'possess' } })).toBe(0);
});

it('AC-M3-14 같은 tick의 실제 턴과 맡기 로그는 어느 순서에도 함께 조회된다', async () => {
  for (const turnFirst of [false, true]) {
    const worldId = await world();
    await enable(worldId);
    await controlClock(db, worldId, 'start');
    if (turnFirst) await advance(worldId, 100);
    const input = claim(worldId, 1),
      waiting = call('entry.possess', input, ordinary.cookie);
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: POSSESSION_KIND, status: 'PENDING' } }))
      .toBe(1);
    await advance(worldId, 100);
    expect((await waiting).data).toEqual({ status: 'possessed', generalId: 1 });
    const logs = await db.generalLog.findMany({ where: { worldId, generalId: 1, tick: 100 }, orderBy: { id: 'desc' } });
    expect(logs.filter((row) => row.kind === 'success' || row.kind === 'failure')).toHaveLength(1);
    expect(logs.filter((row) => row.kind === 'possess')).toHaveLength(1);
    const records = await call<{ items: Array<{ id: string; tick: number; kind: string }> }>(
      'records.general',
      { worldId },
      ordinary.cookie,
    );
    const home = await call<{ recentLogs: unknown[] }>('home.get', { worldId }, ordinary.cookie);
    expect(records.data!.items.map((row) => row.id)).toEqual(logs.map((row) => row.id.toString()));
    expect(home.data!.recentLogs).toEqual(records.data!.items);
    await advance(worldId, 100);
    expect(await db.generalLog.count({ where: { worldId, generalId: 1, tick: 100 } })).toBe(logs.length);
    await expectReplayed(worldId);
  }
});

it('AC-M3-14 commit 실패는 소유권·앵커·맡기 로그·완료 기록을 함께 되돌린다', async () => {
  const worldId = await world();
  await enable(worldId);
  const input = claim(worldId, 3),
    waiting = call('entry.possess', input, ordinary.cookie);
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: POSSESSION_KIND, status: 'PENDING' } }))
    .toBe(1);
  const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('자기 시험 리스가 없습니다.');
  try {
    await expect(
      new TurnLoop(db, lease, {
        beforeCommit: () => {
          throw Error('NPC 소유권 rollback 시험');
        },
      }).advanceTo(0),
    ).rejects.toThrow('NPC 소유권 rollback 시험');
  } finally {
    await releaseLease(db, lease);
  }
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toEqual(before);
  expect(await db.generalLog.count({ where: { worldId, kind: 'possess' } })).toBe(0);
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: POSSESSION_KIND } })).toMatchObject({
    status: 'PENDING',
    sequence: null,
    generalId: null,
  });
  await advance(worldId);
  expect((await waiting).data).toEqual({ status: 'possessed', generalId: 3 });
  expect(await db.generalLog.count({ where: { worldId, kind: 'possess' } })).toBe(1);
  await expectReplayed(worldId);
});

it('AC-M3-14 맡기 입력과 실제 턴·월 정산을 섞은 12개월 보관 파일을 엄격하게 재생한다', async () => {
  const initial = commandInitial();
  initial.ruleFeatures = ['personnel', 'policy'];
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 130000 }];
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '맡기 월간 재생',
    turnTermMinutes: 60,
    endYear: 231,
    replayFormat: 3,
  });
  await enable(worldId);
  await applyClaim(claim(worldId, 1));
  await applyClaim(claim(worldId, 3, other), other);
  await controlClock(db, worldId, 'start');
  for (let month = 1; month <= 12; month++) await advance(worldId, month * 10000);
  await controlClock(db, worldId, 'pause');
  const archive = readArchive(JSON.parse(JSON.stringify(await exportReplay(db, worldId))));
  expect(archive.inputs.filter((row) => row.kind === POSSESSION_KIND)).toHaveLength(2);
  expect(archive.months).toHaveLength(12);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  await expectReplayed(worldId);
});

it('소유 해제·다른 계정 재맡기 뒤 옛 영수증은 새 사용자의 상세를 반환하지 않는다', async () => {
  const worldId = await world();
  await enable(worldId);
  const input = claim(worldId, 3);
  await applyClaim(input);
  await controlClock(db, worldId, 'start');
  await controlClock(db, worldId, 'pause');
  const release = {
    worldId,
    expectedUserId: operator.id,
    idempotencyKey: randomUUID(),
    reason: '재입장 개인정보 회귀',
    action: { kind: 'admin.general.release', generalId: 3 },
  };
  expect((await call('admin.game.request', release, operator.cookie)).status).toBe(200);
  await advance(worldId);
  await controlClock(db, worldId, 'resume');
  const next = claim(worldId, 3, other);
  expect((await applyClaim(next, other)).data).toEqual({ status: 'possessed', generalId: 3 });
  const count = await db.inputEvent.count({ where: { worldId } }),
    logs = await db.generalLog.count({ where: { worldId } });
  for (const path of ['entry.possess', 'entry.possessStatus']) {
    const response = await call(path, path === 'entry.possess' ? input : receipt(input), ordinary.cookie);
    expect(response.data).toEqual({ status: 'possessed', generalId: 3 });
    expect(response.raw).not.toContain(other.id);
  }
  expect(await db.inputEvent.count({ where: { worldId } })).toBe(count);
  expect(await db.generalLog.count({ where: { worldId } })).toBe(logs);
  await expectReplayed(worldId);
});

for (const invalidation of ['logout', 'expiry', 'inactive', 'world-sanction', 'global-sanction'] as const)
  it(`대기 도중 ${invalidation}이면 완료 응답 전에 권한을 다시 검사한다`, async () => {
    const actor = await user(),
      worldId = await world();
    await enable(worldId);
    const input = claim(worldId, 3, actor),
      pending = call('entry.possess', input, actor.cookie);
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: POSSESSION_KIND, status: 'PENDING' } }))
      .toBe(1);
    if (invalidation === 'logout') await db.session.delete({ where: { id: actor.sessionId } });
    else if (invalidation === 'expiry')
      await db.session.update({ where: { id: actor.sessionId }, data: { expiresAt: new Date(requestNow - 1) } });
    else if (invalidation === 'inactive')
      await db.user.update({ where: { id: actor.id }, data: { status: 'SANCTIONED' } });
    else
      await db.sanction.create({
        data: {
          userId: actor.id,
          worldId: invalidation === 'world-sanction' ? worldId : null,
          reason: '대기 권한 회귀',
          createdBy: operator.id,
        },
      });
    expect((await pending).status).toBe(invalidation.endsWith('sanction') ? 403 : 401);
    await advance(worldId);
    expect(await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: POSSESSION_KIND } })).toMatchObject({
      status: invalidation === 'inactive' || invalidation.endsWith('sanction') ? 'REJECTED' : 'APPLIED',
    });
  });
