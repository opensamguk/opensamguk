import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import {
  calculateTreatyFee,
  capsResourceHashInput,
  checkReplayOrigin,
  emptyQueue,
  parseCapsOrigin,
  parsePreset,
  selectWorldCapabilities,
  TICKS_PER_MONTH,
  type TreatyInput,
  type WorldInit,
} from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { readWorldState, saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, LeaseLostError, lockLease, releaseLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { processPendingInput } from '../apps/engine/src/inputs';
import { requestShutdown, stopOwnedChild } from '../apps/engine/src/process-lifecycle';
import { runSupervisor } from '../apps/engine/src/supervisor';
import { exportReplay, replayArchive, type ReplayArchive } from '../apps/engine/src/replay';
import { replayCapsArchive, replayCapsToEnd } from '../apps/engine/src/replayCaps';
import { readView } from '../apps/server/src/game/queries';
import { testDatabaseUrl } from './test-database';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg'));
const { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
if (!process.env.TEST_DATABASE_URL) throw new Error('전용 테스트 DB가 필요합니다.');
const sourceUrl = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const ownName = process.env.T403_CENTRAL_DB_NAME ?? `t403_caps_${randomUUID().replaceAll('-', '')}_test`;
if (!/^t403_caps_[a-f0-9]{32}_test$/.test(ownName)) throw new Error('시험 DB 이름을 확인하세요.');
const ownUrl = new URL(sourceUrl);
const adminUrl = new URL(sourceUrl);
ownUrl.pathname = `/${ownName}`;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href });
const client = new Client({ connectionString: ownUrl.href });
const db = createDb(ownUrl.href);
const root = fileURLToPath(new URL('../', import.meta.url));
const resourceKey = `t403_caps_${randomUUID().replaceAll('-', '')}`;
const resourceFiles = ['map', 'scenario'].map(
  (kind) => new URL(`../resources/${kind}/${resourceKey}.json`, import.meta.url),
);
const leases: Lease[] = [];
const loops = new Map<string, TurnLoop>();
const children = new Map<ChildProcess, Promise<unknown>>();
const createdResources: URL[] = [];
let created = false;
let ownOid: string | undefined;
let oldDatabases: Record<string, unknown>[] = [];
let migrationNames: string[] = [];
const evidence: Record<string, unknown> = { ownName, executed: false, migrations: [], children: [] };
const clauses = [{ kind: 'peace' as const }, { kind: 'nonAggression' as const, months: 1 }];

async function databases() {
  return (
    await admin.query('SELECT datname, oid::text AS oid FROM pg_database WHERE datname <> $1 ORDER BY datname', [
      ownName,
    ])
  ).rows;
}

beforeAll(async () => {
  await admin.connect();
  oldDatabases = await databases();
  evidence.oldDatabases = oldDatabases;
  await admin.query(`CREATE DATABASE "${ownName}"`);
  created = true;
  const ownRows = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [ownName])).rows;
  expect(ownRows).toHaveLength(1);
  ownOid = ownRows[0]!.oid as string;
  evidence.createdOid = ownOid;
  await client.connect();
  const directory = new URL('../packages/db/prisma/migrations/', import.meta.url);
  migrationNames = (await readdir(directory)).filter((name) => /^\d/.test(name)).sort();
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
  expect(migrationNames.slice(0, requiredMigrationNames.length)).toEqual(requiredMigrationNames);
  for (const name of migrationNames)
    await client.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
  evidence.migrations = migrationNames;
  // 실제 CLI가 읽는 시험 소유 자원이다. 기존 자원은 바꾸지 않는다.
  const values = { population: 1000, agriculture: 100, commerce: 100, security: 100, defence: 50, wall: 50 };
  const map = {
    id: resourceKey,
    name: '중앙 PG 시험 지도',
    defaults: { trust: 80, supplyState: 1 },
    cities: [1, 2].map((id) => ({
      id,
      name: `시험도시${id}`,
      level: 1,
      region: 1,
      position: { x: id, y: 1 },
      connections: [],
      initial: values,
      max: {
        ...values,
        population: 10000,
        agriculture: 1000,
        commerce: 1000,
        security: 1000,
        defence: 1000,
        wall: 1000,
      },
    })),
  };
  const scenario = {
    id: resourceKey,
    title: '중앙 PG 시험',
    startYear: 191,
    nation: [1, 2].map((id) => [
      `시험국가${id}`,
      id === 1 ? '#ff0000' : '#0000ff',
      100000,
      100000,
      '',
      0,
      '',
      0,
      [`시험도시${id}`],
    ]),
    general: [1, 2].map((id) => [0, `시험장수${id}`, '', id, `시험도시${id}`, 70, 70, 60, 12, 160, 230, null, null]),
    diplomacy: [],
  };
  for (const [i, value] of [map, scenario].entries()) {
    await writeFile(resourceFiles[i]!, JSON.stringify(value), { flag: 'wx' });
    createdResources.push(resourceFiles[i]!);
  }
  evidence.executed = true;
});

