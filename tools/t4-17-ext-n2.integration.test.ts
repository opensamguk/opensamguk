import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  TICKS_PER_MONTH,
  type CommandResult,
  type Failure,
  type WorldInit,
  type WorldState,
  type WorldPreset,
} from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive, type ReplayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { testDatabaseUrl } from './test-database';

// 이 파일은 실행 할당 뒤에만 통합 설정으로 실행한다. 기본 단위 설정은 수집하지 않는다.
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
const ownName = `t417_n2_${randomUUID().replaceAll('-', '')}_test`;
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
let created = false;
let ownOid: unknown;
const leases: NonNullable<Awaited<ReturnType<typeof acquireLease>>>[] = [];
const children = new Set<ChildProcess>();
const commandKeys = ['sabotage', 'incite', 'plunder'] as const;
type CommandKey = (typeof commandKeys)[number];
type CaseKey = 'success' | 'badTargetOwnCity' | 'probabilityMiss';
type FixedCase = {
  initial: WorldInit;
  command: { commandKey: string; args: { cityKey: number }; explicit: true };
  expected: {
    result: CommandResult | Failure;
    afterRuleTurnState: WorldState;
    nationTransfer?: { sourceAfter: { gold: number; rice: number }; destinationAfter: { gold: number; rice: number } };
    trust?: { after: number };
  };
};
const fixed = JSON.parse(
  await readFile(new URL('../apps/engine/test/fixtures/ext-n2-179bea4.json', import.meta.url), 'utf8'),
) as {
  preset: WorldPreset;
  commands: Record<CommandKey, { cases: Record<CaseKey, FixedCase> }>;
};

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${ownName}"`);
  created = true;
  ownOid = (await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [ownName])).rows[0]?.oid;
  expect(ownOid).toBeDefined();
  await client.connect();
  const directory = new URL('../packages/db/prisma/migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d/.test(name)).sort();
  // 18개 조약 migration까지의 접두부를 보존하고 현재 소스의 후속 SQL도 모두 적용한다.
  expect(migrations).toEqual([
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
    '20261023074000_assignment_storage',
    '20261024000000_replay_features',
    '20261024000000_world_personnel_format',
    '20261025000000_input_event_step_tick',
    '20261026000000_game_resource',
    '20261027000000_treaty_break_trust',
    '20261028000000_assignment_nation_destroyed',
    '20261029000000_general_residence_tick',
    '20261030000000_five_stats',
    '20261031000000_operational_map',
    '20261101000000_campaign_state',
    '20261102000000_account_tokens',
    '20261103000000_admin_role_audit',
    '20261104000000_account_world_sanctions',
    '20261105000000_admin_notices',
  ]);
  expect(migrations.slice(0, 18).at(-1)).toBe('20261023073000_treaties');
  for (const name of migrations)
    await client.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
  app = await buildServer({ db, now: () => now, logging: false, publicOrigin: origin });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
afterAll(async () => {
  try {
    for (const child of children) await kill(child);
    await app?.close();
    if (created) for (const lease of leases) await releaseLease(db, lease);
  } finally {
    try {
      await Promise.all([db.$disconnect(), client.end()]);
      if (created) {
        expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [ownName])).rows).toEqual([
          { oid: ownOid },
        ]);
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
    data: { email: `t417-${randomUUID()}@example.invalid`, passwordHash: 'unused-fixture', status },
  });
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: row.id, expiresAt: session.expiresAt } });
  return { id: row.id, cookie: `sid=${session.token}` };
}
async function fixture(commandKey: CommandKey, key: CaseKey = 'success') {
  const value = fixed.commands[commandKey].cases[key];
  const alice = await user(),
    bob = await user();
  const initial = structuredClone(value.initial);
  for (const general of initial.generals) {
    if (general.userId === 'n2-fixture-actor') general.userId = alice.id;
    if (general.userId === 'n2-fixture-defender') general.userId = bob.id;
  }
  const { worldId } = await saveInitialWorld(db, initial, {
    name: `${commandKey} 통합 시험`,
    turnTermMinutes: 60,
    endYear: null,
    extFormat: 1,
    preset: { key: 't417-fixed-n2', value: fixed.preset },
  });
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  return { worldId, alice, bob, initial, value, commandKey };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
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
      result?: { data: unknown };
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
function slots(value: FixedCase) {
  const { commandKey, args } = value.command;
  return [{ commandKey, args }, ...Array<null>(29).fill(null)];
}
async function save(f: Fixture, expectedSequence = 1) {
  const result = await rpc(
    'turns.set',
    { worldId: f.worldId, revision: 0, slots: slots(f.value) },
    f.alice.cookie,
    true,
  );
  expect(result).toMatchObject({ status: 200, data: { ok: true, revision: 1 } });
  expect(await db.inputEvent.findFirstOrThrow({ where: { worldId: f.worldId, generalId: 1 } })).toMatchObject({
    userId: f.alice.id,
    generalId: 1,
    kind: 'turns.set',
    status: 'APPLIED',
    sequence: expectedSequence,
  });
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
    state: await db.$transaction((tx) => loadReplayState(tx, worldId)),
    slots: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    events: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    logs: await db.generalLog.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    reports: await db.battleLog.findMany({ where: { worldId }, orderBy: { generalId: 'asc' } }),
    history: await db.nationHistory.findMany({ where: { worldId }, orderBy: [{ tick: 'asc' }, { nationId: 'asc' }] }),
    months: await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } }),
    slices: await db.worldExtSlice.findMany({ where: { worldId }, orderBy: { key: 'asc' } }),
  };
}
async function assertFixedTurn(f: Fixture) {
  const state = await db.$transaction((tx) => loadWorld(tx, f.worldId));
  const expected = structuredClone(f.value.expected.afterRuleTurnState);
  for (const general of Object.values(expected.generals)) {
    if (general.id === 1) general.nextTurnTick += TICKS_PER_MONTH;
    if (general.userId === 'n2-fixture-actor') general.userId = f.alice.id;
    if (general.userId === 'n2-fixture-defender') general.userId = f.bob.id;
  }
  expect(state).toMatchObject(expected);
  expect(Object.hasOwn(state, 'ext')).toBe(false);
  expect(await db.worldExtSlice.count({ where: { worldId: f.worldId } })).toBe(0);
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).toMatchObject({
    turnRevision: 2,
    nextTurnTick: 100 + TICKS_PER_MONTH,
  });
  const queue = await db.generalTurn.findMany({
    where: { worldId: f.worldId, generalId: 1 },
    orderBy: { slot: 'asc' },
  });
  expect(queue).toHaveLength(30);
  expect(queue.every((turn, slot) => turn.slot === slot && turn.commandKey === 'rest' && !turn.explicit)).toBe(true);
  const result = f.value.expected.result;
  const failed = 'code' in result;
  expect(
    await db.generalLog.findMany({
      where: { worldId: f.worldId },
      select: { generalId: true, tick: true, commandKey: true, kind: true, text: true },
    }),
  ).toEqual([
    {
      generalId: 1,
      tick: 100,
      commandKey: f.commandKey,
      kind: failed ? 'failure' : 'success',
      text: failed ? `${result.code}: ${result.message}` : result.logs.map((log) => log.text).join('\n'),
    },
  ]);
  expect(await db.battleLog.findMany({ where: { worldId: f.worldId }, orderBy: { generalId: 'asc' } })).toEqual(
    (failed ? [] : (result.reports ?? [])).map((report) => ({
      worldId: f.worldId,
      tick: 100,
      attackerId: 1,
      ...report,
    })),
  );
  const recorded = (await rpc('records.general', { worldId: f.worldId }, f.alice.cookie)).data as {
    items: unknown[];
    nextCursor: string | null;
  };
  expect(recorded).toMatchObject({
    items: [
      {
        tick: 100,
        commandKey: f.commandKey,
        kind: failed ? 'failure' : 'success',
        text: failed ? `${result.code}: ${result.message}` : result.logs.map((log) => log.text).join('\n'),
      },
    ],
    nextCursor: null,
  });
  expect(recorded.items).toHaveLength(1);
  if (f.value.expected.nationTransfer) {
    const transfer = f.value.expected.nationTransfer;
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 2 } } })).toMatchObject({
      gold: transfer.sourceAfter.gold,
      rice: transfer.sourceAfter.rice,
    });
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).toMatchObject({
      gold: transfer.destinationAfter.gold,
      rice: transfer.destinationAfter.rice,
    });
  }
  if (f.value.expected.trust)
    expect(
      await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } }),
    ).toMatchObject({ trust: f.value.expected.trust.after });
  const history = await db.nationHistory.findMany({ where: { worldId: f.worldId } });
  const events = failed ? [] : (result.history ?? []);
  expect(history).toHaveLength(events.length);
  for (const event of events)
    expect(history).toContainEqual({
      worldId: f.worldId,
      tick: 100,
      nationId: event.nationId,
      data: { events: [event.text] },
    });
}

