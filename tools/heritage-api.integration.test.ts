import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb, type Prisma } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { lineageTestConfig } from '../packages/rules/src/lineage/testFixture';
import { HERITAGE_BENEFITS_FEATURE, TICKS_PER_MONTH, type LineageInput } from '../packages/rules/src/index';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { initializeIntegrationResources } from './integration-resources';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, lockLease, assertLease } from '../apps/engine/src/lease';
import { processAdminReset } from '../apps/engine/src/admin/reset';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { PgHeritageRepository } from '../apps/engine/src/heritage/repository';
import { creditHeritageSeason, refundHeritageCreations } from '../apps/engine/src/heritage/service';
import { exportReplay, replayToEnd, replayArchive } from '../apps/engine/src/replay';
import { loadReplayState } from '../apps/engine/src/monthly';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { withdrawAccount } from '../apps/server/src/auth/withdrawalStore';
import type { AppRouter } from '../apps/server/src/router';
import { initializeResources } from './init-resources';
import { authzCase } from '../apps/server/src/authz/case';
import { testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

// 불변 원장은 지우지 않는다. 이 파일이 새로 만든 UUID DB에서만 실제 PG/HTTP/엔진을 검증한다.
if (!process.env.TEST_DATABASE_URL) throw Error('전용 유산 테스트 DB가 필요합니다.');
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (
  !['localhost', '127.0.0.1'].includes(source.hostname) ||
  source.searchParams.has('host') ||
  source.searchParams.has('port')
)
  throw Error('loopback 전용 유산 테스트 DB를 확인하세요.');
const name = `heritage_${randomUUID().replaceAll('-', '')}_test`;
if (!/^heritage_[a-f0-9]{32}_test$/.test(name)) throw Error('유산 시험 DB 이름을 확인하세요.');
const target = new URL(source),
  adminUrl = new URL(source);
target.pathname = `/${name}`;
adminUrl.pathname = '/postgres';
type PgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url)),
  pgRequire = createRequire(dbRequire.resolve('@prisma/adapter-pg')),
  { Client } = pgRequire('pg') as { Client: new (config: { connectionString: string }) => PgClient };
const admin = new Client({ connectionString: adminUrl.href }),
  sql = new Client({ connectionString: target.href }),
  db = createDb(target.href),
  now = Date.now();
let created = false,
  oid: string | undefined,
  base: string,
  app: Awaited<ReturnType<typeof buildServer>> | undefined;
type Out = inferRouterOutputs<AppRouter>;
type Replies = {
  'general.create': Out['general']['create'];
  'general.mine': Out['general']['mine'];
  'heritage.mine': Out['heritage']['mine'];
  'heritage.benefits': Out['heritage']['benefits'];
  'heritage.specialty': Out['heritage']['specialty'];
  'heritage.turnTime': Out['heritage']['turnTime'];
  'heritage.statReset': Out['heritage']['statReset'];
  'heritage.purchase': Out['heritage']['purchase'];
  'lineage.get': Out['lineage']['get'];
  'lineage.submit': Out['lineage']['submit'];
  'lineage.request': Out['lineage']['request'];
  'turns.set': Out['turns']['set'];
  'nationTurns.set': Out['nationTurns']['set'];
  'admin.world.requestReset': Out['admin']['world']['requestReset'];
  'admin.world.resetRequest': Out['admin']['world']['resetRequest'];
};
type User = { id: string; sessionId: string; cookie: string };
async function rpc<R extends keyof Replies>(route: R, input: unknown, user?: User) {
  const mutation =
      route === 'general.create' ||
      route === 'turns.set' ||
      route === 'heritage.purchase' ||
      route === 'heritage.specialty' ||
      route === 'heritage.turnTime' ||
      route === 'heritage.statReset' ||
      route === 'nationTurns.set' ||
      route === 'lineage.submit' ||
      route === 'admin.world.requestReset',
    encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${route}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(user ? { cookie: user.cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  type Envelope = { result?: { data: Replies[R] }; error?: { data: { code: string }; message: string } };
  const json = (await response.json()) as Envelope | Envelope[],
    body = Array.isArray(json) ? json[0]! : json;
  return { status: response.status, data: body.result?.data, error: body.error };
}
async function user(passwordHash = 'not-a-login-hash'): Promise<User> {
  const id = randomUUID(),
    session = newSession(now);
  await db.user.create({
    data: {
      id,
      email: `${id}@example.invalid`,
      passwordHash,
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  return { id, sessionId: session.id, cookie: `sid=${session.token}` };
}
async function world(
  options: {
    winner?: User;
    actor?: User;
    enabled?: boolean;
    benefits?: boolean;
    specialty?: boolean | 'growth';
    turnTime?: boolean;
    birth?: boolean;
    inactive?: boolean;
    turnTermMinutes?: number;
    endYear?: number | null;
    personnel?: boolean;
    maxGenerals?: number;
    lineage?: boolean;
  } = {},
) {
  const initial = commandInitial();
  initial.seed = `heritage-pg-${randomUUID()}`;
  initial.diplomacies = initial.diplomacies.map((row) => ({ ...row, state: 'NON_AGGRESSION', untilTick: 1_000_000 }));
  for (const general of initial.generals) general.nextTurnTick = 1_000_000;
  if (options.winner) {
    initial.diplomacies = [];
    delete initial.nationTurns;
    initial.nations = initial.nations.filter((nation) => nation.id === 1);
    initial.cities = initial.cities.map((city) => ({ ...city, nationId: 1 }));
    initial.generals = initial.generals.filter((general) => general.id === 1);
    initial.generals[0]!.userId = options.winner.id;
    initial.generals[0]!.nextTurnTick = 100;
  } else if (options.actor) {
    initial.generals[0]!.userId = options.actor.id;
  }
  if (options.turnTime) initial.generals[0]!.nextTurnTick = 100;
  if (options.specialty && options.specialty !== 'growth') initial.generals[0]!.special = 'che_보병';
  if (options.specialty === 'growth') {
    initial.generals[0]!.birthYear = initial.startYear - 70;
    initial.generals[0]!.age = 70;
    initial.generals[0]!.deathYear = initial.startYear + 10;
  }
  const enabled = options.enabled !== false,
    withLineage = Boolean(options.maxGenerals || options.lineage);
  const featureData = {
    ...(enabled ? { 'heritage-v1': { version: 1 } } : {}),
    ...(withLineage
      ? {
          'lineage-v1': {
            ...lineageTestConfig,
            birth: {
              ...lineageTestConfig.birth,
              ...(options.lineage ? { comingOfAgeYears: 1 } : {}),
            },
            limits: {
              ...lineageTestConfig.limits,
              maxGenerals: options.maxGenerals ?? lineageTestConfig.limits.maxGenerals,
            },
          },
        }
      : {}),
  };
  const saved = await saveInitialWorld(db, initial, {
    name: '유산 실제 처리 검증',
    turnTermMinutes: options.turnTermMinutes ?? 60,
    replayFormat: 3,
    endYear: options.endYear ?? null,
    ruleFeatures: [
      ...(enabled ? ['heritage-v1'] : []),
      ...(options.benefits || options.specialty || options.birth ? [HERITAGE_BENEFITS_FEATURE] : []),
      ...(options.specialty || options.birth ? ['combat-specialty-v1', 'heritage-specialty-v1'] : []),
      ...(options.birth ? ['heritage-birth-v1'] : []),
      ...(options.specialty === 'growth' ? ['domestic-specialty-v1', 'specialty-growth-v1'] : []),
      ...(options.inactive ? ['inactive-removal-v1', 'player-autoplay-v1'] : []),
      'policy',
      ...(options.personnel || withLineage ? ['personnel'] : []),
      ...(withLineage ? ['lineage-v1'] : []),
    ].sort(),
    featureData,
  });
  await controlClock(db, saved.worldId, 'start');
  return saved.worldId;
}
async function advance(worldId: string, tick = 0, fail = false) {
  const lease = await acquireLease(db, worldId, randomUUID(), 120000);
  if (!lease) throw Error('유산 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw Error('heritage-save-failure');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
async function earnWins(player: User, count: number) {
  for (let i = 0; i < count; i++) {
    const id = await world({ winner: player });
    await advance(id, 100);
    expect((await db.worldResult.findUniqueOrThrow({ where: { worldId: id } })).reason).toBe('UNIFIED');
  }
}
const payload = (worldId: string, name = '유산장수') => ({
  worldId,
  name,
  leadership: 70,
  strength: 70,
  intel: 60,
  portraitId: null,
  heritage: { leadership: 3, intel: 3 },
});
async function admit(worldId: string, player: User, input: unknown = payload(worldId)) {
  const result = rpc('general.create', input, player),
    deadline = performance.now() + 6000;
  while (
    !(await db.inputEvent.findFirst({
      where: { worldId, userId: player.id, kind: 'general.create', status: 'PENDING' },
    }))
  ) {
    if (performance.now() > deadline) throw Error(`생성 접수가 없습니다: ${JSON.stringify(await result)}`);
    await delay(10);
  }
  return { result };
}
async function invariant(player: User) {
  const account = await db.heritageAccount.findUnique({ where: { userId: player.id } }),
    entries = await db.heritageEntry.findMany({ where: { userId: player.id } });
  expect(account?.balance ?? 0).toBe(entries.reduce((sum, entry) => sum + entry.delta, 0));
  expect(account?.balance ?? 0).toBeGreaterThanOrEqual(0);
  return { balance: account?.balance ?? 0, entries };
}
async function enqueueEnd(worldId: string, player: User) {
  await db.user.update({ where: { id: player.id }, data: { role: 'ADMIN' } });
  await controlClock(db, worldId, 'pause');
  const current = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  await db.inputEvent.create({
    data: {
      worldId,
      userId: player.id,
      kind: 'admin.world.end',
      idempotencyKey: `end:${randomUUID()}`,
      status: 'PENDING',
      payload: {
        version: 1,
        expectedRevision: current.clockRevision,
        confirmName: current.name,
        reason: '유산 사용 점수 반환 검증',
      },
    },
  });
}
async function end(worldId: string, player: User, fail = false) {
  await enqueueEnd(worldId, player);
  await advance(worldId, 0, fail);
}

async function crashBeforeCommit(worldId: string) {
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(require.resolve('tsx')).href,
      fileURLToPath(new URL('./heritage-crash-worker.ts', import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, TEST_DATABASE_URL: target.href, HERITAGE_CRASH_WORLD: worldId },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    },
  );
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  let timeout: ReturnType<typeof setTimeout>;
  const ready = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('중단 시험의 커밋 직전 신호가 없습니다.')), 15000);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('커밋 직전 신호 전에 시험 프로세스가 끝났습니다.')));
    child.once('message', (message) => {
      if (typeof message === 'object' && message !== null && 'phase' in message && message.phase === 'BEFORE_COMMIT')
        resolve();
      else reject(new Error('중단 시험 신호가 올바르지 않습니다.'));
    });
  });
  try {
    await ready;
    expect(child.kill('SIGKILL')).toBe(true);
    await closed;
  } finally {
    clearTimeout(timeout!);
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    await closed;
  }
}