afterAll(async () => {
  try {
    for (const [child, exited] of children) {
      await stopOwnedChild(child, exited);
      children.delete(child);
    }
    if (created) for (const lease of leases) await releaseLease(db, lease);
  } finally {
    try {
      await db.$disconnect();
      await client.end();
      if (created) {
        expect(children.size).toBe(0);
        expect((evidence.children as Array<{ exited: boolean }>).every((child) => child.exited)).toBe(true);
        const beforeDrop = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [ownName]))
          .rows;
        evidence.oidBeforeDrop = beforeDrop;
        expect(ownOid).toBeDefined();
        expect(beforeDrop).toEqual([{ oid: ownOid }]);
        evidence.databasesBeforeDrop = await databases();
        expect(evidence.databasesBeforeDrop).toEqual(oldDatabases);
        const connections = (
          await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [ownName])
        ).rows;
        evidence.connectionsBeforeDrop = connections;
        expect(connections).toEqual([{ count: 0 }]);
        // 일반 DROP만 쓴다. 다른 연결 종료와 FORCE는 허용하지 않는다.
        await admin.query(`DROP DATABASE "${ownName}"`);
        evidence.absent = (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [ownName])).rows;
        expect(evidence.absent).toEqual([]);
        evidence.databasesAfter = await databases();
        expect(evidence.databasesAfter).toEqual(oldDatabases);
      }
    } finally {
      try {
        for (const resource of createdResources) await unlink(resource);
        evidence.resourcesRemoved = true;
      } finally {
        try {
          await admin.end();
        } finally {
          if (process.env.T403_CENTRAL_EVIDENCE)
            await writeFile(process.env.T403_CENTRAL_EVIDENCE, JSON.stringify(evidence, null, 2));
        }
      }
    }
  }
});

async function user() {
  return db.user.create({ data: { email: `t403-${randomUUID()}@example.invalid`, passwordHash: 'test-only' } });
}
type FixtureOptions = {
  format?: 'legacy' | 'f0' | 'positive';
  human?: boolean;
  npcTarget?: boolean;
  gold?: number;
  targetGold?: number;
  separated?: boolean;
  status?: 'PREOPEN' | 'PAUSED' | 'RUNNING';
  treaty?: boolean;
  end?: boolean;
  initial?: WorldInit;
};
async function fixture(options: FixtureOptions = {}) {
  const users = await Promise.all([user(), user()]);
  const initial = options.initial ?? (await monthlyFixture());
  if (options.separated) initial.cities = initial.cities.map((city) => ({ ...city, connections: [] }));
  initial.generals = initial.generals.slice(0, 2).map((general, i) => ({
    ...general,
    userId: options.human === false || (options.npcTarget && i === 1) ? null : users[i]!.id,
    officerLevel: 12,
    activeFromYear: initial.startYear,
    nextTurnTick: options.initial ? general.nextTurnTick : 1000 + i,
  }));
  initial.nations = initial.nations.map((nation, i) => ({
    ...nation,
    gold: (i === 1 ? options.targetGold : undefined) ?? options.gold ?? 1000,
    isNpc: !!options.npcTarget && i === 1,
  }));
  const format = options.format ?? 'legacy';
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '중앙 조약 시험',
    turnTermMinutes: 60,
    endYear: options.end ? initial.startYear : null,
    ...(format === 'f0' ? {} : { replayFormat: 'legacy' as const }),
    ...(options.treaty === false ? {} : { treatyFormat: 1 as const }),
  });
  await db.world.update({
    where: { id: worldId },
    data: { status: options.status ?? 'RUNNING', clockAnchorAt: new Date() },
  });
  const f = { worldId, users, initial };
  if (format === 'positive') {
    await db.world.update({ where: { id: worldId }, data: { clockTick: 600 } });
    await marker(f);
    await (await loopFor(worldId)).advanceTo(600);
  }
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function loopFor(worldId: string, hooks?: ConstructorParameters<typeof TurnLoop>[2]) {
  if (!hooks && loops.has(worldId)) return loops.get(worldId)!;
  const existing = leases.find((lease) => lease.worldId === worldId);
  const lease = existing ?? (await acquireLease(db, worldId));
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  if (!existing) leases.push(lease);
  const loop = new TurnLoop(db, lease, hooks);
  if (!hooks) loops.set(worldId, loop);
  return loop;
}
async function marker(f: Fixture) {
  const generals = await db.general.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  await db.generalTurn.createMany({
    data: generals.flatMap((general) =>
      emptyQueue().map((turn, slot) => ({ ...turn, args: {}, worldId: f.worldId, generalId: general.id, slot })),
    ),
  });
  return db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: 'system:policy',
      kind: 'system.policy.enable',
      idempotencyKey: 'system.policy.enable:5',
      payload: { version: 5, emptySlots: generals.map((general) => general.id) },
    },
  });
}
async function enqueue(f: Fixture, input: TreatyInput, actor = 0) {
  return db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: f.users[actor]!.id,
      generalId: actor + 1,
      kind: input.kind,
      idempotencyKey: `${input.kind}:${randomUUID()}`,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}
