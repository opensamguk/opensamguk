import { createHash, randomUUID } from 'node:crypto';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb, type Prisma } from '@opensamguk/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFixture } from '../../test/readFixture';
import { newSession } from '../auth/session';
import type { AppRouter } from '../router';
import { buildServer } from '../server';

type Frames = inferRouterOutputs<AppRouter>['timelapse']['frames'];
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_003;
const app = await buildServer({ db, now: () => now, logging: false });
const users: Array<{ id: string; cookie: string }> = [];
let base: string;
let worldId: string;
let otherWorldId: string;
let emptyWorldId: string;
let state: Awaited<ReturnType<typeof readFixture>>;

async function query(input: unknown, cookie: string | null = users[0]!.cookie, method = 'GET') {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(`${base}/trpc/timelapse.frames?batch=1&input=${encodeURIComponent(encoded)}`, {
    method,
    headers: {
      origin: 'http://127.0.0.1:5173',
      ...(cookie ? { cookie } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: encoded } : {}),
  });
  type Envelope = {
    result?: { data: Frames };
    error?: { message: string; data: { code: string } };
  };
  const payload = (await response.json()) as Envelope | Envelope[];
  const body = Array.isArray(payload) ? payload[0]! : payload;
  return {
    status: response.status,
    data: body.result?.data,
    error: body.error?.data.code,
    message: body.error?.message,
  };
}

function snapshotData(index: number) {
  return {
    nations: state.nations.map(({ id }) => ({ nationId: id, gold: 77111, rice: 88222, power: 99333, generals: 7 })),
    cities: state.cities
      .map(({ cityKey, nationId }, cityIndex) => ({
        cityKey,
        nationId: cityIndex === 0 ? (index % 2) + 1 : cityIndex === 1 && index >= 30 ? 3 : nationId,
        population: 66777,
        private: { token: 'private-city-token' },
      }))
      .reverse(),
    private: { token: 'private-snapshot-token' },
  };
}

async function fixtureWorld(label: string, count: number, withGenerals = false) {
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
      initialStateHash: 'private-initial-hash',
      statRules: {},
      unitSet: {},
    },
  });
  await db.nation.createMany({
    data: state.nations.map((nation) => ({ ...nation, worldId: world.id, capitalCityKey: null })),
  });
  await db.city.createMany({ data: state.cities.map((city) => ({ ...city, worldId: world.id })) });
  if (withGenerals) {
    await db.general.createMany({
      data: state.generals.map((general, index) => ({
        ...general,
        worldId: world.id,
        userId: index === 0 ? users[0]!.id : index === 2 ? users[1]!.id : index === 3 ? users[2]!.id : null,
      })),
    });
  }
  if (count > 0)
    await db.yearbookSnapshot.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        worldId: world.id,
        tick: (index + 1) * 10000,
        year: 191 + Math.floor(index / 12),
        month: (index % 12) + 1,
        sequence: index + 1,
        stateHash: 'private-state-hash',
        data: snapshotData(index),
      })),
    });
  return world.id;
}

