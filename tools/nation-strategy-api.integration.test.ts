import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { FIVE_STAT_RULES } from '../packages/rules/src/general/fiveStats';
import { TEST_STRATAGEM_CARDS_CONFIG } from '../packages/rules/src/stratagemCards/testFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay } from '../apps/engine/src/replay';
import { persistNationStrategy } from '../apps/engine/src/nationStrategyState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { AppRouter } from '../apps/server/src/router';
import { testDatabaseUrl } from './test-database';

// AC-P2-04: 4명·고정 차례의 실제 TCP/DB/엔진 검증이다. 전체 공개 확장 판의 증거는 아니다.
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw new Error('loopback 전용 전략 테스트 DB를 확인하세요.');
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
  'nationCommands.list': Out['nationCommands']['list'];
  'nationCommands.precheck': Out['nationCommands']['precheck'];
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
async function advance(worldId: string, tick = 0, fail = false) {
  const lease = await acquireLease(db, worldId, randomUUID(), 120000);
  if (!lease) throw new Error('전략 시험 월드의 리스가 없습니다.');
  try {
    await new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw new Error('strategy-save-failure');
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
async function fixture(kind: 'nation_mobilize' | 'nation_rivalry' | 'nation_raid' = 'nation_mobilize', enabled = true) {
  const initial = commandInitial();
  initial.seed = `nation-strategy-${randomUUID()}`;
  initial.statRules = { ...FIVE_STAT_RULES };
  initial.ruleFeatures = [
    'five-stats',
    'personnel',
    'policy',
    ...(enabled ? ['nation-strategy-v1', 'stratagem-basic', 'stratagem-cards-v1'] : []),
  ].sort();
  for (const general of initial.generals)
    Object.assign(general, {
      politics: 55,
      charm: 55,
      userId: null,
      nextTurnTick: general.id === 2 ? 1000000000 : general.id * 100,
    });
  Object.assign(initial.generals[2]!, { nationId: 1, cityKey: 1, officerLevel: 5 });
  Object.assign(initial.generals[3]!, { nationId: 1, cityKey: 1, officerLevel: 11 });
  if (kind === 'nation_raid') Object.assign(initial.diplomacies[0]!, { state: 'DECLARED', untilTick: 20000 });
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '전략 실제 HTTP·예턴·재생',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ...(enabled
      ? {
          featureData: {
            'stratagem-cards-v1': {
              version: 1,
              config: { ...TEST_STRATAGEM_CARDS_CONFIG, startHand: 1, deck: [{ kind, weight: 1 }] },
            },
          },
        }
      : {}),
  });
  worldIds.push(worldId);
  const operator = await user(true),
    ruler = await user(),
    staff = await user(),
    adviser = await user();
  expect(
    (
      await rpc(
        'admin.world.requestSetting',
        {
          worldId,
          expectedUserId: operator.id,
          idempotencyKey: randomUUID(),
          reason: '전략 시험의 명시적 NPC 맡기',
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
    [4, adviser],
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
  return { worldId, ruler, staff, adviser };
}
async function reserve(f: Awaited<ReturnType<typeof fixture>>, actor: User, level: number, key: string, args: unknown) {
  const tabs = (await rpc('nationTurns.get', { worldId: f.worldId }, actor)).data!.tabs;
  const tab = tabs.find((row) => row.officerLevel === level)!;
  return rpc(
    'nationTurns.set',
    {
      worldId: f.worldId,
      office: tab.office,
      revision: tab.revision,
      slots: Array.from({ length: 12 }, (_, i) => (i === 0 ? { commandKey: key, args } : null)),
    },
    actor,
    true,
  );
}
async function expectReplay(worldId: string) {
  await advance(worldId, 10000);
  const archive = await exportReplay(db, worldId);
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {replayArchive} from './apps/engine/src/replay.ts'; console.log(JSON.stringify(replayArchive(JSON.parse(readFileSync(0,'utf8')),1)));",
    ],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
      input: JSON.stringify(archive),
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  expect(JSON.parse(output)).toEqual(archive.months.map((row) => ({ tick: row.tick, stateHash: row.stateHash })));
  expect(archive.months.at(-1)!.stateHash).toBe(hashState(await snapshot(worldId)));
}

it('직책별 목록·사전 검사·저장은 세션과 기능을 검사하고 다른 직책·꺼진 월드의 전략을 거부한다', async () => {
  const f = await fixture();
  expect((await rpc('nationCommands.list', { worldId: f.worldId })).status).toBe(401);
  const staff = (await rpc('nationCommands.list', { worldId: f.worldId }, f.staff)).data!;
  expect(staff.find((row) => row.key === 'nation_mobilize')).toMatchObject({
    category: 'strategy',
    group: 'strategy',
    description: '자기 국가 도시의 수비와 성벽을 최대치의 80%까지 복구합니다.',
    cost: null,
    requirements: expect.arrayContaining(['전략 재사용 대기 종료']),
    turns: 1,
    cooldown: { remainingMonths: 0, availableAt: null },
  });
  expect(staff.find((row) => row.key === 'nation_rest')?.group).toBe('rest');
  expect(staff.map((row) => row.key)).not.toContain('nation_rivalry');
  const adviser = (await rpc('nationCommands.list', { worldId: f.worldId }, f.adviser)).data!;
  expect(adviser.map((row) => row.key)).toEqual(
    expect.arrayContaining(['nation_mobilize', 'nation_rivalry', 'nation_raid']),
  );
  expect((await reserve(f, f.staff, 5, 'nation_rivalry', { nationId: 2 })).status).toBe(400);
  expect(
    (
      await rpc(
        'nationCommands.precheck',
        { worldId: f.worldId, commandKey: 'nation_mobilize', args: { cityKey: 1 } },
        f.staff,
      )
    ).data,
  ).toEqual({ ok: true });
  const old = await fixture('nation_mobilize', false);
  expect(
    (await rpc('nationCommands.list', { worldId: old.worldId }, old.ruler)).data!.map((row) => row.key),
  ).not.toContain('nation_mobilize');
  expect((await reserve(old, old.ruler, 12, 'nation_mobilize', { cityKey: 1 })).status).toBe(400);
  expect((await db.world.findUniqueOrThrow({ where: { id: old.worldId } })).nationStrategyState).toBeNull();
  expect((await snapshot(old.worldId)).state).not.toHaveProperty('nationStrategy');
});

it('수뇌의 백성동원은 실제 차례에 패·수비·대기를 함께 저장하며 실패는 전부 되돌리고 재생도 일치한다', async () => {
  const f = await fixture();
  expect((await reserve(f, f.staff, 5, 'nation_mobilize', { cityKey: 1 })).status).toBe(200);
  await advance(f.worldId, 299);
  const before = await snapshot(f.worldId);
  await expect(advance(f.worldId, 300, true)).rejects.toThrow('strategy-save-failure');
  expect(hashState(await snapshot(f.worldId))).toBe(hashState(before));
  await advance(f.worldId, 300);
  const after = await snapshot(f.worldId);
  expect(after.state.cities[1]!.defence).toBe(800);
  expect(after.state.nationStrategy!.nations[1]).toEqual({ strategicUntil: 9, commands: { nation_mobilize: 63 } });
  const commands = (await rpc('nationCommands.list', { worldId: f.worldId }, f.adviser)).data!;
  expect(commands.find((row) => row.key === 'nation_mobilize')).toMatchObject({
    cooldown: { remainingMonths: 63, availableAt: { year: after.state.startYear + 5, month: 4 } },
  });
  expect(commands.find((row) => row.key === 'nation_raid')).toMatchObject({
    cooldown: { remainingMonths: 9, availableAt: { year: after.state.startYear, month: 10 } },
  });
  expect(after.state.stratagemCards!.nations[1]!.hand).toEqual([]);
  expect(after.state.generals[3]!.dedication).toBe(before.state.generals[3]!.dedication + 5);
  await expect(
    db.$transaction((tx) => persistNationStrategy(tx, f.worldId, before.state, after.state)),
  ).rejects.toThrow('저장을 취소');
  expect(
    (
      await rpc(
        'nationCommands.precheck',
        { worldId: f.worldId, commandKey: 'nation_mobilize', args: { cityKey: 1 } },
        f.staff,
      )
    ).data,
  ).toMatchObject({ ok: false });
  await expectReplay(f.worldId);
});

it.each(['nation_rivalry', 'nation_raid'] as const)(
  '%s는 참모의 실제 예턴으로 외교·패·대기를 저장하고 DB 없는 재생과 일치한다',
  async (key) => {
    const f = await fixture(key);
    expect((await reserve(f, f.adviser, 11, key, { nationId: 2 })).status).toBe(200);
    await advance(f.worldId, 400);
    const after = await snapshot(f.worldId);
    expect(after.state.diplomacies[0]).toMatchObject({
      state: 'DECLARED',
      untilTick: key === 'nation_rivalry' ? 10400 : 400,
    });
    expect(after.state.nationStrategy!.nations[1]!.commands[key]).toBe(126);
    expect(after.state.stratagemCards!.nations[1]!.hand).toEqual([]);
    const history = await db.nationHistory.findMany({
      where: { worldId: f.worldId, tick: 400 },
      orderBy: { nationId: 'asc' },
    });
    expect(history.map((row) => row.nationId)).toEqual([1, 2]);
    for (const row of history)
      expect(row.data).toMatchObject({
        events: [expect.stringContaining(key === 'nation_rivalry' ? '이호경식' : '급습')],
      });
    await expectReplay(f.worldId);
  },
);

it('잘못된 전략 저장값은 적재·HTTP·내보내기에서 거부하고 NULL 관계는 DB 제약이 지킨다', async () => {
  const f = await fixture();
  const row = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
  await expect(
    db.$executeRaw`UPDATE "World" SET "nationStrategyState" = NULL WHERE id = ${f.worldId}`,
  ).rejects.toThrow();
  await db.world.update({
    where: { id: f.worldId },
    data: { nationStrategyState: { version: 1, nations: { '1': { strategicUntil: -1, commands: {} } } } },
  });
  try {
    await expect(snapshot(f.worldId)).rejects.toThrow();
    await expect(exportReplay(db, f.worldId)).rejects.toThrow();
    expect(
      (
        await rpc(
          'nationCommands.precheck',
          { worldId: f.worldId, commandKey: 'nation_mobilize', args: { cityKey: 1 } },
          f.staff,
        )
      ).status,
    ).toBe(500);
  } finally {
    await db.world.update({ where: { id: f.worldId }, data: { nationStrategyState: row.nationStrategyState! } });
  }
});