async function worker(worldId: string, phase: 'saved' | 'beforeCommit' | 'committed') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/extTurnN2Worker.ts', worldId, phase], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, TEST_DATABASE_URL: ownUrl.href },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('시험 프로세스가 지정 단계에 도달하지 못했습니다.')), 30_000);
    const onMessage = (value: unknown) =>
      finish(value === phase ? undefined : new Error('시험 프로세스가 실패했습니다.'));
    const onExit = () => finish(new Error('시험 프로세스가 준비 전에 종료됐습니다.'));
    function finish(error?: Error) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    child.once('message', onMessage);
    child.once('exit', onExit);
    child.once('error', finish);
  });
  await kill(child);
  await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "worldId" = ${worldId}`;
}

for (const commandKey of commandKeys) {
  for (const key of ['success', 'badTargetOwnCity', 'probabilityMiss'] as const)
    it(`N2 ${commandKey} ${key}: 실제 HTTP 예턴과 턴 저장을 고정된 규칙 결과에 대조한다`, async () => {
      const f = await fixture(commandKey, key);
      await save(f);
      const loop = await loopFor(f.worldId);
      expect(await loop.advanceTo(100)).toEqual([{ generalId: 1, tick: 100, commandKey }]);
      await assertFixedTurn(f);
    });

  it(`N2 ${commandKey} HTTP 권한·인자·revision을 검사한다`, async () => {
    const f = await fixture(commandKey);
    const sanctioned = await user('SANCTIONED');
    const input = { worldId: f.worldId, revision: 0, slots: slots(f.value) };
    const before = await snapshot(f.worldId);
    for (const cookie of [undefined, sanctioned.cookie])
      expect((await rpc('turns.set', input, cookie, true)).error).toBe('UNAUTHORIZED');
    expect(
      (
        await rpc(
          'turns.set',
          { ...input, slots: [{ commandKey, args: { cityKey: 0 } }, ...Array<null>(29).fill(null)] },
          f.alice.cookie,
          true,
        )
      ).error,
    ).toBe('BAD_REQUEST');
    expect((await rpc('turns.set', { ...input, generalId: 2 }, f.alice.cookie, true)).error).toBe('BAD_REQUEST');
    expect(await snapshot(f.worldId)).toEqual(before);
    expect((await rpc('turns.set', input, f.bob.cookie, true)).data).toMatchObject({ ok: true });
    expect(await db.inputEvent.findFirstOrThrow({ where: { worldId: f.worldId } })).toMatchObject({
      userId: f.bob.id,
      generalId: 2,
    });
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).toMatchObject({
      turnRevision: 0,
    });
    await save(f, 2);
    expect((await rpc('turns.set', input, f.alice.cookie, true)).data).toMatchObject({
      ok: false,
      reason: 'STALE',
      revision: 1,
    });
    const list = (await rpc('commands.list', { worldId: f.worldId }, f.alice.cookie)).data as Array<{ key: string }>;
    for (const key of commandKeys) expect(list.some((command) => command.key === key)).toBe(true);
    expect(list.some((command) => command.key === 'fire_attack')).toBe(false);
    expect(
      (await rpc('turns.precheck', { worldId: f.worldId, commandKey, args: { cityKey: 1 } }, f.alice.cookie)).data,
    ).toMatchObject({ ok: false, code: 'BAD_TARGET' });
    expect(
      (await rpc('turns.precheck', { worldId: f.worldId, commandKey, args: { cityKey: 2 } }, f.alice.cookie)).data,
    ).toEqual({ ok: true });
    expect(
      (
        await rpc(
          'turns.edit',
          {
            worldId: f.worldId,
            revision: 1,
            op: { put: { from: 0, to: 0, commandKey, args: { cityKey: 2 } } },
          },
          f.alice.cookie,
          true,
        )
      ).data,
    ).toMatchObject({ ok: true, revision: 2 });
  });

  it(`N2 ${commandKey} 저장 직전 실패는 효과·기록·예턴을 함께 롤백한다`, async () => {
    const f = await fixture(commandKey);
    await save(f);
    const before = await snapshot(f.worldId);
    let reject = true;
    const loop = await loopFor(f.worldId, {
      beforeCommit: async () => {
        if (reject) throw new Error('t417 commit boundary');
      },
    });
    await expect(loop.advanceTo(100)).rejects.toThrow('t417 commit boundary');
    expect(await snapshot(f.worldId)).toEqual(before);
    reject = false;
    await loop.advanceTo(100);
    await assertFixedTurn(f);
  });

  for (const phase of ['saved', 'beforeCommit', 'committed'] as const)
    it(`N2 ${commandKey} SIGKILL ${phase} 뒤 새 엔진은 한 번만 저장한다`, async () => {
      const f = await fixture(commandKey);
      await save(f);
      const before = await snapshot(f.worldId);
      await worker(f.worldId, phase);
      if (phase !== 'committed') expect(await snapshot(f.worldId)).toEqual(before);
      const loop = await loopFor(f.worldId);
      expect(await loop.advanceTo(100)).toHaveLength(phase === 'committed' ? 0 : 1);
      await assertFixedTurn(f);
    });

  it(`N2 ${commandKey} 실제 12개월 재생과 같은 프로세스 OFF 골든을 대조한다`, async () => {
    const legacy = JSON.parse(
      await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
    ) as ReplayArchive;
    const off = await saveInitialWorld(db, legacy.origin.initial, {
      name: '기존 골든',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 'legacy',
    });
    await db.world.update({ where: { id: off.worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
    const offLoop = await loopFor(off.worldId);
    await offLoop.advanceTo(12 * TICKS_PER_MONTH);
    const offBefore = await exportReplay(db, off.worldId);
    expect(offBefore.version).toBe(2);
    expect(replayArchive(offBefore, 12).at(-1)?.stateHash).toBe(
      'd60ad5f09185a889fc64926efe4e367e1b909710b227e76e3005698e71d80a0b',
    );
    const f = await fixture(commandKey);
    await save(f);
    const loop = await loopFor(f.worldId);
    await loop.advanceTo(12 * TICKS_PER_MONTH);
    const archive = await exportReplay(db, f.worldId);
    expect(archive.version).toBe(6);
    expect(archive.months).toHaveLength(12);
    expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect(archive.months.at(-1)?.stateHash).toBe(
      hashState(await db.$transaction((tx) => loadReplayState(tx, f.worldId))),
    );
    const offAfter = await exportReplay(db, off.worldId);
    expect(offAfter).toEqual(offBefore);
    expect(JSON.stringify(offAfter)).toBe(JSON.stringify(offBefore));
    expect(await db.worldExtSlice.count({ where: { worldId: { in: [off.worldId, f.worldId] } } })).toBe(0);
  });
}
