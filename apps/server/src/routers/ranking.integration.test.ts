import { randomUUID } from 'node:crypto';
import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { readFixture } from '../../test/readFixture';
import { newSession } from '../auth/session';
import type { AppRouter } from '../router';
import { buildServer } from '../server';

type Out = inferRouterOutputs<AppRouter>['ranking'];
type Results = { 'ranking.generals': Out['generals']; 'ranking.nations': Out['nations'] };
const routes = ['ranking.generals', 'ranking.nations'] as const;
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_003;
const app = await buildServer({ db, now: () => now, logging: false });
const users: Array<{ id: string; cookie: string }> = [];
const worlds: string[] = [];
const at = { tick: 10_000, year: 190, month: 2 };
let base: string;
let worldId: string;
let otherWorldId: string;
let emptyWorldId: string;
let state: Awaited<ReturnType<typeof readFixture>>;

const nationIdentity = { id: 1, name: '월초 국가', color: '#123456' };
const generalRows = Array.from({ length: 105 }, (_, index) => {
  const id = 105 - index;
  return {
    id,
    name: `월초 장수 ${id}`,
    nation: id === 105 ? null : nationIdentity,
    dedication: Math.floor((106 - id) / 2),
    experience: Math.floor(id / 2),
    wins: id % 7,
    captures: id % 5,
  };
});
const publicGeneral = ({ id, ...row }: (typeof generalRows)[number]) => ({ generalId: id, ...row });
const nationRows = [
  { id: 3, name: '셋째 국가', color: '#333333', cities: 1, generals: 12, power: 19 },
  { id: 2, name: '둘째 국가', color: '#222222', cities: 3, generals: 2, power: 19 },
  { ...nationIdentity, cities: 3, generals: 7, power: 24 },
];

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
      headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ 0: input }) } : {}),
    },
  );
  type Envelope = { result?: { data: Results[R] }; error?: { data: { code: string } } };
  const payload = (await response.json()) as Envelope | Envelope[];
  const body = Array.isArray(payload) ? payload[0]! : payload;
  return { status: response.status, data: body.result?.data as Results[R], error: body.error?.data.code };
}

const inputFor = (route: keyof Results, id = worldId) => ({
  worldId: id,
  by: route === 'ranking.generals' ? 'dedication' : 'cities',
});

async function fixtureWorld(label: string, snapshot: boolean, other = false) {
  const world = await db.world.create({
    data: {
      name: label,
      scenarioKey: state.scenarioKey,
      mapKey: state.mapKey,
      unitSetKey: state.unitSetKey,
      seed: state.seed,
      startYear: 190,
      turnTermMinutes: 1,
      status: 'PAUSED',
      clockTick: 19_999,
      monthlyTick: 10_000,
      initialStateHash: 'private-ranking-hash',
      statRules: {},
      unitSet: {},
    },
  });
  worlds.push(world.id);
  await db.nation.createMany({
    data: state.nations.map((nation) => ({ ...nation, worldId: world.id, capitalCityKey: null })),
  });
  await db.city.createMany({ data: state.cities.map((city) => ({ ...city, worldId: world.id })) });
  await db.general.createMany({
    data: generalRows.map((row) => ({
      ...state.generals[0]!,
      worldId: world.id,
      id: row.id,
      name: `실시간 장수 ${row.id}`,
      dedication: 50_000,
      experience: 60_000,
      userId: row.id === (other ? 1 : 105) ? users[0]!.id : row.id === (other ? 105 : 1) ? users[1]!.id : null,
    })),
  });
  if (snapshot)
    await db.rankingSnapshot.create({
      data: {
        worldId: world.id,
        ...at,
        generals: generalRows.map((row) => ({
          ...row,
          name: other ? `다른 월드 ${row.id}` : row.name,
          nation: row.nation ? { ...row.nation, gold: 987654, rice: 876543 } : null,
          userId: 'private-owner',
          gold: 765432,
          rice: 654321,
          crew: 543210,
          turns: [{ slot: 0, commandKey: 'private-order' }],
        })),
        nations: nationRows.map((row) => ({ ...row, name: other ? `다른 국가 ${row.id}` : row.name, gold: 432109 })),
      },
    });
  return world.id;
}

