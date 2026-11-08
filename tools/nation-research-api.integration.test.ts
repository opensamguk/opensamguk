import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { FIVE_STAT_RULES } from '../packages/rules/src/general/fiveStats';
import type { ResearchName } from '../packages/rules/src/nationResearch/state';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay } from '../apps/engine/src/replay';
import { persistPreparedTurns } from '../apps/engine/src/preparedTurnsState';
import { persistNationResearch } from '../apps/engine/src/nationResearchState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { AppRouter } from '../apps/server/src/router';
import { testDatabaseUrl } from './test-database';

// AC-P2-05·06: 4명 고정 차례의 실제 HTTP·PG 경계다. 공개491명 기수 전체의 인수는 아니다.
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw new Error('loopback 전용 연구 테스트 DB를 확인하세요.');
const db = createDb(url.href),
  worldIds: string[] = [],
  userIds: string[] = [];
const now = Date.now();
let failed = false,
  app: Awaited<ReturnType<typeof buildServer>>,
  base: string;
type Out = inferRouterOutputs<AppRouter>;
type Routes = {
  'admin.world.requestSetting': Out['admin']['world']['requestSetting'];
  'entry.possess': Out['entry']['possess'];
  'nationCommands.list': Out['nationCommands']['list'];
  'nationCommands.precheck': Out['nationCommands']['precheck'];
  'turns.precheck': Out['turns']['precheck'];
  'nationTurns.get': Out['nationTurns']['get'];
  'nationTurns.set': Out['nationTurns']['set'];
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
async function advance(worldId: string, tick = 0, beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>) {
  const lease = await acquireLease(db, worldId, randomUUID(), 120_000);
  if (!lease) throw new Error('연구 시험 월드의 리스가 없습니다.');
  try {
    await new TurnLoop(db, lease, beforeCommit ? { beforeCommit } : {}).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
const snapshot = (worldId: string) =>
  db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
async function fixture(enabled = true, research: ResearchName = 'greatsword') {
  const initial = commandInitial();
  initial.seed = `nation-research-${randomUUID()}`;
  initial.statRules = { ...FIVE_STAT_RULES };
  initial.ruleFeatures = [
    'five-stats',
    'personnel',
    'policy',
    ...(enabled ? ['prepared-turns-v1', 'nation-research-v1'] : []),
  ].sort();
  initial.unitSet.crewTypes[1]!.requirements = [{ kind: 'research', name: research }];
  for (const general of initial.generals)
    Object.assign(general, {
      politics: 55,
      charm: 55,
      userId: null,
      nextTurnTick: general.id === 2 ? 1_000_000_000 : general.id * 100,
    });
  Object.assign(initial.generals[2]!, { nationId: 1, cityKey: 1, officerLevel: 5 });
  Object.assign(initial.generals[3]!, { nationId: 1, cityKey: 1, officerLevel: 1 });
  initial.generals[0]!.crew = 0;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '연구 실제 HTTP·저장·재생',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
  });
  worldIds.push(worldId);
  const operator = await user(true),
    ruler = await user(),
    staff = await user(),
    member = await user();
  expect(
    (
      await rpc(
        'admin.world.requestSetting',
        {
          worldId,
          expectedUserId: operator.id,
          idempotencyKey: randomUUID(),
          reason: '연구 시험의 명시적 NPC 맡기',
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
    [3, staff],
    [4, member],
  ] as const) {
    const idempotencyKey = randomUUID();
    const waiting = rpc('entry.possess', { worldId, generalId, expectedUserId: actor.id, idempotencyKey }, actor, true);
    try {
      await expect
        .poll(() => db.inputEvent.count({ where: { worldId, userId: actor.id, idempotencyKey, status: 'PENDING' } }))
        .toBe(1);
      await advance(worldId);
      expect((await waiting).data).toEqual({ status: 'possessed', generalId });
    } finally {
      await waiting;
    }
  }
  await controlClock(db, worldId, 'start');
  return { worldId, ruler, staff, member };
}
async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  actor: User,
  level: number,
  key: string,
  count = 12,
  args: unknown = {},
) {
  const tab = (await rpc('nationTurns.get', { worldId: f.worldId }, actor)).data!.tabs.find(
    (row) => row.officerLevel === level,
  )!;
  return rpc(
    'nationTurns.set',
    {
      worldId: f.worldId,
      office: tab.office,
      revision: tab.revision,
      slots: Array.from({ length: 12 }, (_, index) => (index < count ? { commandKey: key, args } : null)),
    },
    actor,
    true,
  );
}
async function footprint(worldId: string) {
  return {
    replay: await snapshot(worldId),
    world: await db.world.findUniqueOrThrow({
      where: { id: worldId },
      select: { clockTick: true, actionSequence: true, preparedTurnsState: true, nationResearchState: true },
    }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    nations: await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    turns: await db.nationOfficeTurn.findMany({
      where: { worldId },
      orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }, { slot: 'asc' }],
    }),
    inputs: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    logs: await db.generalLog.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    history: await db.nationHistory.findMany({ where: { worldId }, orderBy: [{ tick: 'asc' }, { nationId: 'asc' }] }),
  };
}

async function stopTurnProcess(worldId: string, phase: 'beforeCommit' | 'committed', tick: number) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/engine/test/turnWorker.ts', worldId, phase, String(tick)],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, TEST_DATABASE_URL: url.href },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    },
  );
  const closed = once(child, 'close');
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
      closed.then(([code, signal]) => {
        throw new Error(`연구 시험 워커가 먼저 종료됐습니다: ${code ?? signal}`);
      }),
    ]);
    expect(message).toBe(phase);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual([null, 'SIGKILL']);
  } finally {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL');
    await closed;
  }
  const lease = await db.engineLease.findUniqueOrThrow({ where: { worldId } });
  await db.engineLease.update({
    where: { worldId, fencingToken: lease.fencingToken },
    data: { expiresAt: new Date(0) },
  });
  return lease.fencingToken;
}