async function drain(f: Fixture) {
  const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
  await (await loopFor(f.worldId)).advanceTo(world.clockTick);
}
async function propose(
  f: Fixture,
  list: Extract<TreatyInput, { kind: 'treaty.propose' }>['payload']['clauses'] = clauses,
) {
  const event = await enqueue(f, { kind: 'treaty.propose', payload: { toNationId: 2, clauses: list } });
  await drain(f);
  return db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
}
async function respond(f: Fixture, treatyId: string, accept = true) {
  const event = await enqueue(f, { kind: 'treaty.respond', payload: { treatyId, accept } }, 1);
  await drain(f);
  return db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
}
async function stateHash(worldId: string) {
  return hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)));
}
async function snapshot(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    nations: await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    cities: await db.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    nationTurns: await db.nationTurn.findMany({ where: { worldId }, orderBy: [{ nationId: 'asc' }, { slot: 'asc' }] }),
    diplomacies: await db.diplomacy.findMany({ where: { worldId }, orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }] }),
    treaties: await db.treaty.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    events: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    months: await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } }),
    logs: await db.generalLog.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { tick: 'asc' }] }),
    end: await db.worldResult.findUnique({ where: { worldId } }),
  };
}
// 아래 직접 SQL/metadata 변경은 이름에 손상 목적을 적은 거부 시험에서만 쓴다.
async function corruptTreaty(worldId: string) {
  await db.treaty.create({
    data: {
      worldId,
      id: 999,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'note', text: '손상 fixture' }],
      status: 'PROPOSED',
      proposedTick: 0,
      respondByTick: 6 * TICKS_PER_MONTH,
    },
  });
}
function childEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: ownUrl.href };
  delete env.TEST_DATABASE_URL;
  return env;
}
function trackChild(child: ChildProcess, kind: 'cli' | 'engine', worldId?: string) {
  const record = {
    pid: child.pid,
    kind,
    worldId,
    exited: false,
    code: null as number | null,
    signal: null as string | null,
  };
  (evidence.children as unknown[]).push(record);
  const exited = once(child, 'exit').then((values) => {
    record.exited = true;
    record.code = values[0] as number | null;
    record.signal = values[1] as string | null;
    return values;
  });
  children.set(child, exited);
  return exited;
}
async function cliWorld(treaty: boolean) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/engine/src/cli/createWorld.ts',
      '--scenario',
      resourceKey,
      '--map',
      resourceKey,
      '--seed',
      'central-cli',
      '--turn-term',
      '60',
      '--end-year',
      '191',
      '--name',
      '중앙 CLI',
      ...(treaty ? ['--treaty'] : []),
    ],
    {
      cwd: root,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = trackChild(child, 'cli');
  const output: Buffer[] = [];
  child.stdout!.on('data', (data: Buffer) => output.push(data));
  child.stderr!.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code] = await exited;
    expect(code).toBe(0);
    const value = JSON.parse(Buffer.concat(output).toString('utf8')) as { worldId: string; stateHash: string };
    expect(Object.keys(value).sort()).toEqual(['stateHash', 'worldId']);
    return value;
  } finally {
    clearTimeout(timer);
    children.delete(child);
  }
}
function spawnEngine(worldId: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/src/index.ts', '--world', worldId], {
    cwd: root,
    env: childEnv(),
    windowsHide: true,
    stdio: process.platform === 'win32' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  trackChild(child, 'engine', worldId);
  child.stdout!.resume();
  child.stderr!.resume();
  return child;
}
async function stopEngine(child: ChildProcess) {
  const exited = children.get(child)!;
  requestShutdown(child, 'SIGTERM');
  await stopOwnedChild(child, exited);
  const [code] = (await exited) as [number | null];
  expect(code).toBe(0);
  children.delete(child);
}

it('P1 실제 CLI와 factory는 origin6·형식1·초기 행을 함께 만들고 후속 행 실패를 롤백한다', async () => {
  const cli = await cliWorld(true);
  const worldIds = [cli.worldId];
  for (const format of ['legacy', 'f0', 'positive'] as const) worldIds.push((await fixture({ format })).worldId);
  for (const worldId of worldIds) {
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(world.treatyFormat).toBe(1);
    const origin = parseCapsOrigin(world.replayOrigin);
    expect(origin.version).toBe(6);
    expect(origin.capabilities).toEqual({ version: 1, treaty: { version: 1 } });
    expect(Object.hasOwn(origin.initial, 'treaties')).toBe(false);
    expect(origin.initialStateHash).toBe(hashState(origin.initial));
    expect(world.initialStateHash).toBe(origin.initialStateHash);
    expect(origin.resourceHash).toBe(hashState(capsResourceHashInput(origin)));
    expect(selectWorldCapabilities(world).kind).toBe('caps');
    expect(await db.treaty.count({ where: { worldId } })).toBe(0);
  }
  const initial = await monthlyFixture();
  initial.generals[0]!.userId = `missing-${randomUUID()}`;
  const count = await db.world.count();
  await expect(
    saveInitialWorld(db, initial, { name: '외래키 롤백', turnTermMinutes: 60, endYear: null, treatyFormat: 1 }),
  ).rejects.toThrow();
  expect(await db.world.count()).toBe(count);
});