async function waitForCrashedLease(worldId: string) {
  await expect
    .poll(
      async () => {
        const rows = await db.$queryRaw<
          Array<{ expired: boolean }>
        >`SELECT "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "EngineLease" WHERE "worldId"=${worldId}`;
        return rows[0]?.expired ?? false;
      },
      { timeout: 10000 },
    )
    .toBe(true);
}

it.each(['spend', 'refund'] as const)(
  'AC-P2-33 실제 프로세스 중단 뒤 %s를 재처리해도 원장과 잔액을 한 번만 바꾼다',
  async (phase) => {
    const player = await user(),
      administrator = await user();
    await earnWins(player, 3);
    const id = await world();
    if (phase === 'spend') {
      const { worldId, ...body } = payload(id);
      await db.inputEvent.create({
        data: {
          worldId,
          userId: player.id,
          kind: 'general.create',
          idempotencyKey: randomUUID(),
          status: 'PENDING',
          payload: body,
        },
      });
    } else {
      const request = await admit(id, player);
      await advance(id);
      expect((await request.result).data?.status).toBe('created');
      await enqueueEnd(id, administrator);
    }
    const event = await db.inputEvent.findFirstOrThrow({ where: { worldId: id, status: 'PENDING' } }),
      before = await invariant(player),
      state = hashState(await db.$transaction((tx) => loadReplayState(tx, id)));
    await crashBeforeCommit(id);
    expect(await invariant(player)).toEqual(before);
    expect((await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PENDING');
    expect((await db.world.findUniqueOrThrow({ where: { id } })).status).toBe(phase === 'spend' ? 'RUNNING' : 'PAUSED');
    expect(hashState(await db.$transaction((tx) => loadReplayState(tx, id)))).toBe(state);
    await waitForCrashedLease(id);
    await advance(id);
    expect((await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('APPLIED');
    const after = await invariant(player),
      kind = phase === 'spend' ? 'CREATION_SPEND' : 'CREATION_REFUND';
    expect(after.balance).toBe(phase === 'spend' ? 0 : 6);
    expect(after.entries.filter((entry) => entry.worldId === id && entry.kind === kind)).toHaveLength(1);
    await advance(id);
    expect(await invariant(player)).toEqual(after);
    if (phase === 'spend') await end(id, administrator);
    const archive = await exportReplay(db, id);
    expect(replayToEnd(archive)).toEqual(archive.end);
  },
  120000,
);

it('AC-P2-33 계승 전후 36개월 활동을 합산하고 다음 허용 기수에서 얻은 유산을 한 번 쓴다', async () => {
  const father = await user(),
    mother = await user(),
    id = await world({ lineage: true, endYear: 193 });
  // 성인 등장 1년·확률 100%인 인공 고정물이다. 공개 기본값·491명 전체 기수의 증거가 아니다.
  const create = async (player: User, name: string, sex: 'MALE' | 'FEMALE') => {
    const request = await admit(id, player, {
      worldId: id,
      name,
      sex,
      leadership: 70,
      strength: 70,
      intel: 60,
      portraitId: null,
    });
    await advance(id);
    const result = await request.result;
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    if (result.data?.status !== 'created') throw Error('계승 활동 고정물의 장수 생성이 끝나지 않았습니다.');
    return result.data.general.id;
  };
  const send = async (player: User, generalId: number, payload: LineageInput) => {
    const requestId = randomUUID();
    const submitted = await rpc(
      'lineage.submit',
      {
        worldId: id,
        expectedUserId: player.id,
        expectedGeneralId: generalId,
        requestId,
        payload,
      },
      player,
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(200);
    await advance(id, (await db.world.findUniqueOrThrow({ where: { id } })).clockTick);
    const receipt = await rpc('lineage.request', { worldId: id, requestId }, player);
    expect(receipt.data?.status, JSON.stringify(receipt.error ?? receipt.data)).toBe('applied');
    if (receipt.data?.status !== 'applied') throw Error('실제 가문 입력이 적용되지 않았습니다.');
    return receipt.data.result;
  };
  const from = await create(father, '유산부', 'MALE'),
    mom = await create(mother, '유산모', 'FEMALE'),
    offered = await send(father, from, { type: 'marriage.propose', targetGeneralId: mom });
  expect(offered.offerId).toBeDefined();
  await send(mother, mom, { type: 'marriage.respond', offerId: offered.offerId!, accept: true });
  await advance(id, TICKS_PER_MONTH);
  const birth = await db.$transaction((tx) => loadReplayState(tx, id)),
    heir = Number(Object.entries(birth.state.lineage!.persons).find(([, person]) => person.parents.includes(from))![0]);
  for (let month = 1; month < 12; month++) {
    await send(father, from, { type: 'heir.designate', heirGeneralId: null });
    await advance(id, (month + 1) * TICKS_PER_MONTH);
  }
  await send(father, from, { type: 'heir.designate', heirGeneralId: heir });
  const board = await rpc('lineage.get', { worldId: id }, father),
    preview = board.data?.view.mine?.preview;
  if (!preview) throw Error('실제 후계자의 계승 미리보기가 없습니다.');
  await send(father, from, { type: 'succession.confirm', heirGeneralId: heir, expected: preview });
  for (let month = 12; month < 36; month++) {
    await send(father, heir, { type: 'heir.designate', heirGeneralId: null });
    await advance(id, (month + 1) * TICKS_PER_MONTH);
  }
  expect(await db.general.count({ where: { worldId: id, userId: father.id } })).toBe(1);
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: id, id: heir } } })).toMatchObject({
    userId: father.id,
  });
  const result = await db.worldResult.findUniqueOrThrow({ where: { worldId: id } }),
    credit = await db.heritageEntry.findMany({ where: { worldId: id, userId: father.id, kind: 'SEASON_CREDIT' } });
  expect(result.reason).toBe('END_YEAR');
  expect(credit).toHaveLength(1);
  expect(credit[0]).toMatchObject({ delta: 3, detail: { activityMonths: 36, activityPoints: 3, winPoints: 0 } });
  expect((await invariant(father)).balance).toBe(3);
  const archive = await exportReplay(db, id);
  expect(replayToEnd(archive)).toEqual(archive.end);
  expect(archive.end?.finalStateHash).toBe(result.finalStateHash);

  const disabled = await world({ enabled: false });
  const bonus = { leadership: 3 };
  expect((await rpc('general.mine', { worldId: disabled }, father)).data!.creationRules).not.toHaveProperty('heritage');
  expect((await rpc('general.create', { ...payload(disabled), heritage: bonus }, father)).status).toBe(400);
  expect(await db.inputEvent.count({ where: { worldId: disabled, kind: 'general.create' } })).toBe(0);
  expect((await invariant(father)).balance).toBe(3);

  const next = await world({ endYear: 191 });
  expect((await rpc('general.mine', { worldId: next }, father)).data!.creationRules.heritage).toMatchObject({
    balance: 3,
    perStat: 3,
    perGeneral: 6,
  });
  const creation = await admit(next, father, { ...payload(next, '다음기수장수'), heritage: bonus });
  await advance(next);
  expect((await creation.result).data).toMatchObject({
    status: 'created',
    general: { leadership: 73, strength: 70, intel: 60 },
  });
  expect(
    await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: next, userId: father.id } } }),
  ).toMatchObject({
    leadership: 73,
    strength: 70,
    intel: 60,
  });
  const saved = await db.inputEvent.findFirstOrThrow({ where: { worldId: next, kind: 'general.create' } });
  expect(saved.result).toMatchObject({ heritage: { version: 1, cost: 3, bonus } });
  await advance(next, 12 * TICKS_PER_MONTH);
  const nextResult = await db.worldResult.findUniqueOrThrow({ where: { worldId: next } });
  expect(nextResult.reason).toBe('END_YEAR');
  const account = await invariant(father);
  expect(account.balance).toBe(0);
  expect(account.entries).toHaveLength(2);
  expect(account.entries).toContainEqual(expect.objectContaining({ worldId: next, kind: 'CREATION_SPEND', delta: -3 }));
  const nextArchive = await exportReplay(db, next);
  expect(replayToEnd(nextArchive)).toEqual(nextArchive.end);
  expect(nextArchive.end?.finalStateHash).toBe(nextResult.finalStateHash);
  expect(await exportReplay(db, id)).toEqual(archive);
}, 120000);