async function expectReplay(worldId: string, tick: number) {
  // 월말 직후의 저장 해시와 같은 순번에서 멈춘다.
  await advance(worldId, tick);
  const archive = await exportReplay(db, worldId);
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {replayArchive} from './apps/engine/src/replay.ts'; const archive=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify(replayArchive(archive,archive.months.length)));",
    ],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
      input: JSON.stringify(archive),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(JSON.parse(output)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(archive.months.at(-1)!.stateHash).toBe(hashState(await snapshot(worldId)));
}

it('세션·직책·기능을 목록과 예약에서 함께 검사하고 조회는 진행을 바꾸지 않는다', async () => {
  const f = await fixture();
  expect((await rpc('nationCommands.list', { worldId: f.worldId })).status).toBe(401);
  expect((await rpc('nationCommands.list', { worldId: f.worldId }, f.member)).status).toBe(403);
  const commands = (await rpc('nationCommands.list', { worldId: f.worldId }, f.staff)).data!;
  expect(commands.filter((row) => row.key.startsWith('nation_research_'))).toHaveLength(7);
  const before = await footprint(f.worldId);
  expect(
    (
      await rpc(
        'nationCommands.precheck',
        { worldId: f.worldId, commandKey: 'nation_research_greatsword', args: {} },
        f.staff,
      )
    ).data,
  ).toEqual({ ok: true });
  expect(await footprint(f.worldId)).toEqual(before);
  expect((await reserve(f, f.staff, 5, 'nation_research_greatsword', 12, { generalId: 1 })).status).toBe(400);
  const old = await fixture(false);
  expect(
    (await rpc('nationCommands.list', { worldId: old.worldId }, old.ruler)).data!.some((row) =>
      row.key.startsWith('nation_research_'),
    ),
  ).toBe(false);
  expect((await reserve(old, old.ruler, 12, 'nation_research_greatsword')).status).toBe(400);
  expect((await db.world.findUniqueOrThrow({ where: { id: old.worldId } })).preparedTurnsState).toBeNull();
  expect((await db.world.findUniqueOrThrow({ where: { id: old.worldId } })).nationResearchState).toBeNull();
});