it('P2 non-null commands preset은 생성 전에 거부하고 World 행을 남기지 않는다', async () => {
  const preset = parsePreset(
    JSON.parse(await readFile(new URL('../resources/preset/regular.json', import.meta.url), 'utf8')),
  );
  const count = await db.world.count();
  await expect(
    saveInitialWorld(db, await monthlyFixture(), {
      name: '명령 거부',
      turnTermMinutes: 60,
      endYear: null,
      treatyFormat: 1,
      preset: { key: 'blocked', value: { ...preset, commands: { general: ['fire_attack'], nation: [] } } },
    }),
  ).rejects.toThrow('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
  expect(await db.world.count()).toBe(count);
});

it('P3 기능 없는 새 CLI는 origin3과 빈 기능 목록, 조약 꺼짐을 기록한다', async () => {
  const result = await cliWorld(false);
  const world = await db.world.findUniqueOrThrow({ where: { id: result.worldId } });
  const origin = world.replayOrigin;
  checkReplayOrigin(origin);
  expect(origin).toMatchObject({ version: 3, initialStateHash: result.stateHash });
  expect(world.replayFormat).toBe(3);
  expect(world.ruleFeatures).toEqual([]);
  expect(world.policyFromSequence).toBeNull();
  expect(world.treatyFormat).toBeNull();
  expect(await db.treaty.count({ where: { worldId: world.id } })).toBe(0);
  expect(world.initialStateHash).toBe(result.stateHash);
  expect(hashState(origin.initial)).toBe(result.stateHash);
  expect(hashState(await readWorldState(db, world.id))).toBe(result.stateHash);
  expect(origin.resourceHash).toBe(
    hashState({
      scenarioKey: origin.initial.scenarioKey,
      mapKey: origin.initial.mapKey,
      unitSetKey: origin.initial.unitSetKey,
      statRules: origin.initial.statRules,
      unitSet: origin.initial.unitSet,
    }),
  );
});

it('P3 명시 방침 factory는 origin1과 방침 표지 0, 조약 꺼짐을 보존한다', async () => {
  const initial = await monthlyFixture();
  const result = await saveInitialWorld(db, initial, {
    name: '명시 방침 형식',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'policy',
  });
  const world = await db.world.findUniqueOrThrow({ where: { id: result.worldId } });
  const origin = world.replayOrigin;
  checkReplayOrigin(origin);
  expect(origin).toMatchObject({ version: 1, initialStateHash: result.stateHash });
  expect(world.replayFormat).toBe(1);
  expect(world.ruleFeatures).toEqual([]);
  expect(world.policyFromSequence).toBe(0);
  expect(world.treatyFormat).toBeNull();
  expect(await db.treaty.count({ where: { worldId: world.id } })).toBe(0);
  expect(world.initialStateHash).toBe(result.stateHash);
  expect(result.stateHash).toBe(hashState(initial));
  expect(hashState(origin.initial)).toBe(result.stateHash);
  expect(selectWorldCapabilities(world).kind).toBe('legacy');
});

it('P4 사람 제안·수락은 비용을 한 번 내고 거절은 국고를 보존한다', async () => {
  for (const accept of [true, false]) {
    const f = await fixture();
    const proposed = await propose(f);
    expect(proposed).toMatchObject({ status: 'APPLIED', sequence: 1, result: { outcome: 'PROPOSED', treatyId: '1' } });
    const before = await db.nation.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
    expect(before.map((nation) => nation.gold)).toEqual([1000, 1000]);
    const result = await respond(f, '1', accept);
    expect(result).toMatchObject({
      status: 'APPLIED',
      sequence: 2,
      result: { outcome: accept ? 'ACCEPTED' : 'DECLINED', by: 'HUMAN' },
    });
    const row = await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
    const costs = before.map((nation) =>
      calculateTreatyFee(f.initial.cities.filter((city) => city.nationId === nation.id).length, 1),
    );
    expect(row.status).toBe(accept ? 'ACTIVE' : 'REJECTED');
    expect([row.costFrom, row.costTo]).toEqual(accept ? costs : [null, null]);
    expect(row.closedSequence).toBe(accept ? null : 2);
    expect(
      (await db.nation.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } })).map(
        (nation) => nation.gold,
      ),
    ).toEqual(before.map((nation, i) => nation.gold - (accept ? costs[i]! : 0)));
  }
});

it('P5 NPC 수락·거절은 제안 이벤트 하나 안에서 끝난다', async () => {
  for (const insufficient of [false, true]) {
    const f = await fixture({ npcTarget: true, targetGold: insufficient ? 0 : 1000 });
    const result = await propose(f);
    expect(result).toMatchObject({
      status: 'APPLIED',
      sequence: 1,
      result: { outcome: insufficient ? 'DECLINED' : 'ACCEPTED', by: 'NPC' },
    });
    expect(await db.inputEvent.count({ where: { worldId: f.worldId } })).toBe(1);
    expect((await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).status).toBe(
      insufficient ? 'REJECTED' : 'ACTIVE',
    );
    expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence).toBe(1);
  }
});

it('P6 사람 수락의 금 부족은 REJECTED이며 양쪽 국고가 그대로다', async () => {
  const f = await fixture({ gold: 0 });
  await propose(f);
  const before = await db.nation.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  expect(await respond(f, '1')).toMatchObject({
    status: 'REJECTED',
    sequence: 2,
    result: { code: 'INSUFFICIENT_GOLD' },
  });
  expect(await db.nation.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } })).toEqual(before);
  expect((await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).status).toBe(
    'PROPOSED',
  );
});

it('P7 손상된 열린 조약은 대기 입력과 턴보다 먼저 거부한다', async () => {
  const f = await fixture();
  await propose(f);
  await db.treaty.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { costFrom: 1 } });
  await enqueue(f, { kind: 'treaty.respond', payload: { treatyId: '1', accept: true } }, 1);
  const before = await snapshot(f.worldId);
  await expect((await loopFor(f.worldId)).advanceTo(TICKS_PER_MONTH)).rejects.toThrow();
  expect(await snapshot(f.worldId)).toEqual(before);
});