it('AC-P2-33 국가 예턴만 직접 편집한 12개월도 활동분을 지급한다', async () => {
  const player = await user(),
    id = await world({ personnel: true, endYear: 191 });
  // 이 사례는 국가 예턴 기록의 활동 시각을 검증한다. 군주 조작권은 시험 초기 조건으로 배정한다.
  await db.general.update({
    where: { worldId_id: { worldId: id, id: 1 } },
    data: { userId: player.id, residenceTick: 0 },
  });
  for (let month = 0; month < 12; month++) {
    const saved = await rpc(
      'nationTurns.set',
      {
        worldId: id,
        office: { nationId: 1, officerLevel: 12, tenure: 0 },
        revision: month,
        slots: Array.from({ length: 12 }, () => null),
      },
      player,
    );
    expect(saved.data).toMatchObject({ ok: true });
    await advance(id, (month + 1) * TICKS_PER_MONTH);
  }
  expect((await invariant(player)).balance).toBe(1);
  const entry = (await invariant(player)).entries[0]!;
  expect(entry.detail).toMatchObject({ activityMonths: 12, activityPoints: 1, winPoints: 0 });
}, 120000);

it.each(['NAME_TAKEN', 'WORLD_FULL', 'ACTOR_INACTIVE'] as const)(
  'AC-P2-33 엔진의 %s 생성 거부는 기존 유산 잔액과 원장을 보존한다',
  async (code) => {
    const player = await user(await hashPassword('Heritage-rejected-password-29!'));
    await earnWins(player, 3);
    const id = await world(code === 'WORLD_FULL' ? { maxGenerals: 4 } : {});
    if (code === 'ACTOR_INACTIVE') {
      const account = await db.user.findUniqueOrThrow({ where: { id: player.id } });
      await withdrawAccount(db, {
        userId: player.id,
        sessionId: player.sessionId,
        password: 'Heritage-rejected-password-29!',
        dummyPasswordHash: account.passwordHash,
      });
    }
    const { worldId, ...body } = payload(id, code === 'NAME_TAKEN' ? '장수1' : '거부유산'),
      before = await invariant(player),
      event = await db.inputEvent.create({
        data: {
          worldId,
          userId: player.id,
          kind: 'general.create',
          idempotencyKey: randomUUID(),
          status: 'PENDING',
          payload: { ...body, ...(code === 'WORLD_FULL' ? { sex: 'MALE' } : {}) },
        },
      });
    await advance(id);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'REJECTED',
      result: { code },
    });
    expect(await invariant(player)).toEqual(before);
    expect(await db.general.count({ where: { worldId: id, userId: player.id } })).toBe(0);
  },
  120000,
);

it('AC-P2-33 다른 대기 배분은 409이고 성공 응답과 생성 규칙에 본인 유산이 반영된다', async () => {
  const player = await user();
  await earnWins(player, 3);
  const id = await world(),
    request = await admit(id, player);
  const mine = await rpc('general.mine', { worldId: id }, player);
  expect(mine.data!.creationRules.heritage).toMatchObject({ userId: player.id, balance: 6, perStat: 3, perGeneral: 6 });
  expect((await rpc('general.create', { ...payload(id), heritage: { leadership: 2, intel: 3 } }, player)).status).toBe(
    409,
  );
  expect(await db.inputEvent.count({ where: { worldId: id, kind: 'general.create' } })).toBe(1);
  await advance(id);
  expect((await request.result).data).toMatchObject({
    status: 'created',
    general: { leadership: 73, strength: 70, intel: 63 },
  });
}, 120000);

it('INT-26 시작 도시·턴 시간대·전투 특기 가격을 한 번 차감하고 관리자 종료 때 돌려준다', async () => {
  const player = await user();
  const id = await world({ birth: true });
  const mine = await rpc('general.mine', { worldId: id }, player);
  expect(mine.data!.creationRules.heritageBirth).toMatchObject({
    costs: { cityKey: 1000, turnZone: 2500, specialty: 6000 },
    turnZones: 60,
  });
  const cityKey = mine.data!.creationRules.heritageBirth.cities.at(-1).cityKey;
  const birth = { cityKey, turnZone: 59, specialty: '궁병' };
  const creation = { ...payload(id), heritageBirth: birth };
  expect(
    (await rpc('general.create', { ...creation, heritageBirth: { ...birth, cityKey: 999999 } }, player)).status,
  ).toBe(400);
  const rejected = await admit(id, player, creation);
  await advance(id);
  expect((await rejected.result).status).toBe(409);
  expect(await invariant(player)).toEqual({ balance: 0, entries: [] });

  await db.heritageAccount.create({ data: { userId: player.id, balance: 9506 } });
  const accepted = await admit(id, player, creation);
  await advance(id);
  expect((await accepted.result).status).toBe(200);
  const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: id, userId: player.id } } });
  expect(general).toMatchObject({ cityKey, special: '궁병', leadership: 73, intel: 63 });
  expect(general.nextTurnTick % TICKS_PER_MONTH).toBeGreaterThanOrEqual(9833);
  expect((await db.heritageAccount.findUniqueOrThrow({ where: { userId: player.id } })).balance).toBe(0);
  expect(await db.heritageEntry.findMany({ where: { userId: player.id } })).toMatchObject([
    { kind: 'CREATION_SPEND', delta: -9506, detail: { version: 2, birth, cost: 9506 } },
  ]);
  await enqueueEnd(id, player);
  await advance(id);
  const archive = await exportReplay(db, id);
  expect(replayToEnd(archive)).toEqual(archive.end);
  expect((await db.heritageAccount.findUniqueOrThrow({ where: { userId: player.id } })).balance).toBe(9506);
  expect(
    await db.heritageEntry.findFirstOrThrow({ where: { userId: player.id, kind: 'CREATION_REFUND' } }),
  ).toMatchObject({
    delta: 9506,
    detail: { version: 2, birth: true },
  });
}, 120000);

it.each([
  { kind: 'SEASON_CREDIT', delta: 6 },
  { kind: 'UNKNOWN', delta: 1 },
  { kind: 'CREATION_SPEND', delta: -7 },
])(
  'AC-P2-33 잘못된 원장 kind $kind / delta $delta 값은 DB에서 거부한다',
  async ({ kind, delta }) => {
    const player = await user(),
      id = await world();
    await expect(
      sql.query(
        'INSERT INTO "HeritageEntry" ("userId", key, kind, "worldId", delta, detail) VALUES ($1,$2,$3,$4,$5,\'{}\')',
        [player.id, randomUUID(), kind, id, delta],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await invariant(player)).toEqual({ balance: 0, entries: [] });
  },
  120000,
);

it.each(['ADMIN_REQUIRED', 'WORLD_NAME_CHANGED', 'WORLD_REVISION_CHANGED', 'WORLD_STATE_CHANGED'] as const)(
  'AC-P2-33 관리자 종료의 %s 거부는 유산을 반환하지 않는다',
  async (code) => {
    const player = await user(),
      administrator = await user();
    await earnWins(player, 3);
    const id = await world(),
      request = await admit(id, player);
    await advance(id);
    expect((await request.result).data?.status).toBe('created');
    if (code === 'WORLD_STATE_CHANGED') await end(id, administrator);
    else await controlClock(db, id, 'pause');
    if (code !== 'ADMIN_REQUIRED') await db.user.update({ where: { id: administrator.id }, data: { role: 'ADMIN' } });
    const current = await db.world.findUniqueOrThrow({ where: { id } }),
      before = await invariant(player),
      event = await db.inputEvent.create({
        data: {
          worldId: id,
          userId: administrator.id,
          kind: 'admin.world.end',
          idempotencyKey: randomUUID(),
          status: 'PENDING',
          payload: {
            version: 1,
            confirmName: code === 'WORLD_NAME_CHANGED' ? '다른월드' : current.name,
            expectedRevision: current.clockRevision + (code === 'WORLD_REVISION_CHANGED' ? 1 : 0),
            reason: '거부 때의 반환 없음 검증',
          },
        },
      });
    await advance(id);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'REJECTED',
      result: { code },
    });
    expect(await invariant(player)).toEqual(before);
    expect((await db.world.findUniqueOrThrow({ where: { id } })).status).toBe(
      code === 'WORLD_STATE_CHANGED' ? 'ENDED' : 'PAUSED',
    );
  },
  120000,
);

