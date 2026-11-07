import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay } from '../apps/engine/src/replay';
import { persistNationLifecycle } from '../apps/engine/src/nationLifecycleState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { AppRouter } from '../apps/server/src/router';
import { testDatabaseUrl } from './test-database';

// AC-P2-08·09: 4명·고정 일정의 실제 TCP/DB/엔진 시험이다. 정식491명 결합은 별도 시험이다.
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw Error('loopback 전용 국가 변천 테스트 DB를 확인하세요.');
const db = createDb(url.href),
  worldIds: string[] = [],
  userIds: string[] = [];
const now = Date.now();
let failed = false;
let app: Awaited<ReturnType<typeof buildServer>>, base: string;
type Out = inferRouterOutputs<AppRouter>;
type Routes = {
  'admin.world.requestSetting': Out['admin']['world']['requestSetting'];
  'entry.possess': Out['entry']['possess'];
  'commands.list': Out['commands']['list'];
  'turns.precheck': Out['turns']['precheck'];
  'turns.get': Out['turns']['get'];
  'turns.set': Out['turns']['set'];
  'general.mine': Out['general']['mine'];
  'nation.get': Out['nation']['get'];
  'nationTurns.get': Out['nationTurns']['get'];
  'nationTurns.set': Out['nationTurns']['set'];
  'treaty.propose': Out['treaty']['propose'];
  'treaty.list': Out['treaty']['list'];
};
type User = { id: string; cookie: string };
async function rpc<P extends keyof Routes>(path: P, input: unknown, user?: User, mutation = false) {
  const encoded = JSON.stringify(input);
  const response = await fetch(`${base}/trpc/${path}${mutation ? '' : `?input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: {
      origin: 'http://127.0.0.1:5173',
      ...(user ? { cookie: user.cookie } : {}),
      ...(mutation ? { 'content-type': 'application/json' } : {}),
    },
    ...(mutation ? { body: encoded } : {}),
  });
  const body = (await response.json()) as {
    result?: { data: Routes[P] };
    error?: { data: { code: string }; message: string };
  };
  return { status: response.status, data: body.result?.data, error: body.error };
}
async function user(admin = false): Promise<User> {
  const id = randomUUID(),
    session = newSession(now);
  userIds.push(id);
  await db.user.create({
    data: { id, email: `${id}@example.invalid`, passwordHash: 'test-only', role: admin ? 'ADMIN' : 'USER' },
  });
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, cookie: `sid=${session.token}` };
}
beforeEach(({ onTestFailed }) =>
  onTestFailed(() => {
    failed = true;
  }),
);
beforeAll(async () => {
  app = await buildServer({ db, now: () => now, logging: false });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app?.close();
    if (!failed) {
      await db.world.deleteMany({ where: { id: { in: worldIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    await db.$disconnect();
  }
});
async function advance(worldId: string, tick = 0, fail = false) {
  const lease = await acquireLease(db, worldId, randomUUID(), 120000);
  if (!lease) throw Error('국가 변천 시험 월드의 리스가 없습니다.');
  try {
    await new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw Error('lifecycle-save-failure');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
const snapshot = (worldId: string) =>
  db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
async function possess(worldId: string, generalId: number, actor: User, tick = 0) {
  const idempotencyKey = randomUUID();
  const waiting = rpc('entry.possess', { worldId, generalId, expectedUserId: actor.id, idempotencyKey }, actor, true);
  try {
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, userId: actor.id, idempotencyKey, status: 'PENDING' } }))
      .toBe(1);
    await advance(worldId, tick);
    expect((await waiting).data).toEqual({ status: 'possessed', generalId });
  } finally {
    await waiting;
  }
}
async function propose(worldId: string, actor: User, text: string, tick: number) {
  const requestId = randomUUID();
  const waiting = rpc(
    'treaty.propose',
    { worldId, requestId, toNationId: 2, clauses: [{ kind: 'note', text }] },
    actor,
    true,
  );
  try {
    await expect
      .poll(() =>
        db.inputEvent.count({
          where: { worldId, userId: actor.id, idempotencyKey: `treaty.propose:${requestId}`, status: 'PENDING' },
        }),
      )
      .toBe(1);
    await advance(worldId, tick);
    const result = await waiting;
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ status: 'applied' });
  } finally {
    await waiting;
  }
}
async function fixture(enabled = true, borderReturn = false) {
  const initial = commandInitial();
  initial.seed = `nation-lifecycle-${randomUUID()}`;
  initial.ruleFeatures = [
    ...(borderReturn ? ['border-return-v1'] : []),
    ...(enabled ? ['nation-lifecycle-v1'] : []),
    'personnel',
    'policy',
    ...(enabled ? ['treaty'] : []),
  ];
  initial.diplomacies = [];
  initial.cities[0]!.connections.push(3);
  initial.cities[2]!.connections.push(1);
  initial.cities[2]!.level = 5;
  initial.generals[0]!.experience = 101;
  Object.assign(initial.generals[2]!, { nationId: 1, cityKey: 4, officerLevel: 11 });
  for (const general of initial.generals) general.nextTurnTick = general.id === 1 ? 100 : 1000000000;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '선양·방랑 실제 HTTP·예턴·재생',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
  });
  worldIds.push(worldId);
  const operator = await user(true),
    ruler = await user(),
    successor = await user();
  expect(
    (
      await rpc(
        'admin.world.requestSetting',
        {
          worldId,
          expectedUserId: operator.id,
          idempotencyKey: randomUUID(),
          reason: '국가 변천 시험의 명시적 NPC 맡기',
          setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: 'on' },
        },
        operator,
        true,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  for (const [generalId, actor] of [
    [1, ruler],
    [3, successor],
  ] as const) {
    await possess(worldId, generalId, actor);
  }
  await controlClock(db, worldId, 'start');
  return { worldId, ruler, successor };
}
async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  actor: User,
  commands: Array<{ commandKey: string; args: unknown }>,
) {
  const old = (await rpc('turns.get', { worldId: f.worldId }, actor)).data!;
  return rpc(
    'turns.set',
    {
      worldId: f.worldId,
      revision: old.revision,
      slots: Array.from({ length: 30 }, (_, index) => commands[index] ?? null),
    },
    actor,
    true,
  );
}
async function expectReplay(worldId: string, months: number) {
  const archive = await exportReplay(db, worldId);
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {replayArchive} from './apps/engine/src/replay.ts'; const a=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify(replayArchive(a,a.months.length)));",
    ],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
      input: JSON.stringify(archive),
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  expect(archive.months).toHaveLength(months);
  expect(JSON.parse(output)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(archive.months.at(-1)!.stateHash).toBe(hashState(await snapshot(worldId)));
  const reopened = createDb(url.href);
  try {
    expect(hashState(await loadReplayState(reopened, worldId))).toBe(hashState(await snapshot(worldId)));
  } finally {
    await reopened.$disconnect();
  }
}