it('P8 off 월드의 손상 조약 행은 PREOPEN·PAUSED·ENDED에서도 행동 전에 막는다', async () => {
  for (const status of ['PREOPEN', 'PAUSED', 'ENDED'] as const) {
    const f = await fixture({ treaty: false });
    await db.world.update({ where: { id: f.worldId }, data: { status } });
    await corruptTreaty(f.worldId);
    const before = await snapshot(f.worldId);
    await expect((await loopFor(f.worldId)).advanceTo(TICKS_PER_MONTH)).rejects.toThrow(
      '조약을 끈 월드에 조약 저장 행이 있습니다.',
    );
    expect(await snapshot(f.worldId)).toEqual(before);
  }
});

it('P9 명시적으로 손상시킨 format·origin 불일치는 쓰기 전에 거부한다', async () => {
  for (const damage of ['null-format', 'origin1'] as const) {
    const f = await fixture();
    const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
    const origin = parseCapsOrigin(world.replayOrigin);
    await db.world.update({
      where: { id: f.worldId },
      data:
        damage === 'null-format'
          ? { treatyFormat: null }
          : {
              replayOrigin: {
                version: 1,
                initial: origin.initial,
                initialStateHash: origin.initialStateHash,
                resourceHash: origin.resourceHash,
              } as unknown as Prisma.InputJsonValue,
            },
    });
    const before = await snapshot(f.worldId);
    await expect((await loopFor(f.worldId)).advanceTo(TICKS_PER_MONTH)).rejects.toThrow();
    expect(await snapshot(f.worldId)).toEqual(before);
  }
});

it('P10 최소 id의 모르는 kind는 뒤 조약·턴·월간을 가리고 쓰기를 남기지 않는다', async () => {
  const f = await fixture();
  const first = await db.inputEvent.create({
    data: { worldId: f.worldId, userId: f.users[0]!.id, kind: 'unknown', idempotencyKey: 'unknown:first', payload: {} },
  });
  const next = await enqueue(f, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  expect(first.id < next.id).toBe(true);
  const before = await snapshot(f.worldId);
  await expect((await loopFor(f.worldId)).advanceTo(TICKS_PER_MONTH)).rejects.toThrow(
    '처리할 수 없는 대기 입력입니다.',
  );
  expect(await snapshot(f.worldId)).toEqual(before);
});

it('P11 off 월드의 두 조약 kind는 sequence 배정 전에 거부한다', async () => {
  for (const input of [
    { kind: 'treaty.propose' as const, payload: { toNationId: 2, clauses } },
    { kind: 'treaty.respond' as const, payload: { treatyId: '1', accept: true } },
  ]) {
    const f = await fixture({ treaty: false });
    await enqueue(f, input);
    const before = await snapshot(f.worldId);
    await expect(drain(f)).rejects.toThrow('조약을 끈 월드의 조약 입력입니다.');
    expect(await snapshot(f.worldId)).toEqual(before);
  }
});

it('P12 null 표지 barrier는 뒤 입력을 건너뛰지 않으며 턴·월간도 쓰지 않는다', async () => {
  const preopen = await fixture({ status: 'PREOPEN' });
  await marker(preopen);
  await enqueue(preopen, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  const before = await snapshot(preopen.worldId);
  await (await loopFor(preopen.worldId)).advanceTo(TICKS_PER_MONTH);
  expect(await snapshot(preopen.worldId)).toEqual(before);
  // PAUSED의 정상 loop는 기준 T를 준다. 이 변형은 직접 호출에서 그 인자가 없는 null 계약만 본다.
  const paused = await fixture({ status: 'PAUSED' });
  await marker(paused);
  await enqueue(paused, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  const pausedBefore = await snapshot(paused.worldId);
  const loop = await loopFor(paused.worldId);
  await db.$transaction(async (tx) => {
    await lockLease(tx, loop.lease);
    await tx.$queryRaw`SELECT id FROM "World" WHERE id=${paused.worldId} FOR UPDATE`;
    const world = await tx.world.findUniqueOrThrow({ where: { id: paused.worldId } });
    expect(await processPendingInput(tx, world, world.clockTick)).toBeNull();
  });
  expect(await snapshot(paused.worldId)).toEqual(pausedBefore);
});

it('P13 생성·표지·정책·조약 입력을 실제 최소 id 순서로 처리한다', async () => {
  const f = await fixture();
  const first = await db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: f.users[0]!.id,
      kind: 'general.create',
      idempotencyKey: 'create:duplicate',
      payload: {},
    },
  });
  // 기존 장수가 있는 생성 요청은 ALREADY_EXISTS로 끝나며 뒤 입력을 계속 처리한다.
  const second = await marker(f);
  const third = await db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: f.users[0]!.id,
      generalId: 1,
      kind: 'general.setPolicy',
      idempotencyKey: 'policy:farm',
      payload: { policy: 'farm' },
    },
  });
  const fourth = await enqueue(f, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  const committed: number[] = [];
  const loop = await loopFor(f.worldId, {
    beforeCommit: async (tx) => {
      committed.push((await tx.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence);
    },
  });
  await loop.advanceTo(0);
  const events = await db.inputEvent.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  expect(events.map((event) => event.id)).toEqual([first.id, second.id, third.id, fourth.id]);
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  expect(events.map((event) => event.status)).toEqual(['REJECTED', 'APPLIED', 'APPLIED', 'APPLIED']);
  expect(committed).toEqual([1, 2, 3, 4]);
});

it('P14 조약 이벤트마다 actionSequence는 정확히 한 번만 늘어난다', async () => {
  const f = await fixture();
  await propose(f);
  await respond(f, '1');
  await propose(f, [{ kind: 'note', text: '거절 확인' }]);
  await respond(f, '3', false);
  expect(
    (await db.inputEvent.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } })).map(
      (event) => event.sequence,
    ),
  ).toEqual([1, 2, 3, 4]);
  expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence).toBe(4);
  await drain(f);
  expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence).toBe(4);
});