it('AC-P2-33 제재를 받은 사용 계정에도 관리자 반환을 지급한다', async () => {
  const player = await user(),
    administrator = await user();
  await earnWins(player, 3);
  const id = await world(),
    request = await admit(id, player);
  await advance(id);
  expect((await request.result).data?.status).toBe('created');
  await db.sanction.create({
    data: { userId: player.id, worldId: id, createdBy: administrator.id, reason: '반환과 제재의 독립성 검증' },
  });
  await end(id, administrator);
  const ledger = await invariant(player);
  expect(ledger.balance).toBe(6);
  expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_REFUND')).toHaveLength(1);
}, 120000);

it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
  'AC-P2-33 탈퇴와 생성 경합 %i는 직렬화 가능한 한 결과와 잔액 0만 남긴다',
  async () => {
    const password = 'Heritage-create-race-password-29!',
      passwordHash = await hashPassword(password),
      player = await user(passwordHash);
    await earnWins(player, 3);
    const id = await world(),
      { worldId, ...body } = payload(id),
      event = await db.inputEvent.create({
        data: {
          worldId,
          userId: player.id,
          kind: 'general.create',
          idempotencyKey: randomUUID(),
          status: 'PENDING',
          payload: body,
        },
      });
    await Promise.all([
      advance(id),
      withdrawAccount(db, {
        userId: player.id,
        sessionId: player.sessionId,
        password,
        dummyPasswordHash: passwordHash,
      }),
    ]);
    const stored = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ledger = await invariant(player);
    expect(ledger.balance).toBe(0);
    expect(['APPLIED', 'REJECTED']).toContain(stored.status);
    if (stored.status === 'REJECTED') expect(stored.result).toMatchObject({ code: 'ACTOR_INACTIVE' });
    expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_SPEND')).toHaveLength(
      stored.status === 'APPLIED' ? 1 : 0,
    );
    expect(ledger.entries.filter((entry) => entry.kind === 'FORFEIT')).toHaveLength(
      stored.status === 'APPLIED' ? 0 : 1,
    );
    expect(await db.general.count({ where: { worldId: id, userId: player.id } })).toBe(
      stored.status === 'APPLIED' ? 1 : 0,
    );
  },
  120000,
);

it.each(['end', 'reset'] as const)(
  'AC-P2-33 유산을 끈 491명 월드의 관리자 %s는 원장 행을 만들지 않는다',
  async (action) => {
    const player = await user(),
      administrator = await user();
    await earnWins(player, 3);
    const initial = await loadInitialWorldFromDb(db, {
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: randomUUID(),
    });
    initial.ruleFeatures = [...new Set([...(initial.ruleFeatures ?? []), 'policy'])].sort();
    const { worldId: id } = await saveInitialWorld(db, initial, {
      name: '비유산 종료 초기화 검증',
      turnTermMinutes: 60,
      endYear: 200,
      replayFormat: 3,
      ruleFeatures: [...new Set([...(initial.ruleFeatures ?? []), 'policy'])].sort(),
    });
    await controlClock(db, id, 'start');
    const request = await admit(id, player, {
      worldId: id,
      name: '유산없음',
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
      portraitId: null,
    });
    await advance(id);
    expect((await request.result).data?.status).toBe('created');
    const before = await invariant(player);
    if (action === 'end') await end(id, administrator);
    else {
      await db.user.update({ where: { id: administrator.id }, data: { role: 'ADMIN' } });
      await controlClock(db, id, 'pause');
      const current = await db.world.findUniqueOrThrow({ where: { id } }),
        binding = { worldId: id, expectedUserId: administrator.id, idempotencyKey: randomUUID() };
      expect(
        (
          await rpc(
            'admin.world.requestReset',
            {
              ...binding,
              confirmName: current.name,
              expectedRevision: current.clockRevision,
              reason: '비유산 초기화의 원장 없음 검증',
            },
            administrator,
          )
        ).status,
      ).toBe(200);
      await advance(id);
      const receipt = (await rpc('admin.world.resetRequest', binding, administrator)).data!;
      expect(receipt.status).toBe('APPLIED');
      expect(await db.heritageEntry.count({ where: { worldId: receipt.plannedNewWorldId } })).toBe(0);
    }
    expect(await db.heritageEntry.count({ where: { worldId: id } })).toBe(0);
    expect(await invariant(player)).toEqual(before);
  },
  120000,
);

it.each(['TARGET_EXISTS', 'RESOURCE_INVALID'] as const)(
  'AC-P2-33 관리자 초기화의 %s 거부는 원본과 사용 잔액을 보존한다',
  async (code) => {
    const player = await user(),
      administrator = await user();
    await earnWins(player, 3);
    const id = await world(),
      creation = await admit(id, player);
    await advance(id);
    expect((await creation.result).data?.status).toBe('created');
    await db.user.update({ where: { id: administrator.id }, data: { role: 'ADMIN' } });
    await controlClock(db, id, 'pause');
    const current = await db.world.findUniqueOrThrow({ where: { id } }),
      existing = code === 'TARGET_EXISTS' ? await world() : null,
      targetId = existing ?? randomUUID(),
      before = await invariant(player),
      event = await db.inputEvent.create({
        data: {
          worldId: id,
          userId: administrator.id,
          kind: 'admin.world.reset',
          idempotencyKey: randomUUID(),
          status: 'PENDING',
          payload: {
            version: 1,
            sourceWorldId: id,
            intent: {
              confirmName: current.name,
              expectedRevision: current.clockRevision,
              reason: '초기화 거부의 반환 없음 검증',
              requestedSeed: null,
            },
            plannedNewWorldId: targetId,
            effectiveSeed: randomUUID(),
          },
        },
      });
    await advance(id);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'REJECTED',
      result: { code },
    });
    expect((await db.world.findUniqueOrThrow({ where: { id } })).status).toBe('PAUSED');
    expect(await invariant(player)).toEqual(before);
    if (existing) expect(await db.general.count({ where: { worldId: existing } })).toBe(4);
    else expect(await db.world.findUnique({ where: { id: targetId } })).toBeNull();
  },
  120000,
);

it('AC-P2-33 규모 측정: 합성 활동 10만 행이 있는 실제 PG 월드의 종료 지급을 측정한다', async () => {
  const player = await user(),
    id = await world({ actor: player, endYear: 191 }),
    count = 100000,
    slots = Array.from({ length: 30 }, () => null);
  // 쿼리 부하용 합성 자료다. 이 행들의 명령 적용·재생 성공 증거로 세지 않는다.
  for (let offset = 0; offset < count; offset += 2000)
    await db.inputEvent.createMany({
      data: Array.from({ length: 2000 }, (_, j) => {
        const index = offset + j;
        return {
          worldId: id,
          userId: player.id,
          generalId: 1,
          kind: 'turns.set',
          idempotencyKey: `load:${index}`,
          status: 'APPLIED' as const,
          sequence: index + 1,
          tick: Math.floor((index * 12) / count) * TICKS_PER_MONTH,
          payload: { revision: index, slots },
          result: { activeTick: Math.floor((index * 12) / count) * TICKS_PER_MONTH, revision: index + 1 },
        };
      }),
    });
  await db.world.update({ where: { id }, data: { actionSequence: count } });
  expect(await db.inputEvent.count({ where: { worldId: id, kind: 'turns.set' } })).toBe(count);
  const started = performance.now();
  await advance(id, 12 * TICKS_PER_MONTH);
  console.info(
    'AC-P2-33 synthetic activity rows',
    count,
    'actual PG end milliseconds',
    Math.round(performance.now() - started),
  );
  expect((await db.worldResult.findUniqueOrThrow({ where: { worldId: id } })).reason).toBe('END_YEAR');
  expect((await invariant(player)).balance).toBe(1);
}, 120000);

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  oid = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]?.oid as
    string | undefined;
  if (!oid) throw Error('생성한 유산 시험 DB OID가 없습니다.');
  await sql.connect();
  const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
  for (const directory of (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort())
    await sql.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'));
  await initializeResources(
    db,
    await readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
  );
  await initializeIntegrationResources(db);
  app = await buildServer({ db, now: () => now, logging: false });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
}, 120000);
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
  await sql.end();
  try {
    if (created) {
      if (!oid) throw Error('소유 유산 시험 DB OID를 확인하지 못해 보존합니다.');
      const observation = await confirmDisconnectedDatabase(admin, name, oid);
      expect(observation.connections).toBe(0);
      await admin.query(`DROP DATABASE "${name}"`);
      expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
      console.info(JSON.stringify({ event: 'heritage-db-dropped', name, oid, ...observation, absent: true }));
    }
  } finally {
    await admin.end();
  }
});

it('AC-P2-33 실제 통일 보상을 중복 없이 지급하고 6점을 넘는 계정 잔액을 보존한다', async () => {
  const player = await user();
  await earnWins(player, 4);
  const first = await invariant(player);
  expect(first.balance).toBe(8);
  expect(first.entries.map((entry) => entry.delta)).toEqual([2, 2, 2, 2]);
  for (const entry of first.entries) await advance(entry.worldId!, 100);
  expect((await invariant(player)).entries).toEqual(first.entries);
  const mine = await rpc('heritage.mine', undefined, player);
  expect(mine.status).toBe(200);
  expect(mine.data).toMatchObject({ userId: player.id, balance: 8, perStat: 3, perGeneral: 6, perSeason: 5 });
  expect(mine.data!.entries[0]!.worldName).toBe('유산 실제 처리 검증');
  expect(Object.keys(mine.data!.entries[0]!).sort()).toEqual(
    ['id', 'kind', 'worldId', 'worldName', 'delta', 'createdAt', 'credit'].sort(),
  );
  expect((await rpc('heritage.mine', undefined)).status).toBe(401);
  expect((await rpc('heritage.mine', { userId: player.id }, player)).status).toBe(400);
  expect((await rpc('heritage.mine', undefined, await user())).data).toMatchObject({ balance: 0, entries: [] });
}, 120000);