it('기능·세션·권한·엄격한 인자와 기존 월드의 NULL·조회 응답을 지킨다', async () => {
  const f = await fixture();
  expect((await rpc('commands.list', { worldId: f.worldId })).status).toBe(401);
  expect((await rpc('commands.list', { worldId: f.worldId }, f.ruler)).data!.map((row) => row.key)).toEqual(
    expect.arrayContaining(['abdicate', 'wander', 'resettle', 'disband']),
  );
  expect((await reserve(f, f.ruler, [{ commandKey: 'return_border', args: {} }])).status).toBe(400);
  expect((await rpc('general.mine', { worldId: f.worldId }, f.ruler)).data!.creationRules).toMatchObject({
    nationLifecycleEnabled: true,
  });
  expect((await rpc('nation.get', { worldId: f.worldId, nationId: 1 }, f.ruler)).data).toMatchObject({
    nationLifecycleEnabled: true,
    wandering: null,
  });
  expect(
    (await rpc('turns.precheck', { worldId: f.worldId, commandKey: 'wander', args: {} }, f.successor)).data,
  ).toMatchObject({ ok: false, code: 'NOT_RULER' });
  expect(
    (
      await rpc(
        'turns.precheck',
        { worldId: f.worldId, commandKey: 'abdicate', args: { generalId: 3, actorId: 1 } },
        f.ruler,
      )
    ).status,
  ).toBe(400);
  const old = await fixture(false);
  expect((await rpc('commands.list', { worldId: old.worldId }, old.ruler)).data!.map((row) => row.key)).not.toContain(
    'wander',
  );
  expect((await reserve(old, old.ruler, [{ commandKey: 'wander', args: {} }])).status).toBe(400);
  expect((await db.world.findUniqueOrThrow({ where: { id: old.worldId } })).nationLifecycleState).toBeNull();
  expect((await rpc('general.mine', { worldId: old.worldId }, old.ruler)).data!.creationRules).not.toHaveProperty(
    'nationLifecycleEnabled',
  );
  expect((await rpc('nation.get', { worldId: old.worldId, nationId: 1 }, old.ruler)).data).not.toHaveProperty(
    'wandering',
  );
});