it('P15 월간 EXPIRED·ENDED 저장은 월간 해시보다 앞서며 commit 뒤 해시도 같다', async () => {
  for (const accept of [false, true]) {
    const f = await fixture();
    await propose(f);
    if (accept) await respond(f, '1');
    const tick = (accept ? 1 : 6) * TICKS_PER_MONTH;
    let observed = false;
    const loop = await loopFor(f.worldId, {
      beforeCommit: async (tx) => {
        const month = await tx.yearbookSnapshot.findUnique({ where: { worldId_tick: { worldId: f.worldId, tick } } });
        if (!month) return;
        const row = await tx.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
        expect(row.status).toBe(accept ? 'ENDED' : 'EXPIRED');
        expect(row.closedSequence).toBe(month.sequence);
        expect(month.stateHash).toBe(hashState(await loadReplayState(tx, f.worldId)));
        observed = true;
      },
    });
    await loop.advanceTo(tick);
    expect(observed).toBe(true);
    const month = await db.yearbookSnapshot.findUniqueOrThrow({
      where: { worldId_tick: { worldId: f.worldId, tick } },
    });
    expect(month.stateHash).toBe(await stateHash(f.worldId));
    expect((await db.$transaction((tx) => loadWorld(tx, f.worldId))).treaties).toBeUndefined();
  }
});

it('P16 lease·World 잠금을 확인하고 beforeCommit 실패의 전체 쓰기를 롤백한 뒤 한 번 적용한다', async () => {
  const f = await fixture();
  await propose(f);
  const event = await enqueue(f, { kind: 'treaty.respond', payload: { treatyId: '1', accept: true } }, 1);
  const before = await snapshot(f.worldId);
  const probe = new Client({ connectionString: ownUrl.href });
  await probe.connect();
  let fail = true;
  const loop = await loopFor(f.worldId, {
    beforeCommit: async () => {
      if (!fail) return;
      fail = false;
      for (const [table, column] of [
        ['EngineLease', 'worldId'],
        ['World', 'id'],
      ]) {
        await probe.query('BEGIN');
        try {
          await expect(
            probe.query(`SELECT "${column}" FROM "${table}" WHERE "${column}"=$1 FOR UPDATE NOWAIT`, [f.worldId]),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await probe.query('ROLLBACK');
        }
      }
      throw new Error('central beforeCommit fault');
    },
  });
  try {
    await expect(loop.advanceTo(0)).rejects.toThrow('central beforeCommit fault');
    expect(await snapshot(f.worldId)).toEqual(before);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'PENDING',
      sequence: null,
      result: null,
    });
    await loop.advanceTo(0);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'APPLIED',
      sequence: 2,
    });
    expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence).toBe(2);
    expect((await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).status).toBe(
      'ACTIVE',
    );
  } finally {
    await probe.end();
  }
});

