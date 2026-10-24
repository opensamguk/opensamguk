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
const fixtureId = randomUUID();
const worldIds: string[] = [];
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

function savedDisplay(label: string, index: number, id: number) {
  const color = `#${(id * 1000 + index).toString(16).padStart(6, '0')}`;
  return { id, name: `${label}-past-${id}-${index}`, color };
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
  worldIds.push(world.id);
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
  if (count > 0)
    await db.yearbookNation.createMany({
      data: Array.from({ length: count }, (_, index) =>
        [99, 3, 2, 1].map((id) => {
          const { name, color } = savedDisplay(label, index, id);
          return { worldId: world.id, tick: (index + 1) * 10000, nationId: id, name, color };
        }),
      ).flat(),
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
    db.yearbookNation.findMany({ orderBy: [{ worldId: 'asc' }, { tick: 'asc' }, { nationId: 'asc' }] }),
    db.removedNation.findMany({ orderBy: [{ worldId: 'asc' }, { nationId: 'asc' }] }),
  ]);
  return createHash('sha256')
    .update(JSON.stringify(tables, (_, value) => (typeof value === 'bigint' ? String(value) : value)))
    .digest('hex');
}

beforeAll(async () => {
  state = await readFixture();
  for (let index = 0; index < 4; index++) {
    const session = newSession(now);
    const user = await db.user.create({
      data: {
        email: `timelapse-${fixtureId}-${index}@example.test`,
        passwordHash: 'not-used-for-session-auth',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    users.push({ id: user.id, cookie: `sid=${session.token}` });
  }
  worldId = await fixtureWorld('primary', 35, true);
  otherWorldId = await fixtureWorld('other', 30);
  emptyWorldId = await fixtureWorld('empty', 0);
  await db.removedNation.create({
    data: {
      worldId,
      nationId: 3,
      name: '삭제 직전 이름',
      color: '#abcdef',
      removedSequence: 100,
      removedTick: 360000,
    },
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  await db.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
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
      expect(frame).toMatchObject({
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
        expect(Object.keys(frame).sort()).toEqual(['cities', 'month', 'nations', 'tick', 'year']);
        for (const city of frame.cities) expect(Object.keys(city).sort()).toEqual(['cityKey', 'nationId']);
        for (const nation of frame.nations) expect(Object.keys(nation).sort()).toEqual(['color', 'id', 'name']);
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

  it('H14 현재 행이 없는 멸망 국가도 프레임에 저장한 이름·색으로 반환한다', async () => {
    const data = (await query({ worldId, cursor: '300000' })).data!;
    expect(data.currentNations.map(({ id }) => id)).toEqual([1, 2]);
    for (const [offset, frame] of data.items.entries()) {
      expect(frame.nations.find(({ id }) => id === 3)).toEqual(savedDisplay('primary', offset + 30, 3));
    }
  });

  it('H15 같은 국가도 각 프레임의 이름·색을 읽고 현재 표시값과 구분한다', async () => {
    const data = (await query({ worldId })).data!;
    expect(savedDisplay('primary', 0, 2).color).not.toBe(savedDisplay('primary', 1, 2).color);
    expect(data.items[0]!.nations.find(({ id }) => id === 2)).toEqual(savedDisplay('primary', 0, 2));
    expect(data.items[1]!.nations.find(({ id }) => id === 2)).toEqual(savedDisplay('primary', 1, 2));
    const current = state.nations.find(({ id }) => id === 2)!;
    expect(data.currentNations.find(({ id }) => id === 2)).toEqual({ id: 2, name: current.name, color: current.color });
  });

  it('H16 부분·legacy 프레임의 결측 국가는 생략하고 현재 이름·색으로 메우지 않는다', async () => {
    const missing = await db.yearbookNation.findUniqueOrThrow({
      where: { worldId_tick_nationId: { worldId, tick: 10000, nationId: 2 } },
    });
    const legacy = await fixtureWorld('legacy', 1);
    try {
      await db.yearbookNation.delete({ where: { worldId_tick_nationId: { worldId, tick: 10000, nationId: 2 } } });
      const frame = (await query({ worldId })).data!.items[0]!;
      expect(frame.cities.some(({ nationId }) => nationId === 2)).toBe(true);
      expect(frame.nations).toEqual([savedDisplay('primary', 0, 1)]);
      await db.yearbookNation.deleteMany({ where: { worldId: legacy } });
      const legacyData = (await query({ worldId: legacy })).data!;
      expect(legacyData.items[0]!.nations).toEqual([]);
      expect(legacyData.currentNations).toHaveLength(2);
    } finally {
      await db.yearbookNation.create({ data: missing });
      await db.world.delete({ where: { id: legacy } });
    }
  });

  it('H17 반환한 tick·월드·프레임별 실제 소유 국가만 읽고 삭제 보존은 공개하지 않는다', async () => {
    const data = (await query({ worldId })).data!;
    expect(data.items[0]!.nations).toEqual([savedDisplay('primary', 0, 1), savedDisplay('primary', 0, 2)]);
    // 국가 1은 같은 페이지 다른 프레임의 소유자지만 이 프레임에는 도시가 없다.
    expect(data.items[1]!.nations).toEqual([savedDisplay('primary', 1, 2)]);
    for (const frame of data.items) {
      expect(frame.nations.some(({ id }) => id === 3 || id === 99)).toBe(false);
      expect(frame.nations.map(({ id }) => id)).toEqual(frame.nations.map(({ id }) => id).sort((a, b) => a - b));
      expect(frame.nations.every(({ name }) => name.startsWith('primary-'))).toBe(true);
      expect(frame.nations.some(({ name }) => name.includes('-30'))).toBe(false);
    }
    const encoded = JSON.stringify((await query({ worldId, cursor: '300000' })).data);
    expect(encoded).not.toContain('삭제 직전 이름');
    expect(encoded).not.toContain('other-past-');
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

type PublicFrames = inferRouterOutputs<AppRouter>['timelapse']['publicFrames'];

async function publicQuery(input: unknown, cookie: string | null = null, method = 'GET') {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(`${base}/trpc/timelapse.publicFrames?batch=1&input=${encodeURIComponent(encoded)}`, {
    method,
    headers: {
      origin: 'http://127.0.0.1:5173',
      ...(cookie ? { cookie } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: encoded } : {}),
  });
  type Envelope = {
    result?: { data: PublicFrames };
    error?: { message: string; data: { code: string; reason: null } };
  };
  const payload = (await response.json()) as Envelope | Envelope[];
  const body = Array.isArray(payload) ? payload[0]! : payload;
  return {
    status: response.status,
    data: body.result?.data,
    error: body.error?.data.code,
    message: body.error?.message,
    reason: body.error?.data.reason,
    hasResult: Object.hasOwn(body, 'result'),
    raw: JSON.stringify(body),
  };
}

async function endedFixture(label: string, count: number) {
  const id = await fixtureWorld(label, count);
  await db.world.update({ where: { id }, data: { status: 'ENDED' } });
  await db.worldResult.create({
    data: {
      worldId: id,
      reason: 'END_YEAR',
      endedYear: 194,
      endedMonth: 2,
      endedTick: 360000,
      endedSequence: count,
      remainingNations: 2,
      finalStateHash: 'private-result-hash',
      endedAt: new Date(now),
    },
  });
  return id;
}

function expectPublicKeys(data: PublicFrames) {
  expect(Object.keys(data).sort()).toEqual(['items', 'map', 'nextCursor', 'world']);
  expect(Object.keys(data.world).sort()).toEqual(['endedMonth', 'endedYear', 'name']);
  if (data.map) {
    expect(Object.keys(data.map)).toEqual(['cities']);
    for (const city of data.map.cities)
      expect(Object.keys(city).sort()).toEqual(['cityKey', 'connections', 'name', 'x', 'y']);
  }
  for (const frame of data.items) {
    expect(Object.keys(frame).sort()).toEqual(['cities', 'month', 'nations', 'tick', 'year']);
    for (const city of frame.cities) expect(Object.keys(city).sort()).toEqual(['cityKey', 'nationId']);
    for (const nation of frame.nations) expect(Object.keys(nation).sort()).toEqual(['color', 'id', 'name']);
  }
  const forbidden = new Set([
    'gold',
    'rice',
    'power',
    'generals',
    'population',
    'currentNations',
    'level',
    'supplied',
    'private',
    'token',
    'generalId',
    'userId',
    'stateHash',
    'initialStateHash',
    'sequence',
  ]);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      expect(forbidden.has(key)).toBe(false);
      visit(nested);
    }
  };
  visit(data);
}

describe('T4-91 / AC-P2-17 종료 월드 무인증 실제 TCP HTTP·PostgreSQL', () => {
  it('P1 종료 월드 첫 페이지는 저장 프레임과 다섯 칸 지도만 반환한다', async () => {
    const id = await endedFixture('public-primary', 35);
    const result = await publicQuery({ worldId: id });
    const member = await query({ worldId: id });
    expect(result.status).toBe(200);
    expect(result.data!.world).toEqual({ name: 'public-primary', endedYear: 194, endedMonth: 2 });
    expect(result.data!.items).toEqual(member.data!.items);
    expect(result.data!.nextCursor).toBe(member.data!.nextCursor);
    expect(result.data!.map!.cities).toEqual(
      state.cities
        .map(({ cityKey, name, x, y, connections }) => ({
          cityKey,
          name,
          x,
          y,
          connections,
        }))
        .sort((a, b) => a.cityKey - b.cityKey),
    );
    expect(result.data!.map!.cities).toHaveLength(94);
    expectPublicKeys(result.data!);
  });

  it('P2 종료 전 월드는 무인증·로그인·제재 세션 모두 자료 없이 거부한다', async () => {
    await db.user.update({ where: { id: users[2]!.id }, data: { status: 'SANCTIONED' } });
    try {
      for (const status of ['PREOPEN', 'RUNNING', 'PAUSED'] as const) {
        const id = await fixtureWorld(`denied-${status}`, 1);
        await db.world.update({ where: { id }, data: { status } });
        for (const cookie of [null, users[0]!.cookie, users[2]!.cookie]) {
          const result = await publicQuery({ worldId: id }, cookie);
          expect([result.status, result.error, result.message, result.hasResult, result.reason]).toEqual([
            403,
            'FORBIDDEN',
            '종료된 월드만 로그인 없이 볼 수 있습니다.',
            false,
            null,
          ]);
          expect(result.data).toBeUndefined();
          for (const secret of [
            `denied-${status}`,
            '191',
            savedDisplay(`denied-${status}`, 0, 1).name,
            state.cities[0]!.name,
          ]) {
            expect(result.raw).not.toContain(secret);
          }
        }
      }
    } finally {
      await db.user.update({ where: { id: users[2]!.id }, data: { status: 'ACTIVE' } });
    }
  });

  it('P3 없는 월드는 404이고 다른 월드의 저장 프레임은 섞이지 않는다', async () => {
    const missing = await publicQuery({ worldId: randomUUID() });
    expect([missing.status, missing.error, missing.hasResult]).toEqual([404, 'NOT_FOUND', false]);
    const a = await endedFixture('public-a', 1);
    const b = await endedFixture('public-b', 1);
    const first = (await publicQuery({ worldId: a })).data!;
    const second = (await publicQuery({ worldId: b })).data!;
    expect(first.world.name).toBe('public-a');
    expect(second.world.name).toBe('public-b');
    for (const frame of first.items)
      expect(frame.nations.every(({ name }) => name.startsWith('public-a-past-'))).toBe(true);
    for (const frame of second.items)
      expect(frame.nations.every(({ name }) => name.startsWith('public-b-past-'))).toBe(true);
    expect(JSON.stringify(first)).not.toContain('public-b');
  });

  it('P4 모든 깊이의 응답 key와 비밀값을 허용 목록으로 제한한다', async () => {
    const id = await endedFixture('public-keys', 35);
    for (const input of [{ worldId: id }, { worldId: id, cursor: '300000' }]) {
      const result = await publicQuery(input);
      expect(result.status).toBe(200);
      expectPublicKeys(result.data!);
      for (const marker of [
        'private-city-token',
        'private-snapshot-token',
        'private-state-hash',
        'private-initial-hash',
        'private-result-hash',
      ]) {
        expect(result.raw).not.toContain(marker);
      }
    }
  });

  it('P5 30행 페이지·마지막 페이지·정확히 30행·빈 종료 월드를 처리한다', async () => {
    const id = await endedFixture('public-pages', 35);
    const first = (await publicQuery({ worldId: id })).data!;
    const second = (await publicQuery({ worldId: id, cursor: first.nextCursor })).data!;
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).toBe('300000');
    expect(second.items).toHaveLength(5);
    expect(second.map).toBeNull();
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map(({ tick }) => tick)).toEqual(
      Array.from({ length: 35 }, (_, index) => (index + 1) * 10000),
    );
    const member = (await query({ worldId: id, cursor: '300000' })).data!;
    expect(second.items).toEqual(member.items);
    expect(second.nextCursor).toBe(member.nextCursor);
    const exact = await endedFixture('public-exact', 30);
    expect((await publicQuery({ worldId: exact })).data!.nextCursor).toBeNull();
    const empty = await endedFixture('public-empty', 0);
    const noFrames = (await publicQuery({ worldId: empty })).data!;
    expect(noFrames.items).toEqual([]);
    expect(noFrames.nextCursor).toBeNull();
    expect(noFrames.map!.cities).toHaveLength(94);
  });

  it('P6 현재 국가와 삭제 직전 표시값 대신 프레임에 저장된 이름·색만 반환한다', async () => {
    const label = 'public-history';
    const id = await endedFixture(label, 35);
    expect(await db.nation.count({ where: { worldId: id, id: 3 } })).toBe(0);
    await db.nation.updateMany({ where: { worldId: id }, data: { name: '현재만 있는 이름', color: '#ffffff' } });
    await db.removedNation.create({
      data: {
        worldId: id,
        nationId: 3,
        name: '삭제 직전 이름-public',
        color: '#abcdef',
        removedSequence: 100,
        removedTick: 360000,
      },
    });
    const first = (await publicQuery({ worldId: id })).data!;
    expect(first.items[0]!.nations.find(({ id }) => id === 2)).toEqual(savedDisplay(label, 0, 2));
    expect(first.items[1]!.nations.find(({ id }) => id === 2)).toEqual(savedDisplay(label, 1, 2));
    const second = (await publicQuery({ worldId: id, cursor: '300000' })).data!;
    for (const [index, frame] of second.items.entries())
      expect(frame.nations.find(({ id }) => id === 3)).toEqual(savedDisplay(label, index + 30, 3));
    for (const data of [first, second]) {
      expect(JSON.stringify(data)).not.toContain('현재만 있는 이름');
      expect(JSON.stringify(data)).not.toContain('삭제 직전 이름-public');
    }
  });

  it('P7 저장 국가가 없는 달은 현재 국가나 회색으로 채우지 않는다', async () => {
    const id = await endedFixture('public-missing', 2);
    await db.yearbookNation.delete({ where: { worldId_tick_nationId: { worldId: id, tick: 10000, nationId: 2 } } });
    let data = (await publicQuery({ worldId: id })).data!;
    expect(data.items[0]!.cities.some(({ nationId }) => nationId === 2)).toBe(true);
    expect(data.items[0]!.nations).toEqual([savedDisplay('public-missing', 0, 1)]);
    await db.yearbookNation.deleteMany({ where: { worldId: id } });
    data = (await publicQuery({ worldId: id })).data!;
    expect(data.items.every(({ nations }) => nations.length === 0)).toBe(true);
    expect(await db.nation.count({ where: { worldId: id } })).toBe(2);
  });

  it('P8 actor 주입·추가 입력·잘못된 월드·cursor·POST를 거부한다', async () => {
    const id = await endedFixture('public-invalid', 1);
    const invalid: unknown[] = [null, [], {}, { worldId: 'not-uuid' }, { worldId: 12 }];
    for (const key of ['userId', 'generalId', 'actorId', 'nationId', 'limit', 'order', 'fromTick'])
      invalid.push({ worldId: id, [key]: 1 });
    for (const cursor of ['', '-1', '01', '1.5', '2147483648', '1e3', 1, null, {}, '9'.repeat(1000)])
      invalid.push({ worldId: id, cursor });
    const before = await gameSnapshot();
    for (const input of invalid) {
      const result = await publicQuery(input);
      expect([result.status, result.error, result.hasResult]).toEqual([400, 'BAD_REQUEST', false]);
    }
    expect((await publicQuery({ worldId: id }, null, 'POST')).status).toBe(405);
    expect(await gameSnapshot()).toBe(before);
  });

  it('P9 종료 결과 누락과 깨진 저장 JSON은 가린 500이고 프레임을 내지 않는다', async () => {
    const noResult = await fixtureWorld('public-no-result', 1);
    await db.world.update({ where: { id: noResult }, data: { status: 'ENDED' } });
    const missing = await publicQuery({ worldId: noResult });
    expect([missing.status, missing.error, missing.message, missing.hasResult, missing.reason]).toEqual([
      500,
      'INTERNAL_SERVER_ERROR',
      '요청을 처리하지 못했습니다.',
      false,
      null,
    ]);
    const id = await endedFixture('public-malformed', 31);
    const malformed: Prisma.InputJsonValue = { private: 'private-malformed-value' };
    await db.yearbookSnapshot.update({
      where: { worldId_tick: { worldId: id, tick: 310000 } },
      data: { data: malformed },
    });
    const first = await publicQuery({ worldId: id });
    expect(first.status).toBe(200);
    expect(first.data!.items).toHaveLength(30);
    const second = await publicQuery({ worldId: id, cursor: first.data!.nextCursor });
    expect([second.status, second.error, second.message, second.hasResult]).toEqual([
      500,
      'INTERNAL_SERVER_ERROR',
      '요청을 처리하지 못했습니다.',
      false,
    ]);
    expect(second.raw).not.toContain('private-malformed-value');
    await db.yearbookSnapshot.update({
      where: { worldId_tick: { worldId: id, tick: 10000 } },
      data: { data: malformed },
    });
    expect((await publicQuery({ worldId: id })).status).toBe(500);
  });

  it('P10 성공·거부 조회가 게임 상태와 입력·기록·예턴을 바꾸지 않는다', async () => {
    const id = await endedFixture('public-read-only', 35);
    const running = await fixtureWorld('public-read-only-running', 1);
    const before = await gameSnapshot();
    for (const cookie of [null, users[0]!.cookie]) {
      await publicQuery({ worldId: id }, cookie);
      await publicQuery({ worldId: id, cursor: '300000' }, cookie);
      await publicQuery({ worldId: running }, cookie);
      await publicQuery({ worldId: id, userId: users[1]!.id }, cookie);
      await publicQuery({ worldId: randomUUID() }, cookie);
    }
    expect(await gameSnapshot()).toBe(before);
  });

  it('P11 무인증·위조·만료·제재·탈퇴·로그인 세션의 종료 응답이 같다', async () => {
    const id = await endedFixture('public-sessions', 1);
    const expired = newSession(now - 31 * 24 * 60 * 60 * 1000);
    await db.session.create({ data: { id: expired.id, userId: users[0]!.id, expiresAt: expired.expiresAt } });
    await db.user.update({ where: { id: users[2]!.id }, data: { status: 'SANCTIONED' } });
    await db.user.update({ where: { id: users[3]!.id }, data: { status: 'WITHDRAWN' } });
    try {
      const expected = await publicQuery({ worldId: id });
      expect(expected.status).toBe(200);
      for (const cookie of [
        null,
        'sid=forged',
        `sid=${expired.token}`,
        users[2]!.cookie,
        users[3]!.cookie,
        users[0]!.cookie,
      ]) {
        expect(await publicQuery({ worldId: id }, cookie)).toEqual(expected);
      }
    } finally {
      await db.user.updateMany({ where: { id: { in: [users[2]!.id, users[3]!.id] } }, data: { status: 'ACTIVE' } });
    }
  });
});