it('AC-M1-14 접경귀환은 실제 HTTP 예턴을 저장하고 턴 재시도와 재생에서 같은 도시를 고른다', async () => {
  const f = await fixture(true, true);
  const input = { worldId: f.worldId, commandKey: 'return_border', args: {} };
  expect((await rpc('turns.precheck', input)).status).toBe(401);
  expect((await rpc('commands.list', { worldId: f.worldId }, f.ruler)).data).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: 'return_border', name: '접경귀환', category: 'military' })]),
  );
  expect((await rpc('turns.precheck', input, f.ruler)).data).toMatchObject({ ok: false, code: 'BAD_STATE' });
  expect((await rpc('turns.precheck', { ...input, args: { cityKey: 1 } }, f.ruler)).status).toBe(400);
  expect(
    (
      await reserve(f, f.ruler, [
        { commandKey: 'move', args: { cityKey: 3 } },
        { commandKey: 'return_border', args: {} },
      ])
    ).status,
  ).toBe(200);
  await advance(f.worldId, 10000);
  const before = await snapshot(f.worldId);
  expect(before.state.generals[1]!.cityKey).toBe(3);
  expect((await rpc('turns.precheck', input, f.ruler)).data).toMatchObject({ ok: true });
  await expect(advance(f.worldId, 10100, true)).rejects.toThrow('lifecycle-save-failure');
  expect(await snapshot(f.worldId)).toEqual(before);
  await advance(f.worldId, 10100);
  const general = (await snapshot(f.worldId)).state.generals[1]!;
  expect(general).toMatchObject({
    cityKey: 1,
    gold: before.state.generals[1]!.gold,
    rice: before.state.generals[1]!.rice,
    experience: before.state.generals[1]!.experience,
  });
  await advance(f.worldId, 20000);
  await expectReplay(f.worldId, 2);
});