it('12회 연구의 준비·완료 commit 실패는 전부 복구되고 새 리스의 재개·재생이 일치한다', async () => {
  const f = await fixture(),
    key = 'nation_research_greatsword';
  const recruit = { worldId: f.worldId, commandKey: 'recruit', args: { amount: 1, crewType: 1100 } };
  expect((await rpc('turns.precheck', recruit, f.ruler)).data).toMatchObject({
    ok: false,
    message: expect.stringContaining('대검병 연구가 필요합니다.'),
  });
  expect((await reserve(f, f.ruler, 12, key)).status).toBe(200);
  const queued = await footprint(f.worldId);
  let observedPrepare = false;
  await expect(
    advance(f.worldId, 100, async (tx) => {
      const attempted = await loadReplayState(tx, f.worldId);
      expect(attempted.state.preparedTurns!.nations[1]![12]!.term).toBe(1);
      observedPrepare = true;
      throw new Error('research-prepare-save-failure');
    }),
  ).rejects.toThrow('research-prepare-save-failure');
  expect(observedPrepare).toBe(true);
  expect(await footprint(f.worldId)).toEqual(queued);
  await advance(f.worldId, 100_100);
  expect((await snapshot(f.worldId)).state.preparedTurns!.nations[1]![12]!.term).toBe(11);
  await advance(f.worldId, 110_099);
  const before = await footprint(f.worldId);
  let observedComplete = false;
  await expect(
    advance(f.worldId, 110_100, async (tx) => {
      const attempted = await loadReplayState(tx, f.worldId);
      expect(attempted.state.nationResearch!.nations[1]).toEqual(['greatsword']);
      expect(attempted.state.preparedTurns!.nations[1]).toBeUndefined();
      expect(attempted.state.nations[1]!.gold).toBe(before.replay.state.nations[1]!.gold - 50_000);
      observedComplete = true;
      throw new Error('research-complete-save-failure');
    }),
  ).rejects.toThrow('research-complete-save-failure');
  expect(observedComplete).toBe(true);
  expect(await footprint(f.worldId)).toEqual(before);
  await advance(f.worldId, 110_100);
  const after = await snapshot(f.worldId);
  expect(after.state.nationResearch!.nations[1]).toEqual(['greatsword']);
  expect(after.state.nations[1]!.gold).toBe(before.replay.state.nations[1]!.gold - 50_000);
  expect(after.state.nations[1]!.rice).toBe(before.replay.state.nations[1]!.rice - 50_000);
  expect(after.state.generals[1]!.experience).toBe(before.replay.state.generals[1]!.experience + 60);
  expect(after.state.generals[1]!.dedication).toBe(before.replay.state.generals[1]!.dedication + 60);
  expect((await rpc('turns.precheck', recruit, f.ruler)).data).toMatchObject({ ok: true });
  const completed = await footprint(f.worldId);
  await advance(f.worldId, 110_100);
  expect(await footprint(f.worldId)).toEqual(completed);
  await expect(
    db.$transaction((tx) => persistPreparedTurns(tx, f.worldId, before.replay.state, after.state)),
  ).rejects.toThrow('저장을 취소');
  await expect(
    db.$transaction((tx) => persistNationResearch(tx, f.worldId, before.replay.state, after.state)),
  ).rejects.toThrow('저장을 취소');
  await expectReplay(f.worldId, 120_000);
});

it.each([
  { research: 'fire_arrow', unit: '화시병', turns: 12, cost: 50_000 },
  { research: 'mountain', unit: '산저병', turns: 12, cost: 50_000 },
  { research: 'halberd', unit: '극병', turns: 24, cost: 100_000 },
  { research: 'repeater', unit: '원융노병', turns: 24, cost: 100_000 },
  { research: 'elephant', unit: '상병', turns: 24, cost: 100_000 },
  { research: 'fire_wheel', unit: '화륜차', turns: 24, cost: 100_000 },
] as const)('AC-P2-06 $unit 연구의 완료 횟수와 모집 개방을 검증한다', async ({ research, unit, turns, cost }) => {
  const f = await fixture(true, research),
    key = `nation_research_${research}`,
    recruit = { worldId: f.worldId, commandKey: 'recruit', args: { amount: 1, crewType: 1100 } },
    completionTick = (turns - 1) * 10_000 + 100;
  expect((await rpc('turns.precheck', recruit, f.ruler)).data).toMatchObject({
    ok: false,
    message: expect.stringContaining(`${unit} 연구가 필요합니다.`),
  });
  expect((await reserve(f, f.ruler, 12, key)).status).toBe(200);
  if (turns === 24) {
    await advance(f.worldId, 110_100);
    const halfway = await snapshot(f.worldId);
    expect(halfway.state.preparedTurns!.nations[1]![12]!.term).toBe(12);
    expect(halfway.state.nationResearch!.nations).toEqual({});
    expect((await reserve(f, f.ruler, 12, key)).status).toBe(200);
  }
  await advance(f.worldId, completionTick - 1);
  const before = await snapshot(f.worldId);
  expect(before.state.preparedTurns!.nations[1]![12]!.term).toBe(turns - 1);
  expect(before.state.nationResearch!.nations).toEqual({});
  await advance(f.worldId, completionTick);
  const after = await snapshot(f.worldId);
  expect(after.state.preparedTurns!.nations[1]).toBeUndefined();
  expect(after.state.nationResearch!.nations[1]).toEqual([research]);
  expect(after.state.nations[1]!.gold).toBe(before.state.nations[1]!.gold - cost);
  expect(after.state.nations[1]!.rice).toBe(before.state.nations[1]!.rice - cost);
  expect(after.state.generals[1]!.experience).toBe(before.state.generals[1]!.experience + turns * 5);
  expect(after.state.generals[1]!.dedication).toBe(before.state.generals[1]!.dedication + turns * 5);
  expect((await rpc('turns.precheck', recruit, f.ruler)).data).toMatchObject({ ok: true });
  await expectReplay(f.worldId, turns * 10_000);
});