it('AC-P2-33 실제 서로 다른 12개월 직접 명령은 정상 종료 때 활동 1점을 지급한다', async () => {
  const player = await user(),
    id = await world({ actor: player, endYear: 191 });
  expect((await rpc('heritage.mine', undefined, player)).data?.activeWorlds).toContainEqual(
    expect.objectContaining({ worldId: id, activityMonths: 0, activityPoints: 0, monthsToNextPoint: 12 }),
  );
  for (let month = 0; month < 12; month++) {
    const saved = await rpc(
      'turns.set',
      { worldId: id, revision: month, slots: Array.from({ length: 30 }, () => null) },
      player,
    );
    expect(saved.data).toMatchObject({ ok: true });
    await advance(id, (month + 1) * TICKS_PER_MONTH);
    if (month === 1)
      expect((await rpc('heritage.mine', undefined, player)).data?.activeWorlds).toContainEqual(
        expect.objectContaining({ worldId: id, activityMonths: 2, activityPoints: 0, monthsToNextPoint: 10 }),
      );
  }
  expect((await rpc('heritage.mine', undefined, player)).data?.activeWorlds).toEqual([]);
  expect((await db.worldResult.findUniqueOrThrow({ where: { worldId: id } })).reason).toBe('END_YEAR');
  const result = await invariant(player);
  expect(result.balance).toBe(1);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]!.detail).toMatchObject({ activityMonths: 12, activityPoints: 1, winPoints: 0 });
  const archive = await exportReplay(db, id);
  expect(replayToEnd(archive)).toEqual(archive.end);
}, 120000);

it('AC-P2-33 정상 기한 종료는 이미 쓴 생성 점수를 반환하지 않는다', async () => {
  const player = await user();
  await earnWins(player, 3);
  const id = await world({ endYear: 191 }),
    request = await admit(id, player);
  await advance(id);
  expect((await request.result).data?.status).toBe('created');
  await advance(id, 12 * TICKS_PER_MONTH);
  expect((await db.worldResult.findUniqueOrThrow({ where: { worldId: id } })).reason).toBe('END_YEAR');
  const result = await invariant(player);
  expect(result.balance).toBe(0);
  expect(result.entries.filter((entry) => entry.worldId === id).map((entry) => entry.kind)).toEqual(['CREATION_SPEND']);
}, 120000);