it('사람 선양은 경험70%·두 직책 초기화·후계자의 개인30칸 보존을 실제 턴과 재생에 기록한다', async () => {
  const f = await fixture();
  for (const [actor, level] of [
    [f.ruler, 12],
    [f.successor, 11],
  ] as const) {
    const tabs = (await rpc('nationTurns.get', { worldId: f.worldId }, actor)).data!.tabs;
    const tab = tabs.find((row) => row.officerLevel === level)!;
    expect(
      (
        await rpc(
          'nationTurns.set',
          {
            worldId: f.worldId,
            office: tab.office,
            revision: tab.revision,
            slots: Array.from({ length: 12 }, (_, index) =>
              index === 0 ? { commandKey: 'nation_reward', args: { generalId: 3, resource: 'gold', amount: 1 } } : null,
            ),
          },
          actor,
          true,
        )
      ).status,
    ).toBe(200);
  }
  expect((await reserve(f, f.successor, [{ commandKey: 'farm', args: {} }])).status).toBe(200);
  expect((await reserve(f, f.ruler, [{ commandKey: 'abdicate', args: { generalId: 3 } }])).status).toBe(200);
  const before = await snapshot(f.worldId);
  await advance(f.worldId, 100);
  const after = await snapshot(f.worldId);
  expect(after.state.generals[1]).toMatchObject({ officerLevel: 1, experience: 71, userId: f.ruler.id });
  expect(after.state.generals[3]).toMatchObject({ officerLevel: 12, userId: f.successor.id });
  expect(after.state.nations[1]!.isNpc).toBe(false);
  expect(after.turns[3]).toEqual(before.turns[3]);
  expect(after.revisions[3]).toBe(before.revisions[3]);
  for (const level of [11, 12]) expect(after.offices![1]![level]!.tenure).toBe(before.offices![1]![level]!.tenure + 1);
  await advance(f.worldId, 10000);
  await expectReplay(f.worldId, 1);
});

it('방랑·사람 동행·재정착은 예턴으로 저장하고 재시작과 재생에 보존한다', async () => {
  const f = await fixture();
  expect(
    (
      await reserve(f, f.ruler, [
        { commandKey: 'wander', args: {} },
        { commandKey: 'move', args: { cityKey: 3 } },
        { commandKey: 'resettle', args: {} },
      ])
    ).status,
  ).toBe(200);
  await advance(f.worldId, 100);
  const before = await snapshot(f.worldId);
  expect(before.state.nationLifecycle!.nations['1']).toEqual({ sinceTick: 100 });
  expect((await rpc('nation.get', { worldId: f.worldId, nationId: 1 }, f.ruler)).data).toMatchObject({
    wandering: { sinceTick: 100, expiresTick: 240100 },
  });
  await advance(f.worldId, 10100);
  expect((await snapshot(f.worldId)).state.generals[3]!.cityKey).toBe(3);
  await advance(f.worldId, 20100);
  const after = await snapshot(f.worldId);
  expect(after.state.nations[1]!.capitalCityKey).toBe(3);
  expect(after.state.cities[3]!.nationId).toBe(1);
  expect(after.state.nationLifecycle!.nations).toEqual({});
  await advance(f.worldId, 30000);
  await expectReplay(f.worldId, 3);
});

it('수동 해산은 전원 재야·병력 해산·각1000 상한과 국가 기록을 보존한다', async () => {
  const f = await fixture();
  expect(
    (
      await reserve(f, f.ruler, [
        { commandKey: 'wander', args: {} },
        { commandKey: 'disband', args: {} },
      ])
    ).status,
  ).toBe(200);
  await advance(f.worldId, 100);
  expect(
    (await rpc('turns.precheck', { worldId: f.worldId, commandKey: 'disband', args: {} }, f.ruler)).data,
  ).toMatchObject({ ok: true });
  await advance(f.worldId, 10100);
  const state = (await snapshot(f.worldId)).state;
  expect(state.nations[1]).toBeUndefined();
  for (const id of [1, 3])
    expect(state.generals[id]).toMatchObject({
      nationId: null,
      officerLevel: 0,
      crew: 0,
      train: 0,
      atmos: 0,
      gold: 1000,
      rice: 1000,
    });
  expect(await db.removedNation.count({ where: { worldId: f.worldId, nationId: 1 } })).toBe(1);
  expect(await db.nationOffice.count({ where: { worldId: f.worldId, nationId: 1 } })).toBe(0);
  await advance(f.worldId, 20000);
  await expectReplay(f.worldId, 2);
});

