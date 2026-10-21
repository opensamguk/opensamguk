// T1-12 독립 리뷰 탐침. PR #37 head b99adef에 덧붙여 CI에서만 실행하고 병합하지 않는다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { monthlyFixture } from '../test/monthlyFixture';
import { TurnLoop } from './turnLoop';
import { acquireLease, releaseLease } from './lease';
import { controlClock } from './world/clock';
import { saveInitialWorld } from './world/persistence';
import { buildServer } from '../../server/src/server';
import { newSession } from '../../server/src/auth/session';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
const cookies: string[] = [];
const userIds: string[] = [];
let base: string;
let worldId: string;

async function get(route: string, input: unknown, cookie: string | undefined) {
  const response = await fetch(`${base}/trpc/${route}?input=${encodeURIComponent(JSON.stringify(input))}`, {
    headers: cookie ? { cookie } : {},
  });
  const body = (await response.json()) as { result?: { data: unknown }; error?: unknown };
  return { status: response.status, data: body.result?.data as Record<string, unknown> };
}
function keysDeep(value: unknown, out = new Set<string>()) {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, out);
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      keysDeep(child, out);
    }
  return out;
}
const numeric = ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall', 'trust', 'region'];

beforeAll(async () => {
  const template = await monthlyFixture();
  ({ worldId } = await saveInitialWorld(db, template, { name: '리뷰 탐침', turnTermMinutes: 60 }));
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  await new TurnLoop(db, lease).advanceTo(20000);
  await releaseLease(db, lease);
  for (let index = 0; index < 4; index++) {
    const session = newSession(Date.now());
    const user = await db.user.create({
      data: {
        email: `t1-12-review-${index}@example.com`,
        passwordHash: 'unused',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    userIds.push(user.id);
    cookies.push(`sid=${session.token}`);
  }
  const place = [
    { id: 1, nationId: 1, cityKey: 1 },
    { id: 2, nationId: 2, cityKey: 4 },
    { id: 3, nationId: null, cityKey: 1 },
  ];
  for (const [index, general] of place.entries())
    await db.general.update({
      where: { worldId_id: { worldId, id: general.id } },
      data: { nationId: general.nationId, cityKey: general.cityKey, userId: userIds[index]! },
    });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: worldId } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe('T1-12 리뷰 탐침: 엔진이 저장한 실제 월간 기록과 공개 범위', () => {
  it('records.world는 엔진 연감에서 공개 키만 남긴다', async () => {
    const { status, data } = await get('records.world', { worldId }, cookies[3]);
    expect(status).toBe(200);
    const items = data.items as Array<Record<string, unknown>>;
    expect(items.map((row) => row.tick)).toEqual([20000, 10000]);
    expect(data.nextCursor).toBeNull();
    expect([...keysDeep(items)].sort()).toEqual([
      'cities',
      'cityKey',
      'generals',
      'month',
      'nationId',
      'nations',
      'tick',
      'year',
    ]);
    const stored = await db.yearbookSnapshot.findUniqueOrThrow({ where: { worldId_tick: { worldId, tick: 20000 } } });
    const raw = stored.data as { nations: Array<{ nationId: number; cities: number; generals: number }> };
    expect(items[0]!.nations).toEqual(
      raw.nations.map(({ nationId, cities, generals }) => ({ nationId, cities, generals })),
    );
    expect((await get('records.world', { worldId, cursor: '20000' }, cookies[3])).data.items).toHaveLength(1);
  });

  it('records.nation은 엔진 국가 기록의 자원을 소속국에만 준다', async () => {
    const own = (await get('records.nation', { worldId }, cookies[0])).data;
    const stored = await db.nationHistory.findUniqueOrThrow({
      where: { worldId_tick_nationId: { worldId, tick: 20000, nationId: 1 } },
    });
    const raw = stored.data as Record<string, number>;
    expect((own.items as unknown[])[0]).toEqual({
      tick: 20000,
      nationId: 1,
      cities: raw.cities,
      generals: raw.generals,
      gold: raw.gold,
      rice: raw.rice,
    });
    expect((await get('records.nation', { worldId }, cookies[2])).data).toEqual({ items: [], nextCursor: null });
  });

  it('재야가 머무는 도시는 수치를 보지만 그 도시 장수 상세와 국가 국고는 못 본다', async () => {
    const city = (await get('city.get', { worldId, cityKey: 1 }, cookies[2])).data;
    expect(city).toHaveProperty('population');
    const generals = city.generals as Array<Record<string, unknown>>;
    const ally = generals.find((general) => general.id === 1)!;
    expect(Object.keys(ally).sort()).toEqual(['id', 'name', 'nationId']);
    expect(generals.find((general) => general.id === 3)).toHaveProperty('gold');
    const nation = (await get('nation.get', { worldId, nationId: 1 }, cookies[2])).data;
    expect(Object.keys(nation).sort()).toEqual([
      'cities',
      'cityCount',
      'color',
      'generalCount',
      'generals',
      'id',
      'name',
    ]);
  });

  it('적 도시는 공개 지도 필드와 적 장수 이름·소속만 준다', async () => {
    const city = (await get('city.get', { worldId, cityKey: 4 }, cookies[0])).data;
    for (const field of numeric) expect(city).not.toHaveProperty(field);
    expect(city.generals).toEqual([{ id: 2, name: expect.any(String), nationId: 2 }]);
  });

  it('home.nextTurnAt은 DB 시계 기준과 장수 다음 tick으로 계산된다', async () => {
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const home = (await get('home.get', { worldId }, cookies[0])).data;
    const msPerTick = (world.turnTermMinutes * 60_000) / 10_000;
    expect(home.nextTurnAt).toBe(
      new Date(world.clockAnchorAt!.getTime() + (general.nextTurnTick - world.clockTick) * msPerTick).toISOString(),
    );
    const summary = (await get('world.summary', { worldId }, cookies[0])).data;
    expect(summary.msPerTick).toBe(msPerTick);
    expect(summary.nowTick as number).toBeGreaterThanOrEqual(world.clockTick);
  });

  it('모든 조회·모든 계정 응답에 계정·저장 내부 키가 없다', async () => {
    const forbidden = [
      'userId',
      'email',
      'passwordHash',
      'affinity',
      'turnRevision',
      'worldId',
      'seed',
      'initialStateHash',
      'stateHash',
      'sequence',
      'power',
      'idempotencyKey',
      'sessionId',
      'clockAnchorAt',
      'clockRevision',
      'createdAt',
      'statRules',
      'unitSet',
      'data',
    ];
    const inputs: Array<[string, unknown]> = [
      ['world.summary', { worldId }],
      ['world.map', { worldId }],
      ['home.get', { worldId }],
      ['city.get', { worldId, cityKey: 1 }],
      ['city.get', { worldId, cityKey: 4 }],
      ['nation.get', { worldId, nationId: 1 }],
      ['nation.get', { worldId, nationId: 2 }],
      ['records.general', { worldId }],
      ['records.nation', { worldId }],
      ['records.world', { worldId }],
    ];
    let checked = 0;
    for (const cookie of cookies)
      for (const [route, input] of inputs) {
        const result = await get(route, input, cookie);
        if (result.status !== 200) continue;
        checked++;
        const keys = keysDeep(result.data);
        for (const key of forbidden) expect(keys.has(key), `${route} ${key}`).toBe(false);
      }
    expect(checked).toBeGreaterThanOrEqual(34);
  });
});