it('P17 첫 fence와 commit 직전 fence가 실패하면 게임 쓰기를 남기지 않는다', async () => {
  const first = await fixture();
  await enqueue(first, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  const stale = await loopFor(first.worldId);
  await releaseLease(db, stale.lease);
  const replacement = await acquireLease(db, first.worldId);
  if (!replacement) throw new Error('대체 실행권이 없습니다.');
  leases.push(replacement);
  const before = await snapshot(first.worldId);
  await expect(stale.advanceTo(0)).rejects.toBeInstanceOf(LeaseLostError);
  expect(await snapshot(first.worldId)).toEqual(before);
  const last = await fixture();
  await enqueue(last, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  const lastBefore = await snapshot(last.worldId);
  const loop = await loopFor(last.worldId, {
    beforeCommit: async (tx) => {
      await tx.engineLease.update({ where: { worldId: last.worldId }, data: { expiresAt: new Date(0) } });
    },
  });
  await expect(loop.advanceTo(0)).rejects.toBeInstanceOf(LeaseLostError);
  expect(await snapshot(last.worldId)).toEqual(lastBefore);
  expect(await db.engineLease.findUniqueOrThrow({ where: { worldId: last.worldId } })).toMatchObject({
    ownerId: loop.lease.ownerId,
    fencingToken: loop.lease.fencingToken,
  });
});

it('P18 새 엔진 프로세스가 이어 처리하고 새 TurnLoop에서도 해시가 같다', async () => {
  const f = await fixture({ status: 'PAUSED' });
  const initialHash = await stateHash(f.worldId);
  const closed = await enqueue(f, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  const first = spawnEngine(f.worldId);
  try {
    await expect
      .poll(async () => (await db.inputEvent.findUniqueOrThrow({ where: { id: closed.id } })).status, {
        timeout: 8000,
        interval: 25,
      })
      .toBe('REJECTED');
  } finally {
    await stopEngine(first);
  }
  expect(await stateHash(f.worldId)).toBe(initialHash);
  await db.world.update({ where: { id: f.worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date() } });
  const next = await enqueue(f, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  const second = spawnEngine(f.worldId);
  try {
    await expect
      .poll(async () => (await db.inputEvent.findUniqueOrThrow({ where: { id: next.id } })).status, {
        timeout: 8000,
        interval: 25,
      })
      .toBe('APPLIED');
    await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED' } });
  } finally {
    await stopEngine(second);
  }
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({
    sequence: 2,
    result: { outcome: 'PROPOSED' },
  });
  const savedHash = await stateHash(f.worldId);
  const lease = await acquireLease(db, f.worldId);
  if (!lease) throw new Error('재시작 실행권이 없습니다.');
  leases.push(lease);
  await new TurnLoop(db, lease).advanceTo((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).clockTick);
  expect(await stateHash(f.worldId)).toBe(savedHash);
  expect((await db.$transaction((tx) => loadWorld(tx, f.worldId))).treaties).toHaveLength(1);
});

it('P19 ENDED 조약은 WORLD_CLOSED이며 손상 payload는 롤백하고 supervisor가 발견한다', async () => {
  const fixtures = await Promise.all([fixture({ end: true }), fixture({ end: true })]);
  for (const f of fixtures) await (await loopFor(f.worldId)).advanceTo(12 * TICKS_PER_MONTH);
  const normal = fixtures[0]!;
  const broken = fixtures[1]!;
  const event = await enqueue(normal, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  await drain(normal);
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
    status: 'REJECTED',
    result: { code: 'WORLD_CLOSED' },
  });
  await db.inputEvent.create({
    data: {
      worldId: broken.worldId,
      userId: broken.users[0]!.id,
      generalId: 1,
      kind: 'treaty.propose',
      idempotencyKey: 'treaty.propose:broken',
      payload: { extra: true },
    },
  });
  const before = await snapshot(broken.worldId);
  await expect(drain(broken)).rejects.toThrow();
  expect(await snapshot(broken.worldId)).toEqual(before);
  // 실제 SQL discovery를 쓰고 실제 자식만 띄운다. 앞 시험의 자기 월드는 발견 대상에서 뺀다.
  await enqueue(normal, { kind: 'treaty.propose', payload: { toNationId: 2, clauses } });
  for (const f of fixtures) {
    const lease = leases.find((entry) => entry.worldId === f.worldId)!;
    await releaseLease(db, lease);
  }
  const controller = new AbortController();
  const discovered = new Set<string>();
  const ownIds = new Set(fixtures.map((f) => f.worldId));
  await db.world.updateMany({ where: { id: { notIn: [...ownIds] } }, data: { status: 'PREOPEN' } });
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await runSupervisor(db, {
      signal: controller.signal,
      spawnChild: (worldId) => spawnEngine(worldId),
      onEvent: (event) => {
        if (event.kind === 'started' && event.worldId && ownIds.has(event.worldId)) discovered.add(event.worldId);
        if (discovered.size === 2) controller.abort();
      },
    });
    expect(discovered).toEqual(ownIds);
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const [child, exited] of children) {
      await stopOwnedChild(child, exited);
      children.delete(child);
    }
  }
});

it('P20 세 runtime 적재의 treaties는 같고 WorldInit 읽기에는 키가 없다', async () => {
  const f = await fixture();
  for (const active of [false, true]) {
    if (!active) await propose(f);
    else await respond(f, '1');
    const world = await db.$transaction((tx) => loadWorld(tx, f.worldId));
    const replay = await db.$transaction((tx) => loadReplayState(tx, f.worldId));
    const view = await db.$transaction((tx) => readView(tx, f.worldId));
    expect(replay.state.treaties).toEqual(world.treaties);
    expect(view.treaties).toEqual(world.treaties);
    expect(Object.hasOwn(await readWorldState(db, f.worldId), 'treaties')).toBe(false);
  }
});

it('P21 W1~W4의 12개월 DB 해시·수출 바이트·종료 재생을 대조한다', async () => {
  const w1 = await fixture({ end: true });
  const cli = await cliWorld(true);
  await db.world.update({ where: { id: cli.worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date() } });
  const w3 = await fixture({ format: 'positive', end: true });
  const w4 = await fixture({ format: 'positive', human: false, end: true, separated: true });
  for (const f of [w1, w3]) {
    const event = await propose(f);
    await respond(f, String(event.sequence));
  }
  for (const [name, worldId] of [
    ['W1', w1.worldId],
    ['W2', cli.worldId],
    ['W3', w3.worldId],
    ['W4', w4.worldId],
  ]) {
    for (const lease of leases.filter((entry) => entry.worldId === worldId)) await releaseLease(db, lease);
    const lease = await acquireLease(db, worldId!);
    if (!lease) throw new Error('월간 대조 실행권이 없습니다.');
    leases.push(lease);
    await new TurnLoop(db, lease).advanceTo(12 * TICKS_PER_MONTH);
    const archive = await exportReplay(db, worldId!);
    expect(archive.version, name).toBe(6);
    if (archive.version !== 6) throw new Error('형식 6 수출이 아닙니다.');
    expect(archive.months, name).toHaveLength(12);
    expect(JSON.stringify(await exportReplay(db, worldId!)), name).toBe(JSON.stringify(archive));
    expect(replayCapsArchive(archive, 12), name).toEqual(
      archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
    );
    expect(replayCapsToEnd(archive), name).toEqual(archive.end);
    expect(archive.end?.finalStateHash, name).toBe(await stateHash(worldId!));
  }
});

it('P22 F 양수의 사람 기준 T와 NPC-only null은 marker와 재적재에 남는다', async () => {
  for (const human of [true, false]) {
    const f = await fixture({ format: 'positive', human });
    const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
    expect(world.policyFromSequence).toBe(1);
    const event = await db.inputEvent.findFirstOrThrow({ where: { worldId: f.worldId, kind: 'system.policy.enable' } });
    expect(event.result).toMatchObject({ fromSequence: 1, clockTick: 600, baselineActiveTick: human ? 600 : null });
    const replay = await db.$transaction((tx) => loadReplayState(tx, f.worldId));
    expect(replay.policy?.lastActiveTicks).toEqual(human ? { 1: 600, 2: 600 } : {});
    expect(
      (await db.general.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } })).map(
        (general) => general.lastActiveTick,
      ),
    ).toEqual(human ? [600, 600] : [null, null]);
  }
});