async function gameSnapshot() {
  const tables = await Promise.all([
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
  return createHash('sha256')
    .update(JSON.stringify(tables, (_, value) => (typeof value === 'bigint' ? String(value) : value)))
    .digest('hex');
}

beforeAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  state = await readFixture();
  for (let index = 0; index < 4; index++) {
    const session = newSession(now);
    const user = await db.user.create({
      data: {
        email: `timelapse-${index}@example.test`,
        passwordHash: 'not-used-for-session-auth',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    users.push({ id: user.id, cookie: `sid=${session.token}` });
  }
  worldId = await fixtureWorld('primary', 35, true);
  otherWorldId = await fixtureWorld('other', 30);
  emptyWorldId = await fixtureWorld('empty', 0);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await db.world.deleteMany();
  await db.user.deleteMany();
  await db.$disconnect();
});

describe('T4-35 / AC-P2-17 실제 TCP HTTP·PostgreSQL 영토 스냅샷', () => {
  it('H1 오래된 달부터 30개와 5개로 중복 없이 이어 읽는다', async () => {
    const first = await query({ worldId });
    expect(first.status).toBe(200);
    expect(first.data!.items.map(({ tick }) => tick)).toEqual(Array.from({ length: 30 }, (_, i) => (i + 1) * 10000));
    expect(first.data!.nextCursor).toBe('300000');
    const second = await query({ worldId, cursor: first.data!.nextCursor });
    expect(second.data!.items.map(({ tick }) => tick)).toEqual([310000, 320000, 330000, 340000, 350000]);
    expect(second.data!.nextCursor).toBeNull();
    expect(new Set([...first.data!.items, ...second.data!.items].map(({ tick }) => tick)).size).toBe(35);
  });

  it('H2 정확히 30행·마지막 cursor·빈 기록과 모든 월드 상태를 처리한다', async () => {
    const exact = await query({ worldId: otherWorldId });
    expect(exact.data!.items).toHaveLength(30);
    expect(exact.data!.nextCursor).toBeNull();
    expect((await query({ worldId, cursor: '350000' })).data).toEqual({
      items: [],
      currentNations: [],
      nextCursor: null,
    });
    expect((await query({ worldId, cursor: '0' })).data!.items[0]!.tick).toBe(10000);
    expect((await query({ worldId, cursor: '2147483647' })).data!.items).toEqual([]);
    try {
      for (const status of ['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED'] as const) {
        await db.world.update({ where: { id: emptyWorldId }, data: { status } });
        expect((await query({ worldId: emptyWorldId })).data).toEqual({
          items: [],
          currentNations: [],
          nextCursor: null,
        });
      }
    } finally {
      await db.world.update({ where: { id: emptyWorldId }, data: { status: 'RUNNING' } });
    }
  });

  it('H3 달별 소유와 연월을 보존하고 94도시를 cityKey로 정렬한다', async () => {
    const first = (await query({ worldId })).data!;
    const second = (await query({ worldId, cursor: first.nextCursor })).data!;
    for (const [index, frame] of [...first.items, ...second.items].entries()) {
      expect(frame).toEqual({
        tick: (index + 1) * 10000,
        year: 191 + Math.floor(index / 12),
        month: (index % 12) + 1,
        cities: snapshotData(index)
          .cities.map(({ cityKey, nationId }) => ({ cityKey, nationId }))
          .sort((a, b) => a.cityKey - b.cityKey),
      });
      expect(frame.cities).toHaveLength(94);
    }
  });

  it('H4 허용한 응답 key만 내고 국력·자원·중첩 비밀값을 차단한다', async () => {
    for (const cursor of [undefined, '300000']) {
      const { data } = await query({ worldId, ...(cursor ? { cursor } : {}) });
      expect(Object.keys(data!).sort()).toEqual(['currentNations', 'items', 'nextCursor']);
      for (const frame of data!.items) {
        expect(Object.keys(frame).sort()).toEqual(['cities', 'month', 'tick', 'year']);
        for (const city of frame.cities) expect(Object.keys(city).sort()).toEqual(['cityKey', 'nationId']);
      }
      for (const nation of data!.currentNations) expect(Object.keys(nation).sort()).toEqual(['color', 'id', 'name']);
      const encoded = JSON.stringify(data);
      for (const key of [
        'gold',
        'rice',
        'power',
        'generals',
        'population',
        'stateHash',
        'sequence',
        'tech',
        'capitalCityKey',
        'description',
        'philosophy',
        'isNpc',
        'private',
        'token',
      ])
        expect(encoded).not.toContain(`"${key}"`);
      expect(encoded).not.toContain('private-');
    }
  });

  it('H5 현재 이름·색만 조회하고 행이 없는 과거 국가 ID는 그대로 둔다', async () => {
    const displays = state.nations.map(({ id, name, color }) => ({ id, name, color })).sort((a, b) => a.id - b.id);
    const first = (await query({ worldId })).data!;
    const second = (await query({ worldId, cursor: '300000' })).data!;
    expect(first.currentNations).toEqual(displays);
    expect(second.currentNations).toEqual(displays);
    expect(second.items.every((frame) => frame.cities.some(({ nationId }) => nationId === 3))).toBe(true);
    try {
      await db.nation.update({
        where: { worldId_id: { worldId, id: 2 } },
        data: { name: '바뀐 국호', color: '#112233' },
      });
      for (const cursor of [undefined, '300000']) {
        const result = (await query({ worldId, ...(cursor ? { cursor } : {}) })).data!;
        expect(result.currentNations.find(({ id }) => id === 2)).toEqual({
          id: 2,
          name: '바뀐 국호',
          color: '#112233',
        });
      }
    } finally {
      await db.nation.update({
        where: { worldId_id: { worldId, id: 2 } },
        data: { name: displays[1]!.name, color: displays[1]!.color },
      });
    }
  });

  it('H5 현재 국가 목록은 반환한 30행이 참조한 ID만 포함한다', async () => {
    const id = await fixtureWorld('page-nations', 31);
    try {
      await db.yearbookSnapshot.updateMany({
        where: { worldId: id, tick: { lte: 300000 } },
        data: { data: { cities: [{ cityKey: 1, nationId: 1 }] } },
      });
      await db.yearbookSnapshot.update({
        where: { worldId_tick: { worldId: id, tick: 310000 } },
        data: { data: { cities: [{ cityKey: 1, nationId: 2 }] } },
      });
      expect((await query({ worldId: id })).data!.currentNations.map(({ id }) => id)).toEqual([1]);
      expect((await query({ worldId: id, cursor: '300000' })).data!.currentNations.map(({ id }) => id)).toEqual([2]);
      await db.yearbookSnapshot.updateMany({
        where: { worldId: id },
        data: { data: { cities: [{ cityKey: 1, nationId: null }] } },
      });
      expect((await query({ worldId: id })).data!.currentNations).toEqual([]);
    } finally {
      await db.world.delete({ where: { id } });
    }
  });

  it('H6 공개 영토 기록이므로 동국·적국·재야·장수 없는 사용자에게 같은 응답을 허용한다', async () => {
    for (const cursor of [undefined, '300000']) {
      const input = { worldId, ...(cursor ? { cursor } : {}) };
      const expected = await query(input);
      for (const user of users) expect(await query(input, user.cookie)).toEqual(expected);
    }
  });

  it('H7 무인증·위조·만료 세션에는 자료를 내지 않는다', async () => {
    const expired = newSession(now - 31 * 24 * 60 * 60 * 1000);
    await db.session.create({ data: { id: expired.id, userId: users[0]!.id, expiresAt: expired.expiresAt } });
    for (const cookie of [null, 'sid=forged', `sid=${newSession(now).token}`, `sid=${expired.token}`]) {
      const result = await query({ worldId }, cookie);
      expect([result.status, result.error, result.data]).toEqual([401, 'UNAUTHORIZED', undefined]);
    }
  });

  it('H8 제재·탈퇴 계정의 기존 세션을 거부한다', async () => {
    try {
      for (const status of ['SANCTIONED', 'WITHDRAWN'] as const) {
        await db.user.update({ where: { id: users[0]!.id }, data: { status } });
        const result = await query({ worldId });
        expect([result.status, result.error, result.data]).toEqual([401, 'UNAUTHORIZED', undefined]);
      }
    } finally {
      await db.user.update({ where: { id: users[0]!.id }, data: { status: 'ACTIVE' } });
    }
  });

  it('H9 actor 주입·추가 입력·잘못된 월드·cursor와 POST를 거부한다', async () => {
    const invalid: unknown[] = [null, [], {}, { worldId: 'not-uuid' }, { worldId: 12 }];
    for (const key of ['userId', 'generalId', 'actorId', 'nationId', 'limit', 'order', 'fromTick'])
      invalid.push({ worldId, [key]: 1 });
    for (const cursor of ['', '-1', '01', '1.5', '2147483648', '1e3', 1, null, {}, '9'.repeat(1000)])
      invalid.push({ worldId, cursor });
    for (const input of invalid) {
      const result = await query(input);
      expect([result.status, result.error, result.data]).toEqual([400, 'BAD_REQUEST', undefined]);
    }
    expect((await query({ worldId }, users[0]!.cookie, 'POST')).status).toBe(405);
  });

  it('H10 없는 월드는 404이고 다른 월드 기록은 섞이지 않는다', async () => {
    const missing = await query({ worldId: randomUUID() });
    expect([missing.status, missing.error, missing.data]).toEqual([404, 'NOT_FOUND', undefined]);
    expect((await query({ worldId: otherWorldId, cursor: '300000' })).data).toEqual({
      items: [],
      currentNations: [],
      nextCursor: null,
    });
    expect((await query({ worldId, cursor: '300000' })).data!.items).toHaveLength(5);
  });

  it('H11 cursor 앞의 삽입은 다음 페이지를 바꾸지 않고 뒤의 새 달은 이어 읽는다', async () => {
    const first = (await query({ worldId })).data!;
    const next = (await query({ worldId, cursor: first.nextCursor })).data!;
    const row = { worldId, year: 194, month: 1, sequence: 99, data: snapshotData(35), stateHash: 'private-extra-hash' };
    try {
      await db.yearbookSnapshot.create({ data: { ...row, tick: 5000 } });
      expect((await query({ worldId, cursor: first.nextCursor })).data).toEqual(next);
      await db.yearbookSnapshot.create({ data: { ...row, tick: 360000 } });
      expect((await query({ worldId, cursor: first.nextCursor })).data!.items.map(({ tick }) => tick)).toEqual([
        310000, 320000, 330000, 340000, 350000, 360000,
      ]);
    } finally {
      await db.yearbookSnapshot.deleteMany({ where: { worldId, tick: { in: [5000, 360000] } } });
    }
  });

  it('H12 성공·거부 조회 전후 게임 상태와 입력·기록·예턴은 불변이다', async () => {
    const before = await gameSnapshot();
    for (const user of users) {
      await query({ worldId }, user.cookie);
      await query({ worldId, cursor: '300000' }, user.cookie);
      await query({ worldId: emptyWorldId }, user.cookie);
    }
    await query({ worldId }, null);
    await query({ worldId, userId: users[1]!.id });
    await query({ worldId: randomUUID() });
    expect(await gameSnapshot()).toBe(before);
  });

  it('H13 잘못 저장된 첫 행은 가린 500이며 31번째 행은 첫 페이지를 깨지 않는다', async () => {
    const id = await fixtureWorld('malformed', 31);
    const malformed: Prisma.InputJsonValue = { nations: [{ gold: 123456 }], secret: 'private-malformed-value' };
    try {
      await db.yearbookSnapshot.update({
        where: { worldId_tick: { worldId: id, tick: 310000 } },
        data: { data: malformed },
      });
      const first = await query({ worldId: id });
      expect(first.status).toBe(200);
      expect(first.data!.items).toHaveLength(30);
      expect(first.data!.nextCursor).toBe('300000');
      const second = await query({ worldId: id, cursor: first.data!.nextCursor });
      expect(second).toEqual({
        status: 500,
        data: undefined,
        error: 'INTERNAL_SERVER_ERROR',
        message: '요청을 처리하지 못했습니다.',
      });
      expect(JSON.stringify(second)).not.toContain('private-malformed-value');
      await db.yearbookSnapshot.update({
        where: { worldId_tick: { worldId: id, tick: 10000 } },
        data: { data: malformed },
      });
      expect(await query({ worldId: id })).toEqual(second);
    } finally {
      await db.world.delete({ where: { id } });
    }
  });
});