it('AC-P2-06 준비 중과 완료 직후 실제 SIGKILL 뒤 연구를 한 번만 반영한다', async () => {
  const f = await fixture(true, 'halberd');
  const key = 'nation_research_halberd';
  expect((await reserve(f, f.ruler, 12, key)).status).toBe(200);
  await advance(f.worldId, 110_099);
  const preparing = await footprint(f.worldId);
  expect(preparing.replay.state.preparedTurns!.nations[1]![12]!.term).toBe(11);
  const stopped = await stopTurnProcess(f.worldId, 'beforeCommit', 110_100);
  expect(await footprint(f.worldId)).toEqual(preparing);

  expect(await stopTurnProcess(f.worldId, 'committed', 110_100)).toBe(stopped + 1);
  expect((await snapshot(f.worldId)).state.preparedTurns!.nations[1]![12]!.term).toBe(12);
  expect((await reserve(f, f.ruler, 12, key)).status).toBe(200);
  await advance(f.worldId, 230_099);
  const before = await snapshot(f.worldId);
  expect(before.state.preparedTurns!.nations[1]![12]!.term).toBe(23);
  expect(before.state.nationResearch!.nations).toEqual({});

  const completed = await stopTurnProcess(f.worldId, 'committed', 230_100);
  const saved = await footprint(f.worldId);
  const state = saved.replay.state;
  expect(state.preparedTurns!.nations[1]).toBeUndefined();
  expect(state.nationResearch!.nations[1]).toEqual(['halberd']);
  expect(state.nations[1]!.gold).toBe(before.state.nations[1]!.gold - 100_000);
  expect(state.nations[1]!.rice).toBe(before.state.nations[1]!.rice - 100_000);
  expect(state.generals[1]!.experience).toBe(before.state.generals[1]!.experience + 120);
  expect(state.generals[1]!.dedication).toBe(before.state.generals[1]!.dedication + 120);
  expect(await stopTurnProcess(f.worldId, 'committed', 230_100)).toBe(completed + 1);
  expect(await footprint(f.worldId)).toEqual(saved);
  await expectReplay(f.worldId, 240_000);
}, 90_000);

it('SQL 제약과 읽기 경계는 빠지거나 잘못된 연구 상태를 거부한다', async () => {
  const f = await fixture();
  const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
  await expect(
    db.$executeRaw`UPDATE "World" SET "preparedTurnsState" = NULL WHERE id = ${f.worldId}`,
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "World" SET "nationResearchState" = 'null'::jsonb WHERE id = ${f.worldId}`,
  ).rejects.toThrow();
  await db.world.update({
    where: { id: f.worldId },
    data: { nationResearchState: { version: 1, nations: { 1: ['unknown'] } } },
  });
  try {
    await expect(snapshot(f.worldId)).rejects.toThrow();
    await expect(exportReplay(db, f.worldId)).rejects.toThrow();
    expect(
      (
        await rpc(
          'nationCommands.precheck',
          { worldId: f.worldId, commandKey: 'nation_research_greatsword', args: {} },
          f.ruler,
        )
      ).status,
    ).toBe(500);
  } finally {
    await db.world.update({ where: { id: f.worldId }, data: { nationResearchState: world.nationResearchState! } });
  }
});