it('AC-P2-33 실제 491명 시나리오 초기화는 원본 사용만 반환하고 새 월드에 복사하지 않는다', async () => {
  const player = await user(),
    administrator = await user();
  await earnWins(player, 3);
  const initial = await loadInitialWorldFromDb(db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: randomUUID(),
  });
  expect(initial.generals).toHaveLength(491);
  initial.ruleFeatures = [...new Set([...(initial.ruleFeatures ?? []), 'policy', 'heritage-v1'])].sort();
  const { worldId: id } = await saveInitialWorld(db, initial, {
    name: '491명 유산 초기화',
    turnTermMinutes: 60,
    endYear: 200,
    replayFormat: 3,
    ruleFeatures: initial.ruleFeatures,
    featureData: { 'heritage-v1': { version: 1 } },
  });
  await controlClock(db, id, 'start');
  const request = await admit(id, player, {
    worldId: id,
    expectedUserId: player.id,
    name: '초기유산',
    leadership: 55,
    strength: 55,
    intel: 55,
    politics: 55,
    charm: 55,
    portraitId: null,
    heritage: { leadership: 3, intel: 3 },
  });
  await advance(id);
  expect((await request.result).data?.status).toBe('created');
  expect((await invariant(player)).balance).toBe(0);
  await db.user.update({ where: { id: administrator.id }, data: { role: 'ADMIN' } });
  await controlClock(db, id, 'pause');
  const current = await db.world.findUniqueOrThrow({ where: { id } }),
    binding = { worldId: id, expectedUserId: administrator.id, idempotencyKey: randomUUID() };
  const admitted = await rpc(
    'admin.world.requestReset',
    {
      ...binding,
      confirmName: current.name,
      expectedRevision: current.clockRevision,
      reason: '유산 초기화 반환 검증',
    },
    administrator,
  );
  expect(admitted.status).toBe(200);
  expect(admitted.data?.status).toBe('PENDING');
  await advance(id);
  const receipt = await rpc('admin.world.resetRequest', binding, administrator);
  expect(receipt.data?.status).toBe('APPLIED');
  const newId = receipt.data!.plannedNewWorldId;
  expect(newId).not.toBe(id);
  expect(await db.general.count({ where: { worldId: newId } })).toBe(491);
  expect(await db.heritageEntry.count({ where: { worldId: newId } })).toBe(0);
  expect(await db.worldResult.findUnique({ where: { worldId: id } })).toBeNull();
  const result = await invariant(player);
  expect(result.balance).toBe(6);
  expect(result.entries.find((entry) => entry.kind === 'CREATION_REFUND')!.detail).toMatchObject({
    reason: 'ADMIN_RESET',
    requestId: receipt.data!.requestId,
    newWorldId: newId,
  });
  expect((await rpc('heritage.mine', undefined, player)).data!.entries[0]!.refund).toEqual({ reason: 'ADMIN_RESET' });
  const archive = await exportReplay(db, id);
  expect(replayToEnd(archive)).toEqual(archive.end);
  await advance(id);
  expect((await invariant(player)).entries.filter((entry) => entry.kind === 'CREATION_REFUND')).toHaveLength(1);
  await controlClock(db, newId, 'start');
  const nextCreation = await admit(newId, player, {
    worldId: newId,
    name: '후속유산',
    leadership: 55,
    strength: 55,
    intel: 55,
    politics: 55,
    charm: 55,
    portraitId: null,
    heritage: { leadership: 3, intel: 3 },
  });
  await advance(newId);
  expect((await nextCreation.result).data?.status).toBe('created');
  expect((await invariant(player)).balance).toBe(0);
  await controlClock(db, newId, 'pause');
  const nextWorld = await db.world.findUniqueOrThrow({ where: { id: newId } }),
    nextBinding = { ...binding, worldId: newId, idempotencyKey: randomUUID() },
    nextRequest = await rpc(
      'admin.world.requestReset',
      {
        ...nextBinding,
        confirmName: nextWorld.name,
        expectedRevision: nextWorld.clockRevision,
        reason: '연속 초기화와 반환 롤백 검증',
      },
      administrator,
    );
  expect(nextRequest.status).toBe(200);
  const pending = (await rpc('admin.world.resetRequest', nextBinding, administrator)).data!;
  const resetEvent = await db.inputEvent.findUniqueOrThrow({ where: { id: BigInt(pending.requestId) } }),
    lease = await acquireLease(db, newId, randomUUID(), 120000);
  if (!lease) throw new Error('초기화 대기 검증의 실행권이 없습니다.');
  try {
    const deferred = await db.$transaction(async (tx) => {
      await lockLease(tx, lease);
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${newId} FOR UPDATE`;
      const source = await tx.world.findUniqueOrThrow({ where: { id: newId } });
      const result = await processAdminReset(tx, source, resetEvent);
      await assertLease(tx, lease);
      return result;
    });
    expect(deferred.deferred).toBe(true);
    expect((await invariant(player)).balance).toBe(0);
    expect(await db.heritageEntry.count({ where: { worldId: newId, kind: 'CREATION_REFUND' } })).toBe(0);
    expect(await db.world.findUnique({ where: { id: pending.plannedNewWorldId } })).toBeNull();
  } finally {
    await releaseLease(db, lease);
  }
  await expect(advance(newId, 0, true)).rejects.toThrow('heritage-save-failure');
  expect(await db.world.findUnique({ where: { id: pending.plannedNewWorldId } })).toBeNull();
  expect((await db.world.findUniqueOrThrow({ where: { id: newId } })).status).toBe('PAUSED');
  expect((await invariant(player)).balance).toBe(0);
  expect((await rpc('admin.world.resetRequest', nextBinding, administrator)).data!.status).toBe('PENDING');
  const started = performance.now();
  await advance(newId);
  console.info('AC-P2-33 actual 491-general reset milliseconds', Math.round(performance.now() - started));
  const last = (await rpc('admin.world.resetRequest', nextBinding, administrator)).data!;
  expect(last.status).toBe('APPLIED');
  expect(await db.general.count({ where: { worldId: last.plannedNewWorldId } })).toBe(491);
  expect(await db.heritageEntry.count({ where: { worldId: last.plannedNewWorldId } })).toBe(0);
  const ledger = await invariant(player);
  expect(ledger.balance).toBe(6);
  expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_REFUND' && entry.worldId === id)).toHaveLength(1);
  expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_REFUND' && entry.worldId === newId)).toHaveLength(1);
  const appliedReset = await db.inputEvent.findFirstOrThrow({
      where: { worldId: newId, kind: 'admin.world.reset', status: 'APPLIED' },
    }),
    repeatedReset = await db.inputEvent.create({
      data: {
        worldId: newId,
        userId: administrator.id,
        kind: 'admin.world.reset',
        idempotencyKey: randomUUID(),
        status: 'PENDING',
        payload: appliedReset.payload as Prisma.InputJsonObject,
      },
    });
  await advance(newId);
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: repeatedReset.id } })).toMatchObject({
    status: 'REJECTED',
    result: { code: 'WORLD_STATE_CHANGED' },
  });
  expect(await invariant(player)).toEqual(ledger);
}, 120000);

it('AC-P2-33 중첩 배분의 키 순서가 다른 대기 재요청은 같은 입력을 한 번만 차감한다', async () => {
  const player = await user();
  await earnWins(player, 3);
  const id = await world(),
    first = await admit(id, player),
    second = rpc('general.create', { ...payload(id), heritage: { intel: 3, leadership: 3 } }, player);
  await delay(30);
  expect(await db.inputEvent.count({ where: { worldId: id, kind: 'general.create' } })).toBe(1);
  await advance(id);
  expect((await first.result).data?.status).toBe('created');
  expect((await second).data?.status).toBe('created');
  const result = await invariant(player);
  expect(result.balance).toBe(0);
  expect(result.entries.filter((entry) => entry.kind === 'CREATION_SPEND')).toHaveLength(1);
}, 120000);

it('AC-P2-33 실제 생성 차감·관리자 종료 반환은 재생 해시를 바꾸지 않는다', async () => {
  const player = await user(),
    administrator = await user();
  await earnWins(player, 3);
  const id = await world(),
    request = await admit(id, player);
  await advance(id);
  expect((await request.result).data?.status).toBe('created');
  expect((await invariant(player)).balance).toBe(0);
  const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: id, userId: player.id } } });
  expect([general.leadership, general.strength, general.intel]).toEqual([73, 70, 63]);
  const event = await db.inputEvent.findFirstOrThrow({ where: { worldId: id, kind: 'general.create' } });
  expect(event.result).toMatchObject({ heritage: { version: 1, cost: 6, bonus: { leadership: 3, intel: 3 } } });
  const before = hashState(await db.$transaction((tx) => loadReplayState(tx, id)));
  await expect(end(id, administrator, true)).rejects.toThrow('heritage-save-failure');
  expect((await invariant(player)).balance).toBe(0);
  expect((await db.world.findUniqueOrThrow({ where: { id } })).status).toBe('PAUSED');
  await advance(id);
  expect((await db.world.findUniqueOrThrow({ where: { id } })).status).toBe('ENDED');
  expect(await db.worldResult.findUnique({ where: { worldId: id } })).toBeNull();
  expect((await invariant(player)).balance).toBe(6);
  expect(hashState(await db.$transaction((tx) => loadReplayState(tx, id)))).toBe(before);
  const archive = await exportReplay(db, id);
  expect(replayToEnd(archive)).toEqual(archive.end);
  await advance(id);
  expect((await invariant(player)).entries.filter((entry) => entry.kind === 'CREATION_REFUND')).toHaveLength(1);
}, 120000);

it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
  'AC-P2-33 서로 다른 두 월드의 동시 6점 사용 %i는 하나만 적용하고 부족도 순번을 쓴다',
  async () => {
    const player = await user();
    await earnWins(player, 3);
    const a = await world(),
      b = await world(),
      first = await admit(a, player),
      second = await admit(b, player);
    await Promise.all([advance(a), advance(b)]);
    const replies = await Promise.all([first.result, second.result]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const events = await db.inputEvent.findMany({ where: { worldId: { in: [a, b] }, kind: 'general.create' } });
    expect(events.map((event) => event.status).sort()).toEqual(['APPLIED', 'REJECTED']);
    expect(events.every((event) => event.sequence === 1)).toBe(true);
    expect(events.find((event) => event.status === 'REJECTED')!.result).toMatchObject({
      code: 'HERITAGE_INSUFFICIENT',
    });
    expect((await invariant(player)).balance).toBe(0);
    expect((await invariant(player)).entries.filter((entry) => entry.kind === 'CREATION_SPEND')).toHaveLength(1);
  },
  120000,
);

it('AC-P2-33 생성 저장 실패는 차감·원장·장수를 함께 롤백하고 같은 입력을 다시 처리한다', async () => {
  const player = await user();
  await earnWins(player, 3);
  const id = await world(),
    request = await admit(id, player);
  await expect(advance(id, 0, true)).rejects.toThrow('heritage-save-failure');
  expect((await invariant(player)).balance).toBe(6);
  expect(await db.general.findUnique({ where: { worldId_userId: { worldId: id, userId: player.id } } })).toBeNull();
  expect((await db.inputEvent.findFirstOrThrow({ where: { worldId: id, kind: 'general.create' } })).status).toBe(
    'PENDING',
  );
  await advance(id);
  expect((await request.result).data?.status).toBe('created');
  expect((await invariant(player)).balance).toBe(0);
}, 120000);

it('AC-P2-33 탈퇴 몰수와 뒤늦은 강제 종료 반환은 잔액을 되살리지 않는다', async () => {
  const password = 'Heritage-test-password-29!',
    passwordHash = await hashPassword(password),
    player = await user(passwordHash),
    administrator = await user();
  await earnWins(player, 4);
  const id = await world(),
    request = await admit(id, player);
  await advance(id);
  expect((await request.result).data?.status).toBe('created');
  expect((await invariant(player)).balance).toBe(2);
  await withdrawAccount(db, {
    userId: player.id,
    sessionId: player.sessionId,
    password,
    dummyPasswordHash: passwordHash,
  });
  expect((await invariant(player)).balance).toBe(0);
  await end(id, administrator);
  const result = await invariant(player);
  expect(result.balance).toBe(0);
  expect(
    result.entries
      .filter((entry) => entry.kind === 'FORFEIT')
      .map((entry) => entry.delta)
      .sort((a, b) => a - b),
  ).toEqual([-6, -2]);
  expect(result.entries.filter((entry) => entry.kind === 'CREATION_REFUND')).toHaveLength(1);
  expect((await rpc('heritage.mine', undefined, player)).status).toBe(401);
}, 120000);

it('AC-P2-33 끈 월드·잘못된 배분은 차감하지 않고 원장의 수정·삭제·음수 잔액을 막는다', async () => {
  const player = await user();
  await earnWins(player, 1);
  const id = await world({ enabled: false }),
    on = await world();
  expect((await rpc('general.mine', { worldId: id }, player)).data!.creationRules).not.toHaveProperty('heritage');
  expect((await rpc('general.create', payload(id), player)).status).toBe(400);
  expect((await rpc('general.create', { ...payload(on), expectedUserId: (await user()).id }, player)).status).toBe(409);
  expect((await rpc('general.create', { ...payload(on), heritage: { leadership: 4 } }, player)).error?.message).toBe(
    '유산 배분을 확인하세요.',
  );
  expect(await db.inputEvent.count({ where: { worldId: { in: [id, on] }, kind: 'general.create' } })).toBe(0);
  const entry = (await invariant(player)).entries[0]!;
  await expect(sql.query('UPDATE "HeritageEntry" SET delta=1 WHERE id=$1', [String(entry.id)])).rejects.toMatchObject({
    code: '55000',
  });
  await expect(sql.query('DELETE FROM "HeritageEntry" WHERE id=$1', [String(entry.id)])).rejects.toMatchObject({
    code: '55000',
  });
  await expect(
    sql.query('UPDATE "HeritageAccount" SET balance=-1 WHERE "userId"=$1', [player.id]),
  ).rejects.toMatchObject({ code: '23514' });
  expect((await invariant(player)).balance).toBe(2);
}, 120000);

it('AC-P2-33 정상 종료의 지급을 직접 재호출해도 한 번만 지급하며 종료 기록도 중복 생성하지 못한다', async () => {
  const player = await user(),
    id = await world({ winner: player });
  await advance(id, 100);
  const result = await db.worldResult.findUniqueOrThrow({ where: { worldId: id } }),
    generals = await db.general.findMany({ where: { worldId: id }, select: { userId: true, nationId: true } });
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${id} FOR UPDATE`;
    const repository = new PgHeritageRepository(tx),
      season = { ...result, generals };
    await creditHeritageSeason(repository, season);
    await creditHeritageSeason(repository, season);
  });
  await expect(db.worldResult.create({ data: result })).rejects.toMatchObject({ code: 'P2002' });
  const ledger = await invariant(player);
  expect(ledger.balance).toBe(2);
  expect(ledger.entries).toHaveLength(1);
}, 120000);