beforeAll(async () => {
  state = await readFixture();
  const runId = randomUUID();
  for (let index = 0; index < 3; index++) {
    const session = newSession(now);
    const user = await db.user.create({
      data: {
        email: `ranking-${runId}-${index}@example.com`,
        passwordHash: 'not-used-for-session-auth',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    users.push({ id: user.id, cookie: `sid=${session.token}` });
  }
  worldId = await fixtureWorld('순위 월드', true);
  otherWorldId = await fixtureWorld('다른 순위 월드', true, true);
  emptyWorldId = await fixtureWorld('첫 정산 전', false);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await db.$disconnect();
});

describe('T2-22 / AC-M2-19 실제 TCP HTTP·PostgreSQL 순위', () => {
  it.each(['dedication', 'experience', 'merit'] as const)(
    '장수 %s는 내림차순·동점 ID순·1부터 시작하는 순번으로 상위 100명을 반환한다',
    async (by) => {
      const result = await query('ranking.generals', { worldId, by });
      expect(result.status).toBe(200);
      expect(result.data.at).toEqual(at);
      expect(result.data.top).toHaveLength(100);
      const value = (row: (typeof generalRows)[number]) => (by === 'merit' ? row.wins + row.captures : row[by]);
      const expected = [...generalRows].sort((left, right) => value(right) - value(left) || left.id - right.id);
      expect(result.data.top).toEqual(
        expected.slice(0, 100).map((row, index) => ({
          ...publicGeneral(row),
          merit: row.wins + row.captures,
          value: value(row),
          rank: index + 1,
        })),
      );
      const ownIndex = expected.findIndex((row) => row.id === 105);
      expect(result.data.me).toEqual({
        ...publicGeneral(expected[ownIndex]!),
        merit: expected[ownIndex]!.wins + expected[ownIndex]!.captures,
        value: value(expected[ownIndex]!),
        rank: ownIndex + 1,
      });
    },
  );

  it('상위 100명 밖 내 순위도 반환하고 세션마다 본인 장수만 고른다', async () => {
    const input = { worldId, by: 'dedication' };
    const own = (await query('ranking.generals', input)).data;
    const other = (await query('ranking.generals', input, users[1]!.cookie)).data;
    const spectator = (await query('ranking.generals', input, users[2]!.cookie)).data;
    expect(own.me).toMatchObject({ generalId: 105, rank: 105, value: 0, nation: null });
    expect(own.top.some((row) => row.generalId === 105)).toBe(false);
    expect(other.me).toMatchObject({ generalId: 1, rank: 1, value: 52 });
    expect(spectator.me).toBeNull();
    expect(other.top).toEqual(own.top);
    expect(spectator.top).toEqual(own.top);
    expect(spectator.at).toEqual(at);
  });

  it('정산 뒤 생성되어 캐시에 없는 내 장수의 순위를 즉석에서 만들지 않는다', async () => {
    await db.general.create({
      data: {
        ...state.generals[0]!,
        worldId,
        id: 106,
        userId: users[2]!.id,
        name: '월중 생성 장수',
        dedication: 999999,
      },
    });
    try {
      const result = (await query('ranking.generals', { worldId, by: 'dedication' }, users[2]!.cookie)).data;
      expect(result.me).toBeNull();
      expect(result.top).toHaveLength(100);
      expect(result.top.some((row) => row.generalId === 106)).toBe(false);
      expect(result.at).toEqual(at);
    } finally {
      await db.general.delete({ where: { worldId_id: { worldId, id: 106 } } });
    }
  });

  it.each([
    ['cities', [1, 2, 3], [3, 3, 1]],
    ['generals', [3, 1, 2], [12, 7, 2]],
    ['power', [1, 2, 3], [24, 19, 19]],
  ] as const)('국가 %s는 전체 국가를 공개 필드와 순번으로 반환한다', async (by, ids, values) => {
    const result = await query('ranking.nations', { worldId, by });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      items: ids.map((id, index) => ({
        nationId: id,
        ...Object.fromEntries(
          Object.entries(nationRows.find((nation) => nation.id === id)!).filter(([key]) => key !== 'id'),
        ),
        rank: index + 1,
        value: values[index],
      })),
      at,
    });
    expect((await query('ranking.nations', { worldId, by }, users[2]!.cookie)).data).toEqual(result.data);
  });

  it('요청한 월드의 스냅샷과 장수만 읽고 다른 월드의 이름과 내 순위를 섞지 않는다', async () => {
    const result = (await query('ranking.generals', { worldId: otherWorldId, by: 'dedication' })).data;
    expect(result.me).toMatchObject({ generalId: 1, name: '다른 월드 1', rank: 1 });
    expect(result.top.every((row) => row.name.startsWith('다른 월드 '))).toBe(true);
    const nations = (await query('ranking.nations', { worldId: otherWorldId, by: 'power' })).data;
    expect(nations.items.every((row) => row.name.startsWith('다른 국가 '))).toBe(true);
    expect((await query('ranking.generals', { worldId, by: 'dedication' })).data.me?.generalId).toBe(105);
  });

  it('정산 전 월드는 빈 순위와 null 시점을 반환하며 조회로 스냅샷을 만들지 않는다', async () => {
    for (const by of ['dedication', 'experience', 'merit'])
      expect((await query('ranking.generals', { worldId: emptyWorldId, by })).data).toEqual({
        top: [],
        me: null,
        at: null,
      });
    for (const by of ['cities', 'generals', 'power'])
      expect((await query('ranking.nations', { worldId: emptyWorldId, by })).data).toEqual({ items: [], at: null });
    expect(await db.rankingSnapshot.findUnique({ where: { worldId: emptyWorldId } })).toBeNull();
  });

  it('월중 실시간 이름·소속·수치가 바뀌어도 월초 순위와 시점은 유지한다', async () => {
    const input = { worldId, by: 'dedication' };
    const generalsBefore = (await query('ranking.generals', input)).data;
    const nationsBefore = (await query('ranking.nations', { worldId, by: 'power' })).data;
    const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 105 } } });
    const nation = await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    try {
      await db.general.update({
        where: { worldId_id: { worldId, id: 105 } },
        data: { name: '월중 개명', nationId: 2, dedication: 999999, experience: 888888, battleWins: 77, captures: 66 },
      });
      await db.nation.update({
        where: { worldId_id: { worldId, id: 1 } },
        data: { name: '월중 국가명', color: '#abcdef', gold: 999999, tech: 888888 },
      });
      expect((await query('ranking.generals', input)).data).toEqual(generalsBefore);
      expect((await query('ranking.nations', { worldId, by: 'power' })).data).toEqual(nationsBefore);
    } finally {
      const { name, nationId, dedication, experience, battleWins, captures } = general;
      await db.general.update({
        where: { worldId_id: { worldId, id: 105 } },
        data: { name, nationId, dedication, experience, battleWins, captures },
      });
      const { name: nationName, color, gold, tech } = nation;
      await db.nation.update({
        where: { worldId_id: { worldId, id: 1 } },
        data: { name: nationName, color, gold, tech },
      });
    }
  });

  it('캐시에 비공개 필드가 있어도 장수·국가·중첩 국가의 허용 필드만 반환한다', async () => {
    const generals = (await query('ranking.generals', { worldId, by: 'experience' })).data;
    const nations = (await query('ranking.nations', { worldId, by: 'cities' })).data;
    const generalKeys = [
      'generalId',
      'name',
      'nation',
      'dedication',
      'experience',
      'wins',
      'captures',
      'merit',
      'rank',
      'value',
    ].sort();
    for (const row of [...generals.top, generals.me!]) {
      expect(Object.keys(row).sort()).toEqual(generalKeys);
      if (row.nation) expect(Object.keys(row.nation).sort()).toEqual(['color', 'id', 'name']);
    }
    for (const row of nations.items)
      expect(Object.keys(row).sort()).toEqual([
        'cities',
        'color',
        'generals',
        'name',
        'nationId',
        'power',
        'rank',
        'value',
      ]);
    expect(JSON.stringify([generals, nations])).not.toMatch(/private|userId|gold|rice|crew|turns|password|session/);
  });

  it('무인증·위조·만료 세션은 두 순위 조회를 모두 거부한다', async () => {
    const expired = newSession(now);
    await db.session.create({ data: { id: expired.id, userId: users[0]!.id, expiresAt: new Date(now) } });
    for (const cookie of [null, 'sid=invalid', `sid=${newSession(now).token}`, `sid=${expired.token}`])
      for (const route of routes) {
        const result = await query(route, inputFor(route), cookie);
        expect([result.status, result.error, result.data]).toEqual([401, 'UNAUTHORIZED', undefined]);
      }
  });

  it.each(['SANCTIONED', 'WITHDRAWN'] as const)(
    '%s 계정은 유효한 기존 세션으로도 순위를 읽지 못한다',
    async (status) => {
      try {
        await db.user.update({ where: { id: users[0]!.id }, data: { status } });
        for (const route of routes) {
          const result = await query(route, inputFor(route));
          expect([result.status, result.error, result.data]).toEqual([401, 'UNAUTHORIZED', undefined]);
        }
      } finally {
        await db.user.update({ where: { id: users[0]!.id }, data: { status: 'ACTIVE' } });
      }
    },
  );

  it('잘못된 월드·지표·권한 ID·추가 필드를 거부하고 조회를 POST로 실행하지 않는다', async () => {
    for (const route of routes) {
      for (const input of [
        null,
        [],
        {},
        { ...inputFor(route), worldId: 'not-uuid' },
        { ...inputFor(route), worldId: 1 },
        { worldId },
        { ...inputFor(route), by: '' },
        { ...inputFor(route), by: null },
        { ...inputFor(route), by: 1 },
        { ...inputFor(route), by: 'gold' },
        { ...inputFor(route), by: route === 'ranking.generals' ? 'cities' : 'experience' },
        { ...inputFor(route), userId: users[1]!.id },
        { ...inputFor(route), generalId: 1 },
        { ...inputFor(route), nationId: 2 },
        { ...inputFor(route), limit: 1000 },
      ]) {
        const result = await query(route, input);
        expect([result.status, result.error, result.data]).toEqual([400, 'BAD_REQUEST', undefined]);
      }
      expect((await query(route, inputFor(route), users[0]!.cookie, 'POST')).status).toBe(405);
      const missing = await query(route, inputFor(route, randomUUID()));
      expect([missing.status, missing.error, missing.data]).toEqual([404, 'NOT_FOUND', undefined]);
    }
  });

  it('순위 조회는 게임 상태·월간 캐시·기록·입력 이벤트를 바꾸지 않는다', async () => {
    const where = { worldId: { in: worlds } };
    const snapshot = () =>
      Promise.all([
        db.world.findMany({ where: { id: { in: worlds } }, orderBy: { id: 'asc' } }),
        db.city.findMany({ where, orderBy: [{ worldId: 'asc' }, { cityKey: 'asc' }] }),
        db.nation.findMany({ where, orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
        db.general.findMany({ where, orderBy: [{ worldId: 'asc' }, { id: 'asc' }] }),
        db.generalTurn.findMany({ where, orderBy: [{ worldId: 'asc' }, { generalId: 'asc' }, { slot: 'asc' }] }),
        db.generalLog.findMany({ where, orderBy: { id: 'asc' } }),
        db.inputEvent.findMany({ where, orderBy: { id: 'asc' } }),
        db.rankingSnapshot.findMany({ where, orderBy: { worldId: 'asc' } }),
        db.nationHistory.findMany({ where, orderBy: [{ worldId: 'asc' }, { nationId: 'asc' }, { tick: 'asc' }] }),
        db.yearbookSnapshot.findMany({ where, orderBy: [{ worldId: 'asc' }, { tick: 'asc' }] }),
      ]);
    const before = await snapshot();
    for (const id of worlds) {
      for (const by of ['dedication', 'experience', 'merit'])
        expect((await query('ranking.generals', { worldId: id, by })).status).toBe(200);
      for (const by of ['cities', 'generals', 'power'])
        expect((await query('ranking.nations', { worldId: id, by })).status).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });
});