it('P23 실제 휴식·방침·정복 턴 앞뒤의 treaties는 깊이 같고 종료 해시도 같다', async () => {
  for (const modern of [false, true]) {
    const f = await fixture({ format: modern ? 'f0' : 'legacy' });
    await propose(f, [{ kind: 'note', text: '턴 불변 확인' }]);
    await respond(f, '1');
    if (modern) {
      await db.inputEvent.create({
        data: {
          worldId: f.worldId,
          userId: f.users[0]!.id,
          generalId: 1,
          kind: 'general.setPolicy',
          idempotencyKey: 'policy:farm',
          payload: { policy: 'farm' },
        },
      });
      await drain(f);
    }
    const before = (await db.$transaction((tx) => loadWorld(tx, f.worldId))).treaties;
    await (await loopFor(f.worldId)).advanceTo(1000);
    expect((await db.$transaction((tx) => loadWorld(tx, f.worldId))).treaties).toEqual(before);
    expect(await db.generalLog.count({ where: { worldId: f.worldId, generalId: 1, tick: 1000 } })).toBe(1);
    expect(
      await db.generalLog.findFirstOrThrow({ where: { worldId: f.worldId, generalId: 1, tick: 1000 } }),
    ).toMatchObject({ commandKey: modern ? 'farm' : 'rest' });
  }
  const initial = commandInitial();
  // 도시 2 점령이 통일 조건을 채우도록 P23 사본의 중립 도시를 생성 전에 배정한다.
  initial.cities[2]!.nationId = 1;
  initial.generals[1]!.crew = 0;
  initial.cities[1]!.wall = 0;
  initial.cities[1]!.defence = 0;
  const f = await fixture({ initial });
  await propose(f, [{ kind: 'note', text: '정복 종료 보존' }]);
  await respond(f, '1');
  const before = (await db.$transaction((tx) => loadWorld(tx, f.worldId))).treaties;
  await db.generalTurn.create({
    data: { worldId: f.worldId, generalId: 1, slot: 0, commandKey: 'attack', args: { cityKey: 2 }, explicit: true },
  });
  await (await loopFor(f.worldId)).advanceTo(100);
  expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).status).toBe('ENDED');
  expect((await db.$transaction((tx) => loadWorld(tx, f.worldId))).treaties).toEqual(before);
  expect((await db.worldResult.findUniqueOrThrow({ where: { worldId: f.worldId } })).finalStateHash).toBe(
    await stateHash(f.worldId),
  );
});

it('P24 기존 origin1의 12개월 골든과 archive2 바이트를 보존한다', async () => {
  const original = JSON.parse(
    await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
  ) as ReplayArchive;
  const { worldId } = await saveInitialWorld(db, original.origin.initial, {
    name: '기존 골든',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'legacy',
  });
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date() } });
  await (await loopFor(worldId)).advanceTo(12 * TICKS_PER_MONTH);
  const archive = await exportReplay(db, worldId);
  expect(archive.version).toBe(2);
  expect(replayArchive(archive, 12).at(-1)?.stateHash).toBe(
    'd60ad5f09185a889fc64926efe4e367e1b909710b227e76e3005698e71d80a0b',
  );
  await readWorldState(db, worldId);
  await db.$transaction((tx) => readView(tx, worldId));
  expect(JSON.stringify(await exportReplay(db, worldId))).toBe(JSON.stringify(archive));
});

it('P25 origin null인 옛 월드는 세 상태에서 돌고 수출을 거부하며 잔여 조약은 막는다', async () => {
  for (const status of ['PREOPEN', 'RUNNING', 'ENDED'] as const) {
    const f = await fixture({ treaty: false });
    // 생성 기록이 없던 과거 저장 형식의 회귀 fixture다. 활성화 증거로 쓰지 않는다.
    await client.query('UPDATE "World" SET "replayOrigin"=NULL WHERE id=$1', [f.worldId]);
    await db.world.update({ where: { id: f.worldId }, data: { status } });
    await (await loopFor(f.worldId)).advanceTo(status === 'RUNNING' ? TICKS_PER_MONTH : 0);
    if (status === 'RUNNING') {
      expect(await db.generalLog.count({ where: { worldId: f.worldId } })).toBeGreaterThan(0);
      expect(await db.yearbookSnapshot.count({ where: { worldId: f.worldId } })).toBe(1);
    }
    expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).treatyFormat).toBeNull();
    await expect(exportReplay(db, f.worldId)).rejects.toThrow('생성 기록이 없는 월드는 재생할 수 없습니다.');
    await corruptTreaty(f.worldId);
    const before = await snapshot(f.worldId);
    await expect((await loopFor(f.worldId)).advanceTo(TICKS_PER_MONTH)).rejects.toThrow(
      '조약을 끈 월드에 조약 저장 행이 있습니다.',
    );
    expect(await snapshot(f.worldId)).toEqual(before);
  }
});