it('AC-P2-33 반환을 다른 요청 번호로 다시 호출해도 최초 사용분만 한 번 반환한다', async () => {
  const player = await user();
  await earnWins(player, 3);
  const id = await world(),
    request = await admit(id, player);
  await advance(id);
  expect((await request.result).data?.status).toBe('created');
  await end(id, player);
  const before = await invariant(player);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${id} FOR UPDATE`;
    const repository = new PgHeritageRepository(tx);
    await refundHeritageCreations(repository, id, 'ADMIN_END', { requestId: randomUUID() });
    await refundHeritageCreations(repository, id, 'ADMIN_END', { requestId: randomUUID() });
  });
  const after = await invariant(player);
  expect(after.balance).toBe(6);
  expect(after.entries).toEqual(before.entries);
  expect(after.entries.filter((entry) => entry.kind === 'CREATION_REFUND')).toHaveLength(1);
}, 120000);

it('AC-P2-33 최근 20개 기록만 최신 순서로 보이며 월드를 지워도 계정 원장과 잔액을 보존한다', async () => {
  const player = await user();
  await earnWins(player, 21);
  const entries = await db.heritageEntry.findMany({ where: { userId: player.id }, orderBy: { id: 'desc' } }),
    deletedWorld = entries[0]!.worldId!;
  await db.world.delete({ where: { id: deletedWorld } });
  const mine = await rpc('heritage.mine', undefined, player);
  expect(mine.status).toBe(200);
  expect(mine.data!.balance).toBe(42);
  expect(mine.data!.entries.map((entry) => entry.id)).toEqual(entries.slice(0, 20).map((entry) => String(entry.id)));
  expect(mine.data!.entries[0]).toMatchObject({ worldId: deletedWorld, worldName: null, delta: 2 });
  expect((await invariant(player)).entries).toHaveLength(21);
}, 120000);

it('AC-P2-33 탈퇴 뒤 통일된 국가의 장수라도 새 기수 보상을 받지 않는다', async () => {
  const password = 'Heritage-withdrawn-password-29!',
    passwordHash = await hashPassword(password),
    player = await user(passwordHash),
    id = await world({ winner: player });
  await withdrawAccount(db, {
    userId: player.id,
    sessionId: player.sessionId,
    password,
    dummyPasswordHash: passwordHash,
  });
  await advance(id, 100);
  expect((await db.worldResult.findUniqueOrThrow({ where: { worldId: id } })).reason).toBe('UNIFIED');
  expect(await invariant(player)).toEqual({ balance: 0, entries: [] });
}, 120000);

it('AC-P2-33 기본 방침만 직접 바꾼 12개월도 활동으로 세고 형식·방침 없는 유산 월드는 저장하지 못한다', async () => {
  const player = await user(),
    id = await world({ actor: player, endYear: 191 });
  for (let month = 0; month < 12; month++) {
    await db.inputEvent.create({
      data: {
        worldId: id,
        userId: player.id,
        generalId: 1,
        kind: 'general.setPolicy',
        idempotencyKey: randomUUID(),
        status: 'PENDING',
        payload: { policy: 'none' },
      },
    });
    await advance(id, month * TICKS_PER_MONTH);
    await advance(id, (month + 1) * TICKS_PER_MONTH);
  }
  expect((await db.worldResult.findUniqueOrThrow({ where: { worldId: id } })).reason).toBe('END_YEAR');
  const rows = await db.inputEvent.findMany({ where: { worldId: id, kind: 'general.setPolicy' } });
  expect(rows).toHaveLength(12);
  expect(
    rows.every(
      (row) =>
        row.status === 'APPLIED' &&
        (row.tick !== null || typeof (row.result as { activeTick?: unknown })?.activeTick === 'number'),
    ),
    JSON.stringify(rows.map(({ status, tick, result }) => ({ status, tick, result }))),
  ).toBe(true);
  expect((await invariant(player)).balance).toBe(1);
  await expect(sql.query('UPDATE "World" SET "replayFormat"=2 WHERE id=$1', [id])).rejects.toMatchObject({
    code: '23514',
  });
  await expect(
    sql.query('UPDATE "World" SET "ruleFeatures"=ARRAY[\'heritage-v1\']::text[] WHERE id=$1', [id]),
  ).rejects.toMatchObject({ code: '23514' });
}, 120000);

it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
  'AC-P2-33 탈퇴와 관리자 반환 경합 %i: 순서와 무관하게 잔액 0과 반환 한 건을 보존한다',
  async () => {
    const password = 'Heritage-race-password-29!',
      passwordHash = await hashPassword(password),
      player = await user(passwordHash),
      administrator = await user();
    await earnWins(player, 3);
    const id = await world(),
      request = await admit(id, player);
    await advance(id);
    expect((await request.result).data?.status).toBe('created');
    await Promise.all([
      withdrawAccount(db, {
        userId: player.id,
        sessionId: player.sessionId,
        password,
        dummyPasswordHash: passwordHash,
      }),
      end(id, administrator),
    ]);
    const ledger = await invariant(player);
    expect(ledger.balance).toBe(0);
    expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_REFUND')).toHaveLength(1);
    expect(
      ledger.entries.filter((entry) => entry.kind === 'FORFEIT').reduce((sum, entry) => sum + entry.delta, 0),
    ).toBe(-6);
    expect(ledger.entries.filter((entry) => entry.kind === 'SEASON_CREDIT')).toHaveLength(3);
  },
  120000,
);

it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
  'AC-P2-33 다른 월드의 생성과 반환 경합 %i: 반환분을 한 번만 쓰고 음수 잔액을 만들지 않는다',
  async () => {
    const player = await user();
    await earnWins(player, 3);
    const original = await world(),
      first = await admit(original, player);
    await advance(original);
    expect((await first.result).data?.status).toBe('created');
    const next = await world(),
      second = await admit(next, player);
    await Promise.all([advance(next), end(original, player)]);
    const response = await second.result,
      created = response.data?.status === 'created',
      ledger = await invariant(player);
    if (!created) expect(response).toMatchObject({ status: 409, error: { message: '유산 포인트가 부족합니다.' } });
    expect(ledger.balance).toBe(created ? 0 : 6);
    expect(
      ledger.entries.filter((entry) => entry.kind === 'CREATION_REFUND' && entry.worldId === original),
    ).toHaveLength(1);
    expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_SPEND' && entry.worldId === next)).toHaveLength(
      created ? 1 : 0,
    );
  },
  120000,
);

it.each(Array.from({ length: 20 }, (_, index) => index))(
  'AC-P2-33 생성 적용 전후의 닫기 경계 %i: 미적용은 차감하지 않고 적용분만 반환한다',
  async (index) => {
    const player = await user(),
      administrator = await user();
    await earnWins(player, 3);
    const id = await world(),
      request = await admit(id, player),
      applied = index % 2 === 0;
    if (applied) {
      await advance(id);
      expect((await request.result).data?.status).toBe('created');
    }
    await end(id, administrator);
    const response = await request.result,
      ledger = await invariant(player);
    if (!applied) expect(response.data?.status).not.toBe('created');
    expect(ledger.balance).toBe(6);
    expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_SPEND' && entry.worldId === id)).toHaveLength(
      applied ? 1 : 0,
    );
    expect(ledger.entries.filter((entry) => entry.kind === 'CREATION_REFUND' && entry.worldId === id)).toHaveLength(
      applied ? 1 : 0,
    );
    expect(ledger.entries.filter((entry) => entry.kind === 'SEASON_CREDIT' && entry.worldId === id)).toHaveLength(0);
  },
  120000,
);

it('유산 혜택은 확인한 가격으로 한 번만 결제하고 단계와 월말 재생을 보존한다', async () => {
  const player = await user();
  const other = await user();
  await earnWins(player, 2);
  const worldId = await world({ actor: player, benefits: true });
  const input = { worldId, expectedGeneralId: 1, expectedCost: 3, benefit: 'domesticSuccess', level: 2 };
  await authzCase('heritage.benefits', 'success', async () => {
    expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({ enabled: true, balance: 4 });
  })();
  await authzCase('heritage.benefits', 'otherUser', async () => {
    expect((await rpc('heritage.benefits', { worldId }, other)).status).toBe(404);
  })();
  await authzCase('heritage.purchase', 'otherUser', async () => {
    expect((await rpc('heritage.purchase', input, other)).status).toBe(404);
  })();
  expect((await rpc('heritage.purchase', { ...input, expectedCost: 2 }, player)).status).toBe(409);
  await authzCase('heritage.purchase', 'success', async () => {
    const first = await rpc('heritage.purchase', input, player);
    expect(first.data).toMatchObject({ status: 'pending' });
    expect((await rpc('heritage.purchase', input, player)).data).toEqual(first.data);
  })();
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    balance: 4,
    latest: { status: 'PENDING' },
  });
  await advance(worldId, 0);
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    balance: 1,
    options: expect.arrayContaining([expect.objectContaining({ benefit: 'domesticSuccess', level: 2 })]),
    latest: { status: 'APPLIED' },
  });
  expect(
    (await rpc('heritage.mine', undefined, player)).data?.entries.filter(({ kind }) => kind === 'BENEFIT_SPEND'),
  ).toMatchObject([{ worldId, delta: -3 }]);
  expect((await rpc('heritage.purchase', input, player)).status).toBe(409);
  await advance(worldId, TICKS_PER_MONTH);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('전투 특기 유산의 확인 가격·중복 요청·초기화와 월말 적용을 저장한다', async () => {
  const player = await user();
  const other = await user();
  const worldId = await world({ actor: player, specialty: true });
  await db.heritageAccount.create({ data: { userId: player.id, balance: 6000 } });
  const reserve = {
    worldId,
    requestId: randomUUID(),
    expectedGeneralId: 1,
    expectedCost: 4000,
    action: { action: 'reserve', specialty: '기병' },
  };
  await authzCase('heritage.specialty', 'otherUser', async () => {
    expect((await rpc('heritage.specialty', reserve, other)).status).toBe(404);
  })();
  expect((await rpc('heritage.specialty', { ...reserve, expectedCost: 3999 }, player)).status).toBe(409);
  await authzCase('heritage.specialty', 'success', async () => {
    const first = await rpc('heritage.specialty', reserve, player);
    expect(first.status).toBe(200);
    expect((await rpc('heritage.specialty', reserve, player)).data).toEqual(first.data);
  })();
  await advance(worldId, 0);
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    balance: 2000,
    specialty: { current: '보병', next: '기병', resetCost: 1000 },
  });
  const reset = { ...reserve, requestId: randomUUID(), expectedCost: 1000, action: { action: 'reset' } };
  expect((await rpc('heritage.specialty', reset, player)).status).toBe(200);
  await advance(worldId, 0);
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    balance: 1000,
    specialty: { current: null, next: '기병' },
  });
  await advance(worldId, TICKS_PER_MONTH);
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    balance: 1000,
    specialty: { current: '기병', next: null },
  });
  expect(await db.heritageEntry.count({ where: { worldId, kind: 'BENEFIT_SPEND' } })).toBe(2);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it.each([false, true])('유산 능력치 초기화는 기수당 한 번 배분한다 (직접 배분 %s)', async (manual) => {
  const player = await user();
  const worldId = await world({ actor: player, specialty: true });
  if (manual) await db.heritageAccount.create({ data: { userId: player.id, balance: 1_000 } });
  const request = {
    worldId,
    requestId: randomUUID(),
    expectedGeneralId: 1,
    expectedCost: manual ? 1_000 : 0,
    stats: { leadership: 70, strength: 65, intel: 65 },
    ...(manual ? { bonus: { strength: 3 } } : {}),
  };
  await authzCase('heritage.statReset', 'otherUser', async () => {
    expect((await rpc('heritage.statReset', request, await user())).status).toBe(404);
  })();
  expect((await rpc('heritage.statReset', { ...request, stats: { ...request.stats, intel: 1 } }, player)).status).toBe(
    409,
  );
  await authzCase('heritage.statReset', 'success', async () => {
    const first = await rpc('heritage.statReset', request, player);
    expect(first.status).toBe(200);
    expect((await rpc('heritage.statReset', request, player)).data).toEqual(first.data);
  })();
  await advance(worldId);
  const { heritageStatReset, leadership, strength, intel } = await db.general.findUniqueOrThrow({
    where: { worldId_id: { worldId, id: 1 } },
  });
  expect(heritageStatReset).toBe(true);
  if (manual) expect([leadership, strength, intel]).toEqual([70, 68, 65]);
  else expect(leadership + strength + intel).toBeGreaterThanOrEqual(203);
  expect((await rpc('heritage.statReset', { ...request, requestId: randomUUID() }, player)).status).toBe(409);
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    balance: 0,
    statReset: { used: true },
  });
  expect(await db.heritageEntry.count({ where: { worldId, kind: 'BENEFIT_SPEND' } })).toBe(manual ? 1 : 0);
  await advance(worldId, TICKS_PER_MONTH);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('유산 턴 시간 초기화는 다음 턴을 유지하고 다다음 턴과 재생에 한 번 적용한다', async () => {
  const player = await user();
  const worldId = await world({ actor: player, specialty: true, turnTime: true });
  await db.heritageAccount.create({ data: { userId: player.id, balance: 3000 } });
  const request = { worldId, requestId: randomUUID(), expectedGeneralId: 1, expectedCost: 1000 };
  const buy = (input = request) => rpc('heritage.turnTime', input, player);
  await authzCase('heritage.turnTime', 'otherUser', async () => {
    expect((await rpc('heritage.turnTime', request, await user())).status).toBe(404);
  })();
  expect((await buy({ ...request, expectedCost: 999 })).status).toBe(409);
  await authzCase('heritage.turnTime', 'success', async () => {
    const first = await buy();
    expect(first.status).toBe(200);
    expect((await buy()).data).toEqual(first.data);
  })();
  expect((await buy({ ...request, requestId: randomUUID() })).status).toBe(409);
  await advance(worldId);
  const general = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  expect((await general()).nextTurnTick).toBe(100);
  const quote = (await rpc('heritage.benefits', { worldId }, player)).data;
  expect(quote).toMatchObject({ balance: 2000, turnTime: { cost: null, pendingTick: expect.any(Number) } });
  if (!quote?.enabled || quote.turnTime?.pendingTick == null) throw Error('새 턴 시간이 없습니다.');
  const pendingTick = quote.turnTime.pendingTick;
  expect(pendingTick).toBeGreaterThanOrEqual(TICKS_PER_MONTH);
  expect(pendingTick).not.toBe(TICKS_PER_MONTH + 100);
  await advance(worldId, 100);
  expect(await general()).toMatchObject({ nextTurnTick: pendingTick, heritageTurnTime: { resets: 1, offset: null } });
  await advance(worldId, TICKS_PER_MONTH * 2);
  expect((await general()).nextTurnTick).toBe(pendingTick + TICKS_PER_MONTH);
  expect(await db.heritageEntry.count({ where: { worldId, kind: 'BENEFIT_SPEND' } })).toBe(1);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 2)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('성장 특기 월드는 3년까지 기다렸다가 내정 특기와 예약 전투 특기를 함께 얻는다', async () => {
  const player = await user();
  const worldId = await world({ actor: player, specialty: 'growth' });
  await db.heritageAccount.create({ data: { userId: player.id, balance: 4000 } });
  const reply = await rpc(
    'heritage.specialty',
    {
      worldId,
      requestId: randomUUID(),
      expectedGeneralId: 1,
      expectedCost: 4000,
      action: { action: 'reserve', specialty: '기병' },
    },
    player,
  );
  expect(reply.status).toBe(200);
  await advance(worldId, TICKS_PER_MONTH);
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    specialty: { current: null, next: '기병' },
  });
  await advance(worldId, TICKS_PER_MONTH * 37);
  expect((await rpc('heritage.benefits', { worldId }, player)).data).toMatchObject({
    specialty: { current: '기병', next: null },
  });
  const logs = await db.generalLog.findMany({
    where: { worldId, generalId: 1, commandKey: 'specialty.growth' },
    orderBy: { ordinal: 'asc' },
  });
  expect(logs.map(({ text }) => text)).toEqual([expect.stringContaining('내정 특기'), '전투 특기 【기병】 습득']);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, archive.months.length)).toEqual(
    archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
  );
});

it('미접속 퇴장 시 미사용 특기 예약을 한 번만 반환한다', async () => {
  const player = await user();
  const worldId = await world({ actor: player, specialty: 'growth', inactive: true, turnTermMinutes: 1440 });
  await db.heritageAccount.create({ data: { userId: player.id, balance: 4000 } });
  expect(
    (
      await rpc(
        'heritage.specialty',
        {
          worldId,
          requestId: randomUUID(),
          expectedGeneralId: 1,
          expectedCost: 4000,
          action: { action: 'reserve', specialty: '기병' },
        },
        player,
      )
    ).status,
  ).toBe(200);
  await advance(worldId, 0);
  expect((await rpc('heritage.mine', undefined, player)).data?.balance).toBe(0);
  const { inactiveRemovalTick } = await import('../packages/rules/src/index');
  const exit = inactiveRemovalTick(0, 1440);
  await advance(worldId, exit);
  await advance(worldId, exit + TICKS_PER_MONTH);
  const ledger = (await rpc('heritage.mine', undefined, player)).data;
  expect(ledger?.balance).toBe(4000);
  expect(ledger?.entries.filter(({ kind }) => kind === 'SPECIALTY_REFUND')).toMatchObject([{ delta: 4000 }]);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, archive.months.length)).toEqual(
    archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
  );
}, 60_000);

for (const path of [
  'heritage.benefits',
  'heritage.purchase',
  'heritage.specialty',
  'heritage.turnTime',
  'heritage.statReset',
] as const) {
  for (const category of ['unauthenticated', 'sanctioned', 'invalidInput'] as const) {
    it(
      `유산 혜택 접근 경계 ${path} ${category}`,
      authzCase(path, category, async () => {
        const player = await user();
        if (category === 'sanctioned')
          await db.user.update({ where: { id: player.id }, data: { status: 'SANCTIONED' } });
        const worldId = await world({ actor: player, benefits: true });
        const input = {
          worldId: category === 'invalidInput' ? 1 : worldId,
          ...(path === 'heritage.purchase'
            ? { expectedGeneralId: 1, expectedCost: 1, benefit: 'evasion', level: 1 }
            : path === 'heritage.specialty'
              ? { requestId: randomUUID(), expectedGeneralId: 1, expectedCost: 1000, action: { action: 'reset' } }
              : path === 'heritage.turnTime'
                ? { requestId: randomUUID(), expectedGeneralId: 1, expectedCost: 1000 }
                : path === 'heritage.statReset'
                  ? {
                      requestId: randomUUID(),
                      expectedGeneralId: 1,
                      expectedCost: 0,
                      stats: { leadership: 55, strength: 55, intel: 55 },
                    }
                  : {}),
        };
        const result = await rpc(path, input, category === 'unauthenticated' ? undefined : player);
        expect(result.error?.data.code).toBe(category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED');
      }),
    );
  }
}
