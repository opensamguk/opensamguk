import { randomUUID } from 'node:crypto';
import { arch, cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { readFixture } from '../../test/readFixture';
import { buildServer } from '../server';
import type { AppRouter } from '../router';
import { newSession } from '../auth/session';

type Out = inferRouterOutputs<AppRouter>;
type Results = {
  'world.summary': Out['world']['summary'];
  'world.map': Out['world']['map'];
  'home.get': Out['home']['get'];
  'city.get': Out['city']['get'];
  'nation.get': Out['nation']['get'];
  'records.general': Out['records']['general'];
  'records.nation': Out['records']['nation'];
  'records.world': Out['records']['world'];
};
const routes = [
  'world.summary',
  'world.map',
  'home.get',
  'city.get',
  'nation.get',
  'records.general',
  'records.nation',
  'records.world',
] as const;
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_003;
const anchor = now - 603;
const app = await buildServer({ db, now: () => now, logging: false });
const users: Array<{ id: string; cookie: string }> = [];
let base: string;
let worldId: string;
let otherWorldId: string;
let state: Awaited<ReturnType<typeof readFixture>>;

async function query<R extends keyof Results>(
  route: R,
  input: unknown,
  cookie: string | null = users[0]!.cookie,
  method = 'GET',
) {
  const response = await fetch(
    `${base}/trpc/${route}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`,
    {
      method,
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(cookie ? { cookie } : {}),
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify({ 0: input }) } : {}),
    },
  );
  type Envelope = { result?: { data: Results[R] }; error?: { data: { code: string } } };
  const payload = (await response.json()) as Envelope | Envelope[];
  const body = Array.isArray(payload) ? payload[0]! : payload;
  return { status: response.status, data: body.result?.data as Results[R], error: body.error?.data.code };
}
const routeInput = (route: keyof Results, id = worldId) => ({
  worldId: id,
  ...(route === 'city.get' ? { cityKey: state.cities[0]!.cityKey } : {}),
  ...(route === 'nation.get' ? { nationId: 1 } : {}),
});

async function fixtureWorld(label: string) {
  const world = await db.world.create({
    data: {
      name: label,
      scenarioKey: state.scenarioKey,
      mapKey: state.mapKey,
      unitSetKey: state.unitSetKey,
      seed: state.seed,
      startYear: state.startYear,
      turnTermMinutes: 1,
      status: 'RUNNING',
      clockTick: 100,
      clockAnchorAt: new Date(anchor),
      initialStateHash: 'private-hash',
      statRules: {},
      unitSet: {},
    },
  });
  const id = world.id;
  await db.nation.createMany({
    data: state.nations.map((nation) => ({ ...nation, worldId: id, capitalCityKey: null })),
  });
  await db.city.createMany({ data: state.cities.map((city) => ({ ...city, worldId: id })) });
  for (const nation of state.nations)
    await db.nation.update({
      where: { worldId_id: { worldId: id, id: nation.id } },
      data: { capitalCityKey: nation.capitalCityKey },
    });
  await db.general.createMany({
    data: state.generals.map((general, index) => ({
      ...general,
      worldId: id,
      userId: index === 0 ? users[0]!.id : index === 2 ? users[1]!.id : index === 3 ? users[2]!.id : null,
    })),
  });
  await db.generalTurn.createMany({
    data: Array.from({ length: 30 }, (_, slot) => ({
      worldId: id,
      generalId: 1,
      slot,
      commandKey: 'rest',
      args: { label, slot },
    })),
  });
  await db.generalLog.createMany({
    data: state.generals.flatMap((general) =>
      Array.from({ length: 35 }, (_, index) => ({
        worldId: id,
        generalId: general.id,
        tick: (index + 1) * 10_000,
        commandKey: 'rest',
        kind: 'success',
        text: `${label}-actor-${general.id}-log-${index + 1}`,
      })),
    ),
  });
  const summary = (nationId: number) => ({
    nationId,
    cities: 1,
    generals: nationId === 1 ? 2 : 1,
    gold: 77000 + nationId,
    rice: 88000 + nationId,
    power: 999999,
  });
  await db.nationHistory.createMany({
    data: state.nations.flatMap((nation) =>
      Array.from({ length: 35 }, (_, index) => ({
        worldId: id,
        nationId: nation.id,
        tick: (index + 1) * 10_000,
        data: { ...summary(nation.id), events: [`${label}-monthly-event-${index + 1}`] },
      })),
    ),
  });
  // 사건이 LIMIT 31 앞·사이·뒤를 채워도 요약 페이지와 cursor는 바뀌지 않는다.
  await db.nationHistory.createMany({
    data: state.nations.flatMap((nation) =>
      [
        ...Array.from({ length: 40 }, (_, index) => 400000 + index),
        ...Array.from({ length: 35 }, (_, index) => (index + 1) * 10000 - 1),
        ...Array.from({ length: 40 }, (_, index) => index + 1),
      ].map((tick) => ({
        worldId: id,
        nationId: nation.id,
        tick,
        data: { events: [`${label}-nation-${nation.id}-event-${tick}`] },
      })),
    ),
  });
  await db.yearbookSnapshot.createMany({
    data: Array.from({ length: 35 }, (_, index) => ({
      worldId: id,
      tick: (index + 1) * 10_000,
      year: 191 + Math.floor(index / 12),
      month: (index % 12) + 1,
      sequence: index + 1,
      stateHash: 'private-state-hash',
      data: {
        nations: state.nations.map((nation) => summary(nation.id)),
        cities: state.cities.map(({ cityKey, nationId }) => ({ cityKey, nationId })),
      },
    })),
  });
  return id;
}

beforeAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  state = await readFixture();
  for (let index = 0; index < 4; index++) {
    const session = newSession(now);
    const user = await db.user.create({
      data: {
        email: `read-api-${index}@example.com`,
        passwordHash: 'not-used-for-session-auth',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    users.push({ id: user.id, cookie: `sid=${session.token}` });
  }
  worldId = await fixtureWorld('primary');
  otherWorldId = await fixtureWorld('other');
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany();
  await db.user.deleteMany();
  await db.$disconnect();
});

describe('T1-12 / AC-M1-19 실제 TCP HTTP·PostgreSQL 조회', () => {
  it('summary는 서버 시계로 연월·tick·tick 간격만 반환한다', async () => {
    expect(await query('world.summary', { worldId })).toEqual({
      status: 200,
      error: undefined,
      data: {
        name: 'primary',
        status: 'RUNNING',
        gameDate: { year: state.startYear, month: 1 },
        nowTick: 200,
        msPerTick: 6,
        turnTermMinutes: 1,
      },
    });
  });

  it('94도시 지도는 정렬한 공개 필드·연결·보급과 국가 색만 반환한다', async () => {
    const result = await query('world.map', { worldId });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      cities: state.cities.map((city) => ({
        key: city.cityKey,
        name: city.name,
        level: city.level,
        x: city.x,
        y: city.y,
        nationId: city.nationId,
        supplied: city.supplied,
        links: city.connections,
      })),
      nations: state.nations.map(({ id, name, color }) => ({ id, name, color })),
    });
    expect(result.data.cities).toHaveLength(94);
    for (const city of result.data.cities)
      for (const key of city.links) {
        expect(result.data.cities.find((other) => other.key === key)?.links).toContain(city.key);
      }
    for (const user of users.slice(1))
      expect((await query('world.map', { worldId }, user.cookie)).data).toEqual(result.data);
  });

  it('home은 본인 상세·도시·국가·예턴5개·개인 로그10개와 정확한 다음 시각을 반환한다', async () => {
    const { status, data } = await query('home.get', { worldId });
    expect(status).toBe(200);
    expect(Object.keys(data).sort()).toEqual(['city', 'general', 'nation', 'nextTurnAt', 'recentLogs', 'turnsPreview']);
    expect(data.general).toMatchObject({ id: 1, gold: 11001, rice: 12001, crew: 13001, train: 41, atmos: 51 });
    expect(data.city).toMatchObject({ population: state.cities[0]!.population });
    expect(data.nation).toMatchObject({
      id: 1,
      cityCount: 1,
      generalCount: 2,
      taxRate: 0.2,
      gold: state.nations[0]!.gold,
    });
    expect(data.nextTurnAt).toBe(new Date(anchor + 2400).toISOString());
    expect(data.turnsPreview).toEqual(
      Array.from({ length: 5 }, (_, slot) => ({ slot, commandKey: 'rest', args: { label: 'primary', slot } })),
    );
    expect(data.recentLogs.map((log) => log.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `primary-actor-1-log-${35 - index}`),
    );
    expect((await query('home.get', { worldId }, users[1]!.cookie)).data.general).toMatchObject({ id: 3, gold: 11003 });
    expect((await query('home.get', { worldId: otherWorldId })).data.recentLogs[0]!.text).toBe('other-actor-1-log-35');
    for (const field of ['userId', 'worldId', 'affinity', 'turnRevision', 'email', 'passwordHash'])
      expect(data.general).not.toHaveProperty(field);
  });

  it('도시 공개 범위와 주둔 장수 상세는 별도로 검사한다', async () => {
    const input = { worldId, cityKey: state.cities[0]!.cityKey };
    const ally = (await query('city.get', input)).data;
    expect(ally).toMatchObject({ population: state.cities[0]!.population, wall: state.cities[0]!.wall });
    expect(ally.generals.slice(0, 2)).toMatchObject([
      { id: 1, gold: 11001 },
      { id: 2, gold: 11002 },
    ]);
    expect(ally.generals.slice(2)).toEqual(
      state.generals.slice(2).map(({ id, name, nationId }) => ({ id, name, nationId })),
    );
    const resident = (await query('city.get', input, users[1]!.cookie)).data;
    expect(resident).toHaveProperty('population');
    expect(resident.generals[0]).toEqual({ id: 1, name: state.generals[0]!.name, nationId: 1 });
    for (const user of users) {
      const unseen = (await query('city.get', { worldId, cityKey: state.cities[2]!.cityKey }, user.cookie)).data;
      for (const field of [
        'population',
        'populationMax',
        'agriculture',
        'commerce',
        'security',
        'defence',
        'wall',
        'trust',
      ])
        expect(unseen).not.toHaveProperty(field);
    }
    const spectator = (await query('city.get', input, users[3]!.cookie)).data;
    expect(spectator).not.toHaveProperty('population');
    expect(spectator.generals).toEqual(state.generals.map(({ id, name, nationId }) => ({ id, name, nationId })));
  });

  it('적 국가·재야·미생성 계정은 국고·군량·세율·장수 상세를 받지 않는다', async () => {
    const enemy = (await query('nation.get', { worldId, nationId: 2 })).data;
    expect(Object.keys(enemy).sort()).toEqual([
      'cities',
      'cityCount',
      'color',
      'generalCount',
      'generals',
      'id',
      'name',
    ]);
    expect(enemy.generals).toEqual([{ id: 3, name: state.generals[2]!.name, nationId: 2 }]);
    expect(enemy.cities).toHaveLength(1);
    for (const user of users.slice(1)) {
      const nation = (await query('nation.get', { worldId, nationId: 1 }, user.cookie)).data;
      for (const field of ['gold', 'rice', 'taxRate', 'tech', 'capitalCityKey'])
        expect(nation).not.toHaveProperty(field);
      expect(nation.generals).toEqual(
        state.generals.slice(0, 2).map(({ id, name, nationId }) => ({ id, name, nationId })),
      );
    }
    const own = (await query('nation.get', { worldId, nationId: 1 })).data;
    expect(own).toMatchObject({ gold: state.nations[0]!.gold, rice: state.nations[0]!.rice, taxRate: 0.2 });
    expect(own.generals[1]).toMatchObject({ id: 2, gold: 11002, crew: 13002 });
    expect(own.cities[0]).not.toHaveProperty('population');
  });

  it('재야 home은 국가 null·본인 상세만 반환하고 없는 예턴을 휴식5개로 채운다', async () => {
    const { data } = await query('home.get', { worldId }, users[2]!.cookie);
    expect(data.nation).toBeNull();
    expect(data.general).toMatchObject({ id: 4, nationId: null, gold: 11004 });
    expect(data.turnsPreview).toEqual(Array.from({ length: 5 }, (_, slot) => ({ slot, commandKey: 'rest', args: {} })));
    expect((await query('records.nation', { worldId }, users[2]!.cookie)).data).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it.each(['PREOPEN', 'PAUSED', 'ENDED'] as const)(
    '%s는 다음 턴 시각을 만들지 않고 저장 tick만 읽는다',
    async (status) => {
      try {
        await db.world.update({ where: { id: worldId }, data: { status, clockTick: 12345 } });
        expect((await query('home.get', { worldId })).data.nextTurnAt).toBeNull();
        expect((await query('world.summary', { worldId })).data).toMatchObject({
          status,
          nowTick: 12345,
          gameDate: { year: state.startYear, month: 2 },
        });
      } finally {
        await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockTick: 100 } });
      }
    },
  );

  it.each(['records.general', 'records.nation', 'records.world'] as const)(
    '%s는 최신순 30개와 마지막 tick cursor로 중복 없이 끝까지 읽는다',
    async (route) => {
      const first = (await query(route, { worldId })).data;
      expect(first.items.map((row) => row.tick)).toEqual(
        Array.from({ length: 30 }, (_, index) => (35 - index) * 10_000),
      );
      expect(first.nextCursor).toBe('60000');
      const second = (await query(route, { worldId, cursor: first.nextCursor })).data;
      expect(second.items.map((row) => row.tick)).toEqual([50000, 40000, 30000, 20000, 10000]);
      expect(second.nextCursor).toBeNull();
      expect((await query(route, { worldId, cursor: '10000' })).data).toEqual({ items: [], nextCursor: null });
      expect(new Set([...first.items, ...second.items].map((row) => row.tick)).size).toBe(35);
      const exactPage = (await query(route, { worldId, cursor: '310000' })).data;
      expect(exactPage.items).toHaveLength(30);
      expect(exactPage.nextCursor).toBeNull();
    },
  );

  it('사건이 붙은 월간 요약은 허용 필드만 반환하고 사건 전용 국가는 빈 페이지다', async () => {
    const own = await query('records.nation', { worldId });
    expect(own.status).toBe(200);
    expect(own.data.items[0]).toEqual({
      tick: 350000,
      nationId: 1,
      cities: 1,
      generals: 2,
      gold: 77001,
      rice: 88001,
    });
    const eventWorld = await fixtureWorld('event-only');
    try {
      await db.nationHistory.deleteMany({ where: { worldId: eventWorld, tick: { gte: 10000, lte: 350000 } } });
      for (const cookie of [users[0]!.cookie, users[1]!.cookie, users[2]!.cookie]) {
        expect(await query('records.nation', { worldId: eventWorld }, cookie)).toEqual({
          status: 200,
          error: undefined,
          data: { items: [], nextCursor: null },
        });
      }
    } finally {
      await db.world.delete({ where: { id: eventWorld } });
    }
  });

  it('로그는 세션 장수·국가·월드 경계를 지키고 공개 연감은 국력·자원·해시를 빼낸다', async () => {
    for (const [index, id] of [
      [0, 1],
      [1, 3],
      [2, 4],
    ] as const) {
      const result = await query('records.general', { worldId }, users[index]!.cookie);
      expect(result.data.items.every((row) => row.text.startsWith(`primary-actor-${id}-`))).toBe(true);
      expect(typeof result.data.items[0]!.id).toBe('string');
    }
    const own = (await query('records.nation', { worldId })).data;
    expect(own.items.every((row) => row.nationId === 1 && row.gold === 77001 && row.rice === 88001)).toBe(true);
    const enemy = (await query('records.nation', { worldId }, users[1]!.cookie)).data;
    expect(enemy.items.every((row) => row.nationId === 2 && row.gold === 77002)).toBe(true);
    const publicRecords = (await query('records.world', { worldId }, users[3]!.cookie)).data;
    expect(publicRecords.items[0]).toEqual({
      tick: 350000,
      year: 193,
      month: 11,
      nations: [
        { nationId: 1, cities: 1, generals: 2 },
        { nationId: 2, cities: 1, generals: 1 },
      ],
      cities: state.cities.map(({ cityKey, nationId }) => ({ cityKey, nationId })),
    });
    expect(JSON.stringify(publicRecords)).not.toMatch(/gold|rice|power|stateHash|private/);
    const home = (await query('home.get', { worldId })).data;
    expect(home.recentLogs).toEqual((await query('records.general', { worldId })).data.items.slice(0, 10));
  });

  it('무인증·위조·만료 세션은 모든 조회에서 401이다', async () => {
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: users[0]!.id, expiresAt: new Date(now) } });
    for (const cookie of [null, 'sid=invalid', `sid=${session.token}`])
      for (const route of routes) {
        const result = await query(route, routeInput(route), cookie);
        expect([result.status, result.error, result.data]).toEqual([401, 'UNAUTHORIZED', undefined]);
      }
  });

  it('제재·탈퇴는 기존 세션으로도 모든 조회를 거부한다', async () => {
    try {
      for (const status of ['SANCTIONED', 'WITHDRAWN'] as const) {
        await db.user.update({ where: { id: users[0]!.id }, data: { status } });
        for (const route of routes) {
          const result = await query(route, routeInput(route));
          expect([result.status, result.error, result.data]).toEqual([401, 'UNAUTHORIZED', undefined]);
        }
      }
    } finally {
      await db.user.update({ where: { id: users[0]!.id }, data: { status: 'ACTIVE' } });
    }
  });

  it('타인·국가·사용자 ID를 추가해 권한을 고르거나 잘못된 입력을 넣으면 400이다', async () => {
    for (const route of routes) {
      for (const extra of [{ userId: users[1]!.id }, { generalId: 3 }, { actorId: 3 }, { limit: 100 }]) {
        expect((await query(route, { ...routeInput(route), ...extra })).status).toBe(400);
      }
      for (const input of [
        null,
        [],
        {},
        { ...routeInput(route), worldId: 'not-uuid' },
        { ...routeInput(route), worldId: 12 },
      ]) {
        expect((await query(route, input)).error).toBe('BAD_REQUEST');
      }
      expect((await query(route, routeInput(route), users[0]!.cookie, 'POST')).status).toBe(405);
    }
    for (const cursor of ['', '-1', '01', '1.5', '2147483648', '1e3', 1, null, {}, '9'.repeat(1000)]) {
      for (const route of ['records.general', 'records.nation', 'records.world'] as const)
        expect((await query(route, { worldId, cursor })).status).toBe(400);
    }
    for (const key of [0, -1, 1.5, '1', 2147483648, null]) {
      expect((await query('city.get', { worldId, cityKey: key })).status).toBe(400);
      expect((await query('nation.get', { worldId, nationId: key })).status).toBe(400);
    }
    expect((await query('records.general', { worldId, nationId: 2 })).status).toBe(400);
  });

  it('없는 월드·도시·국가와 미생성 장수는 404다', async () => {
    const missing = randomUUID();
    for (const route of routes) expect((await query(route, routeInput(route, missing))).status).toBe(404);
    expect((await query('city.get', { worldId, cityKey: 2147483647 })).status).toBe(404);
    expect((await query('nation.get', { worldId, nationId: 2147483647 })).status).toBe(404);
    for (const route of ['home.get', 'records.general', 'records.nation'] as const) {
      expect((await query(route, { worldId }, users[3]!.cookie)).status).toBe(404);
    }
  });

  it('커서 앞에 새 로그가 끼어도 다음 페이지와 개인 범위가 바뀌지 않는다', async () => {
    const first = (await query('records.general', { worldId })).data;
    try {
      await db.generalLog.create({
        data: { worldId, generalId: 1, tick: 999999, commandKey: 'rest', kind: 'success', text: 'new-personal-log' },
      });
      expect(
        (await query('records.general', { worldId, cursor: first.nextCursor })).data.items.map((row) => row.tick),
      ).toEqual([50000, 40000, 30000, 20000, 10000]);
      expect((await query('records.general', { worldId, cursor: '0' })).data).toEqual({ items: [], nextCursor: null });
    } finally {
      await db.generalLog.deleteMany({ where: { worldId, generalId: 1, tick: 999999 } });
    }
  });

  it('조회 전후 게임 상태·예턴·기록·InputEvent는 같다', async () => {
    const snapshot = async () =>
      Promise.all([
        db.world.findMany({ orderBy: { id: 'asc' } }),
        db.city.findMany({ orderBy: [{ worldId: 'asc' }, { cityKey: 'asc' }] }),
        db.nation.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
        db.general.findMany({ orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
        db.generalTurn.findMany({ orderBy: [{ worldId: 'asc' }, { generalId: 'asc' }, { slot: 'asc' }] }),
        db.generalLog.findMany({ orderBy: { id: 'asc' } }),
        db.inputEvent.findMany({ orderBy: { id: 'asc' } }),
        db.nationHistory.findMany({ orderBy: [{ worldId: 'asc' }, { nationId: 'asc' }, { tick: 'asc' }] }),
        db.yearbookSnapshot.findMany({ orderBy: [{ worldId: 'asc' }, { tick: 'asc' }] }),
      ]);
    const before = await snapshot();
    for (const route of routes) expect((await query(route, routeInput(route))).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('94도시 지도의 실제 TCP 요청 시간을 환경과 함께 측정한다', async () => {
    for (let index = 0; index < 3; index++) await query('world.map', { worldId });
    const samples: number[] = [];
    for (let index = 0; index < 20; index++) {
      const start = performance.now();
      expect((await query('world.map', { worldId })).data.cities).toHaveLength(94);
      samples.push(performance.now() - start);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const version = await db.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    console.info(
      'T1-12 map performance',
      JSON.stringify({
        transport: 'loopback TCP fetch + cookie auth + RepeatableRead + PostgreSQL + JSON parse',
        cities: 94,
        warmup: 3,
        samplesMs: samples,
        medianMs: sorted[10],
        p95Ms: sorted[18],
        minMs: sorted[0],
        target: 'one warm request < 50ms; median and individual samples reported',
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        database: version[0]!.version,
      }),
    );
    expect(samples[0]).toBeLessThan(50);
    expect(sorted[10]).toBeLessThan(50);
  });
});
