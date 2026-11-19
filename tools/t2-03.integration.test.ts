import { hashState } from '../packages/shared/src/node/hashState';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveFixtureWorld as saveInitialWorld, attachFixtureOwners } from '../e2e/worldFixture';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { CREATION_ERRORS, nationRank, officerTitle, toGameDate } from '../packages/rules/src/index';
import { loadPreset } from '../apps/engine/src/world/resources';
import { prepareSeasonWorld, finishSeasonWorld } from '../apps/engine/test/seasonFixture';
import { ciGreenDatabaseName, testDatabaseUrl } from './test-database';
import { confirmDisconnectedDatabase } from './test-db-close';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const sourceUrl = testDatabaseUrl({ TEST_DATABASE_URL: url });
for (const key of sourceUrl.searchParams.keys())
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    throw new Error('connection target overrides are forbidden');
const databaseName = ciGreenDatabaseName(`opensamguk_ci_green_${randomUUID().replaceAll('-', '').slice(0, 20)}_test`);
const targetUrl = new URL(sourceUrl);
targetUrl.pathname = '/' + databaseName;
testDatabaseUrl({
  TEST_DATABASE_URL: targetUrl.href,
  ...(!process.env.CI_GREEN_DATABASE ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
});
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = '/postgres';
type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
const admin = new Client({ connectionString: adminUrl.href });
const migrationClient = new Client({ connectionString: targetUrl.href });
const db = createDb(targetUrl.href);
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let created = false;
let databaseOid: string | undefined;
const worlds: string[] = [];
const fixturePreparations = new Set<ReturnType<typeof saveInitialWorld>>();
const users: string[] = [];
const notices: string[] = [];
const payload = {
  name: '로비장수',
  leadership: 55,
  strength: 55,
  intel: 55,
  sex: 'MALE' as const,
  politics: 55,
  charm: 55,
  portraitId: 10001,
};
type Status = 'RUNNING' | 'PREOPEN' | 'PAUSED' | 'ENDED';
type Row = {
  id: string;
  name: string;
  status: Status;
  presetName: string | null;
  scenarioTitle: string;
  startYear: number;
  gameDate: { year: number; month: number };
  turnTermMinutes: number;
  startedAt: string | null;
  humanGenerals: number;
  winner: { name: string; color: string } | null;
  myGeneral: { id: number; name: string; nationName: string | null } | null;
  createBlockedReason: string | null;
};
let address: string;
async function call<T = unknown>(path: string, input?: unknown, cookie?: string) {
  const mutation = path === 'general.create';
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${address}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(cookie ? { cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const text = await response.text();
  const item = JSON.parse(text)[0] as {
    result?: { data: T };
    error?: { message: string; data: { code: string } };
  };
  return {
    status: response.status,
    data: item.result?.data,
    code: item.error?.data.code,
    message: item.error?.message,
    text,
  };
}
async function identity() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, passwordHash: 'fixture-only' } });
  users.push(user.id);
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { id: user.id, cookie: `sid=${session.token}` };
}
async function fixture(status: Status = 'RUNNING', userId?: string) {
  const initial = await monthlyFixture();
  if (userId) initial.generals[0]!.userId = userId;
  const { worldId } = await saveInitialWorld(db, initial, { name: '로비 시험', turnTermMinutes: 60, endYear: null });
  worlds.push(worldId);
  await db.world.update({
    where: { id: worldId },
    data: {
      status,
      ...(status === 'RUNNING' ? { clockAnchorAt: new Date() } : {}),
      ...(status === 'PREOPEN' ? {} : { startedAt: new Date('2026-10-23T01:00:00Z') }),
    },
  });
  return { worldId, initial };
}
async function enqueue(worldId: string, userId: string, value: unknown = payload) {
  return db.inputEvent.create({
    data: {
      worldId,
      userId,
      kind: 'general.create',
      idempotencyKey: randomUUID(),
      payload: value as Prisma.InputJsonValue,
    },
  });
}
async function untilPending(worldId: string, count = 1) {
  const deadline = performance.now() + 5000;
  while ((await db.inputEvent.count({ where: { worldId, status: 'PENDING' } })) !== count) {
    if (performance.now() > deadline) throw new Error('생성 접수를 확인하지 못했습니다.');
    await delay(10);
  }
}
beforeAll(async () => {
  await admin.connect();
  expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [databaseName])).rows).toHaveLength(0);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const identity = await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [databaseName]);
  expect(identity.rows).toHaveLength(1);
  databaseOid = String(identity.rows[0]!.oid);
  await migrationClient.connect();
  const root = new URL('../packages/db/prisma/migrations/', import.meta.url);
  for (const migration of (await readdir(root)).filter((value) => /^\d{14}_/.test(value)).sort())
    await migrationClient.query(await readFile(new URL(migration + '/migration.sql', root), 'utf8'));
  await migrationClient.end();
  const content = { id: 'engine-monthly-fixture', title: '월간 합성 시험' };
  const season = { id: 'engine-season-fixture', title: '종료 합성 시험' };
  for (const value of [content, season])
    await db.gameResource.upsert({
      where: { kind_name_version: { kind: 'SCENARIO', name: value.id, version: 1 } },
      create: {
        kind: 'SCENARIO',
        name: value.id,
        version: 1,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        content: value,
        contentHash: hashState(value),
        source: '시험 합성 시나리오',
      },
      update: {},
    });
  app = await buildServer({ db, logging: false });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await Promise.allSettled(fixturePreparations);
  await db.notice.deleteMany({ where: { id: { in: notices.splice(0) } } });
  await db.world.deleteMany({ where: { id: { in: worlds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(async () => {
  const errors: unknown[] = [];
  await Promise.allSettled(fixturePreparations);
  for (const close of [() => app?.close(), () => migrationClient.end(), () => db.$disconnect()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  let connections: number | undefined;
  let dropped = false;
  try {
    if (created) {
      if (!databaseOid) throw new Error('missing owned database identity');
      ({ connections } = await confirmDisconnectedDatabase(admin, databaseName, databaseOid));
      if (!errors.length) {
        await admin.query(`DROP DATABASE "${databaseName}"`);
        dropped = true;
        expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [databaseName])).rows).toHaveLength(
          0,
        );
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
    JSON.stringify({ event: 't203-cleanup', databaseName, databaseOid, connections, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError(errors, 'T2-03 database cleanup failed');
});

describe('T2-03 실제 로비 HTTP·PostgreSQL', () => {
  it('상태·시작 시각·id 순으로 정렬하고 종료 월드는 요청할 때만 공개한다', async () => {
    const ids: string[] = [];
    for (const status of ['ENDED', 'PAUSED', 'PREOPEN', 'RUNNING', 'RUNNING', 'RUNNING'] as const) {
      ids.push((await fixture(status)).worldId);
    }
    await db.world.update({ where: { id: ids[5]! }, data: { startedAt: new Date('2026-10-23T02:00:00Z') } });
    const hidden = await call<Row[]>('lobby.worlds', {});
    const all = await call<Row[]>('lobby.worlds', { includeEnded: true });
    expect(hidden.status).toBe(200);
    expect(hidden.data!.map((row) => row.id)).toEqual([ids[5], ...[ids[3]!, ids[4]!].sort(), ids[2], ids[1]]);
    expect(all.data!.map((row) => row.id)).toEqual([...hidden.data!.map((row) => row.id), ids[0]]);
    const preopen = hidden.data!.find((row) => row.id === ids[2])!;
    expect(preopen.startedAt).toBeNull();
    expect(preopen.gameDate).toEqual({ year: preopen.startYear, month: 1 });
  });

  it('공개 키만 내고 실제 시나리오 이름·게임 연월·사람 장수만 센다', async () => {
    const user = await identity();
    const { worldId } = await fixture('RUNNING', user.id);
    const pendingUser = await identity();
    await enqueue(worldId, pendingUser.id);
    const world = await db.world.update({ where: { id: worldId }, data: { clockTick: 15000 } });
    const result = await call<Row[]>('lobby.worlds');
    const row = result.data![0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'name',
        'status',
        'presetName',
        'scenarioTitle',
        'startYear',
        'gameDate',
        'turnTermMinutes',
        'startedAt',
        'humanGenerals',
        'capacity',
        'registrationClosed',
        'npcGenerals',
        'nations',
        'settingsSummary',
        'upcomingPreopen',
        'joinModes',
        'winner',
        'myGeneral',
        'createBlockedReason',
      ].sort(),
    );
    expect(row.scenarioTitle).toBe('월간 합성 시험');
    expect(row.gameDate).toEqual(toGameDate(world.startYear, world.clockTick));
    expect(row.humanGenerals).toBe(1);
    expect(row.winner).toBeNull();
    expect(row.presetName).toBeNull();
    expect(row.myGeneral).toBeNull();
    expect(result.text).not.toContain(world.seed);
  });

  it.each(['END_YEAR', 'UNIFIED'] as const)('실제 엔진이 기록한 종료 연월과 승자 (%s)', async (reason) => {
    const user = await identity();
    const { worldId } = await prepareSeasonWorld(db, reason);
    worlds.push(worldId);
    const ended = await finishSeasonWorld(db, worldId);
    const lobby = await call<Row[]>('lobby.worlds', { includeEnded: true }, user.cookie);
    const summary = await call<{ gameDate: { year: number; month: number } }>(
      'world.summary',
      { worldId },
      user.cookie,
    );
    const row = lobby.data!.find((world) => world.id === worldId)!;
    expect(row.status).toBe('ENDED');
    expect(row.winner).toEqual(ended.winnerName === null ? null : { name: ended.winnerName, color: ended.winnerColor });
    expect(row.gameDate).toEqual({ year: ended.endedYear, month: ended.endedMonth });
    expect(row.gameDate).toEqual(summary.data!.gameDate);
    expect(row.gameDate.month).toBe(reason === 'END_YEAR' ? 12 : 1);
  });

  for (const status of ['RUNNING', 'PREOPEN', 'PAUSED', 'ENDED'] as const) {
    for (const kind of ['none', 'own', 'pending'] as const) {
      it(`${status}·${kind}의 생성 판정을 실제 HTTP로 읽는다`, async () => {
        const user = await identity();
        const { worldId, initial } = await fixture(status, kind === 'own' ? user.id : undefined);
        if (kind === 'pending') await enqueue(worldId, user.id);
        const result = await call<Row[]>('lobby.worlds', { includeEnded: true }, user.cookie);
        const row = result.data!.find((value) => value.id === worldId)!;
        const reasons = {
          RUNNING: kind === 'pending' ? '장수를 만드는 중입니다' : null,
          PREOPEN: '아직 열리지 않은 월드입니다',
          PAUSED: '멈춘 월드입니다',
          ENDED: '끝난 월드입니다',
        };
        expect(row.createBlockedReason).toBe(kind === 'own' ? null : reasons[status]);
        const general = initial.generals[0]!;
        expect(row.myGeneral).toEqual(
          kind === 'own'
            ? {
                id: 1,
                name: general.name,
                nationName: initial.nations[0]!.name,
                nationColor: initial.nations[0]!.color,
                portraitId: general.portraitId ?? null,
                cityName: initial.cities.find((city) => city.cityKey === general.cityKey)!.name,
                officerTitle: officerTitle(general.officerLevel),
                courtTitle:
                  nationRank(initial.nations[0]!.level)?.offices.find(
                    (office) => office.officerLevel === general.officerLevel,
                  )?.title ?? null,
                stats: {
                  leadership: general.leadership,
                  strength: general.strength,
                  intel: general.intel,
                  politics: general.politics,
                  charm: general.charm,
                },
              }
            : null,
        );
      });
    }
  }

  it('재야 장수의 nationName은 null이다', async () => {
    const user = await identity();
    const { worldId } = await fixture('RUNNING', user.id);
    await db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { nationId: null } });
    const result = await call<Row[]>('lobby.worlds', {}, user.cookie);
    expect(result.data![0]!.myGeneral!.nationName).toBeNull();
  });

  // 60개 계정 재사용·20건씩 처리해도 10개 월드·소유자 입력 600건 준비 실측 133.7초.
  // 준비 포함 한도는 180초이며 아래 실제 HTTP 응답의 50ms 기준은 유지한다.
  it('월드 10개·사람 장수 600명에서 목록 응답이 50ms 미만이다', async ({ signal }) => {
    const preparationStart = performance.now();
    const accounts = await Promise.all(Array.from({ length: 60 }, () => identity()));
    console.info(`T2-03 accounts preparation: ${(performance.now() - preparationStart).toFixed(2)}ms`);
    const source = await monthlyFixture();
    for (let index = 0; index < 10; index++) {
      signal.throwIfAborted();
      const worldStart = performance.now();
      const initial = structuredClone(source);
      const template = initial.generals[0]!;
      initial.generals = accounts.map((_, i) => ({ ...template, id: i + 1, userId: null, name: `장수${i}` }));
      const preparing = (async () => {
        const saved = await saveInitialWorld(db, initial, {
          name: `성능 월드${index}`,
          turnTermMinutes: 60,
          endYear: null,
        });
        worlds.push(saved.worldId);
        // 600개의 실제 입력은 유지하되 한 준비 트랜잭션에 20개씩만 넣는다.
        for (let first = 0; first < accounts.length; first += 20) {
          signal.throwIfAborted();
          await attachFixtureOwners(
            db,
            saved.worldId,
            accounts.slice(first, first + 20).map((user, offset) => ({ id: first + offset + 1, userId: user.id })),
          );
        }
        return saved;
      })();
      fixturePreparations.add(preparing);
      const settled = () => fixturePreparations.delete(preparing);
      void preparing.then(settled, settled);
      await preparing;
      console.info(
        `T2-03 world ${index} preparation (60 owner inputs): ${(performance.now() - worldStart).toFixed(2)}ms`,
      );
    }
    signal.throwIfAborted();
    console.info(`T2-03 total preparation: ${(performance.now() - preparationStart).toFixed(2)}ms`);
    // 배포 리소스 캐시를 채운 뒤 실제 HTTP 왕복 시간을 잰다.
    expect((await call<Row[]>('lobby.worlds', {}, accounts[0]!.cookie)).data).toHaveLength(10);
    const measurements: number[] = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      const response = await call<Row[]>('lobby.worlds', {}, accounts[0]!.cookie);
      measurements.push(performance.now() - start);
      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(10);
      expect(response.data!.every((row) => row.humanGenerals === 60 && row.myGeneral?.id === 1)).toBe(true);
    }
    console.info(`T2-03 HTTP 10 worlds/600 generals: ${measurements.map((ms) => ms.toFixed(2)).join(', ')}ms`);
    expect(Math.max(...measurements)).toBeLessThan(50);
  }, 180_000);

  it('프리셋 사본의 이름을 읽고 레거시 null을 유지한다', async () => {
    const initial = await monthlyFixture();
    const preset = await loadPreset('regular');
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '정규 프리셋',
      turnTermMinutes: preset.turnTermMinutes,
      endYear: null,
      preset: { key: 'regular', value: preset },
    });
    worlds.push(worldId);
    const legacy = await fixture();
    const result = await call<Row[]>('lobby.worlds');
    expect(result.data!.find((row) => row.id === worldId)!.presetName).toBe('정규');
    expect(result.data!.find((row) => row.id === legacy.worldId)!.presetName).toBeNull();
    await db.world.update({ where: { id: worldId }, data: { preset: { name: '' } } });
    expect((await call('lobby.worlds')).code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('없는 시나리오의 키와 경로를 HTTP 오류에서 숨긴다', async () => {
    const { worldId } = await fixture();
    await db.world.update({ where: { id: worldId }, data: { scenarioKey: 'scenario_191' } });
    const result = await call('lobby.worlds');
    expect(result.code).toBe('INTERNAL_SERVER_ERROR');
    expect(result.message).toBe('요청을 처리하지 못했습니다.');
    expect(result.text).not.toMatch(/scenario_191|resources|ENOENT/);
  });

  for (const status of ['PAUSED', 'ENDED', 'PREOPEN', 'RUNNING'] as const) {
    it(`L4 기존 장수·${status}·잘못된 입력은 접수와 엔진 모두 ALREADY_EXISTS다`, async () => {
      const user = await identity();
      const { worldId } = await fixture(status, user.id);
      const invalid = { ...payload, leadership: 0, name: '!', portraitId: 0 };
      const response = await call('general.create', { worldId, ...invalid }, user.cookie);
      expect(response.code).toBe('CONFLICT');
      expect(response.message).toBe(CREATION_ERRORS.ALREADY_EXISTS);
      expect(await db.inputEvent.count({ where: { worldId, kind: 'general.create' } })).toBe(0);
      const event = await enqueue(worldId, user.id, invalid);
      if (status === 'RUNNING') await db.user.update({ where: { id: user.id }, data: { status: 'SANCTIONED' } });
      const lease = (await acquireLease(db, worldId))!;
      try {
        await new TurnLoop(db, lease).advanceTo(0);
      } finally {
        await releaseLease(db, lease);
      }
      expect(await db.inputEvent.findUnique({ where: { id: event.id } })).toMatchObject({
        status: 'REJECTED',
        result: { code: 'ALREADY_EXISTS', message: CREATION_ERRORS.ALREADY_EXISTS },
      });
      expect(await db.general.count({ where: { worldId, userId: user.id } })).toBe(1);
    });
  }

  it.each(['PAUSED', 'PREOPEN', 'ENDED'] as const)(
    '장수 없는 %s 월드의 잘못된 입력은 접수와 엔진 모두 WORLD_CLOSED다',
    async (status) => {
      const user = await identity();
      const { worldId } = await fixture(status);
      const invalid = { ...payload, leadership: 0, name: '!' };
      expect((await call('general.create', { worldId, ...invalid }, user.cookie)).message).toBe(
        CREATION_ERRORS.WORLD_CLOSED,
      );
      expect(await db.inputEvent.count({ where: { worldId } })).toBe(0);
      const event = await enqueue(worldId, user.id, invalid);
      const lease = (await acquireLease(db, worldId))!;
      try {
        await new TurnLoop(db, lease).advanceTo(0);
      } finally {
        await releaseLease(db, lease);
      }
      expect(await db.inputEvent.findUnique({ where: { id: event.id } })).toMatchObject({
        status: 'REJECTED',
        result: { code: 'WORLD_CLOSED' },
      });
    },
  );

  it('같은 접수는 한 행이고 다른 내용은 충돌하며 엔진 생성 뒤 mine으로 회수한다', async () => {
    const user = await identity();
    const { worldId } = await fixture();
    const first = call('general.create', { worldId, ...payload }, user.cookie);
    await untilPending(worldId);
    const second = call('general.create', { worldId, ...payload }, user.cookie);
    const conflict = await call('general.create', { worldId, ...payload, name: '다른장수' }, user.cookie);
    expect(conflict.code).toBe('CONFLICT');
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
    const pending = await call<Row[]>('lobby.worlds', {}, user.cookie);
    expect(pending.data![0]!.createBlockedReason).toBe('장수를 만드는 중입니다');
    const lease = (await acquireLease(db, worldId))!;
    try {
      await new TurnLoop(db, lease).advanceTo(0);
    } finally {
      await releaseLease(db, lease);
    }
    const responses = await Promise.all([first, second]);
    for (const response of responses)
      expect(response.data).toMatchObject({ status: 'created', general: { name: payload.name } });
    expect((await call('general.mine', { worldId }, user.cookie)).data).toMatchObject({
      general: { name: payload.name },
      creation: null,
    });
    expect((await call('general.create', { worldId, ...payload }, user.cookie)).message).toBe(
      CREATION_ERRORS.ALREADY_EXISTS,
    );
  });

  it('접수 뒤 정지하면 생성하지 않고 WORLD_CLOSED를 저장한다', async () => {
    const user = await identity();
    const { worldId } = await fixture();
    const pending = call('general.create', { worldId, ...payload }, user.cookie);
    await untilPending(worldId);
    await db.world.update({ where: { id: worldId }, data: { status: 'PAUSED' } });
    const lease = (await acquireLease(db, worldId))!;
    try {
      await new TurnLoop(db, lease).advanceTo(0);
    } finally {
      await releaseLease(db, lease);
    }
    expect((await pending).message).toBe(CREATION_ERRORS.WORLD_CLOSED);
    expect(await db.general.count({ where: { worldId, userId: user.id } })).toBe(0);
  });

  it('로비 공지 20개를 시각·id 내림차순으로 주고 월드·고정 공지는 섞지 않는다', async () => {
    const { worldId } = await fixture();
    const time = new Date('2026-10-23T01:00:00Z');
    for (let index = 0; index < 22; index++) {
      const id = `lobby-${randomUUID()}`;
      notices.push(id);
      await db.notice.create({
        data: {
          id,
          scope: 'LOBBY',
          title: `공지${index}`,
          body: '로비 공지',
          publishedAt: index < 2 ? time : new Date(time.getTime() - index * 1000),
          pinned: index === 21,
        },
      });
    }
    await db.notice.create({
      data: { scope: 'WORLD', worldId, title: '월드 공지', body: '월드 한정', publishedAt: new Date() },
    });
    const result = await call<Array<{ id: string; title: string; body: string; publishedAt: string }>>('lobby.notices');
    const sorted = await db.notice.findMany({
      where: { id: { in: notices } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    expect(result.data).toEqual(
      sorted.map(({ id, title, body, publishedAt }) => ({ id, title, body, publishedAt: publishedAt.toISOString() })),
    );
    expect(Object.keys(result.data![0]!).sort()).toEqual(['id', 'title', 'body', 'publishedAt'].sort());
    await db.notice.update({ where: { id: sorted[0]!.id }, data: { title: null } });
    expect((await call('lobby.notices')).code).toBe('INTERNAL_SERVER_ERROR');
  });

  for (const category of ['success', 'unauthenticated', 'otherUser', 'sanctioned', 'invalidInput'] as const) {
    it(
      `lobby.worlds 권한 ${category}`,
      authzCase('lobby.worlds', category, async () => {
        const a = await identity(),
          b = await identity();
        const { worldId } = await fixture('RUNNING', a.id);
        if (category === 'sanctioned') await db.user.update({ where: { id: a.id }, data: { status: 'SANCTIONED' } });
        const cookie = category === 'unauthenticated' ? undefined : category === 'otherUser' ? b.cookie : a.cookie;
        const result = await call<Row[]>(
          'lobby.worlds',
          category === 'invalidInput' ? { includeEnded: 'yes' } : {},
          cookie,
        );
        if (category === 'invalidInput') {
          expect(result.code).toBe('BAD_REQUEST');
          return;
        }
        expect(result.status).toBe(200);
        const own = result.data!.find((row) => row.id === worldId)!.myGeneral;
        if (category === 'success') expect(own).toMatchObject({ id: 1 });
        else expect(own).toBeNull();
      }),
    );
  }
  for (const category of ['success', 'unauthenticated', 'sanctioned', 'invalidInput'] as const) {
    it(
      `lobby.notices 권한 ${category}`,
      authzCase('lobby.notices', category, async () => {
        const user = await identity();
        if (category === 'sanctioned') await db.user.update({ where: { id: user.id }, data: { status: 'SANCTIONED' } });
        const result = await call(
          'lobby.notices',
          category === 'invalidInput' ? { userId: user.id } : undefined,
          category === 'unauthenticated' ? undefined : user.cookie,
        );
        if (category === 'invalidInput') expect(result.code).toBe('BAD_REQUEST');
        else {
          expect(result.status).toBe(200);
          expect(result.data).toEqual([]);
        }
      }),
    );
  }
});