it('24개월 자동 해산은 월간 저장·삭제·로그·재생 스냅샷을 같은 트랜잭션에 남긴다', async () => {
  const f = await fixture();
  await propose(f.worldId, f.ruler, 'NPC 수락으로 장기 ACTIVE', 0);
  expect(await db.treaty.count({ where: { worldId: f.worldId, status: 'ACTIVE' } })).toBe(1);
  expect((await reserve(f, f.ruler, [{ commandKey: 'wander', args: {} }])).status).toBe(200);
  await advance(f.worldId, 240000);
  expect((await snapshot(f.worldId)).state.nations[1]).toBeDefined();
  const opponent = await user();
  await possess(f.worldId, 2, opponent, 240000);
  await propose(f.worldId, f.ruler, '미만료 PROPOSED', 240000);
  expect(await db.treaty.count({ where: { worldId: f.worldId, status: 'PROPOSED', respondByTick: 300000 } })).toBe(1);
  await advance(f.worldId, 250000);
  const state = (await snapshot(f.worldId)).state;
  expect(state.nations[1]).toBeUndefined();
  expect(state.nationLifecycle!.nations).toEqual({});
  for (const id of [1, 3])
    expect(state.generals[id]).toMatchObject({ nationId: null, crew: 0, gold: 1000, rice: 1000 });
  expect(await db.generalLog.count({ where: { worldId: f.worldId, tick: 250000, commandKey: 'disband' } })).toBe(2);
  expect(await db.removedNation.count({ where: { worldId: f.worldId, nationId: 1, removedTick: 250000 } })).toBe(1);
  const closed = await db.treaty.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  const monthly = await db.yearbookSnapshot.findUniqueOrThrow({
    where: { worldId_tick: { worldId: f.worldId, tick: 250000 } },
  });
  expect(closed.map((row) => ({ status: row.status, closedSequence: row.closedSequence }))).toEqual([
    { status: 'ENDED', closedSequence: monthly.sequence },
    { status: 'EXPIRED', closedSequence: monthly.sequence },
  ]);
  expect((await snapshot(f.worldId)).state.treaties).toBeUndefined();
  const listed = (await rpc('treaty.list', { worldId: f.worldId }, opponent)).data!;
  expect(listed.items.every((item) => item.status !== 'ACTIVE' && item.status !== 'PROPOSED')).toBe(true);
  await expectReplay(f.worldId, 25);
});

it('저장 실패와 오래된CAS·오염된 원장을 거부하고 SQL NULL·JSON null의 기능 조건을 강제한다', async () => {
  const f = await fixture();
  expect((await reserve(f, f.ruler, [{ commandKey: 'wander', args: {} }])).status).toBe(200);
  await advance(f.worldId, 99);
  const before = await snapshot(f.worldId);
  await expect(advance(f.worldId, 100, true)).rejects.toThrow('lifecycle-save-failure');
  expect(hashState(await snapshot(f.worldId))).toBe(hashState(before));
  await advance(f.worldId, 100);
  const after = await snapshot(f.worldId);
  await expect(
    db.$transaction((tx) => persistNationLifecycle(tx, f.worldId, before.state, after.state)),
  ).rejects.toThrow('저장을 취소');
  await expect(
    db.$executeRaw`UPDATE "World" SET "nationLifecycleState" = NULL WHERE id = ${f.worldId}`,
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "World" SET "nationLifecycleState" = 'null'::jsonb WHERE id = ${f.worldId}`,
  ).rejects.toThrow();
  const row = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
  await db.world.update({
    where: { id: f.worldId },
    data: { nationLifecycleState: { version: 1, nations: { '999': { sinceTick: 100 } } } },
  });
  try {
    await expect(snapshot(f.worldId)).rejects.toThrow('국가가 없습니다');
    await expect(exportReplay(db, f.worldId)).rejects.toThrow('국가가 없습니다');
    expect((await rpc('nation.get', { worldId: f.worldId, nationId: 1 }, f.ruler)).status).toBe(500);
  } finally {
    await db.world.update({ where: { id: f.worldId }, data: { nationLifecycleState: row.nationLifecycleState! } });
  }
});
