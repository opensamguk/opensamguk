import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildInitialWorld, initialReplayState, runReplayAction, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadReplayState } from '../apps/engine/src/monthly';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { acquireLease, releaseLease, type Lease } from '../apps/engine/src/lease';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay } from '../apps/engine/src/replay';
import { persistPublicMap } from '../apps/engine/src/publicMap';
import { persistCityRuins } from '../apps/engine/src/cityScaleState';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('도시 규모 전용 테스트 DB가 필요합니다.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname))
  throw new Error('loopback 전용 테스트 DB를 확인하세요.');
const db = createDb(url);
const worldIds: string[] = [],
  userIds = [randomUUID(), randomUUID()];
const epoch = 1_800_000_000_000,
  minute = 60_000;
let now = epoch,
  failed = false;
let app: Awaited<ReturnType<typeof buildServer>>;
let base: string;
const leases: Lease[] = [];
beforeEach(({ onTestFailed }) =>
  onTestFailed(() => {
    failed = true;
  }),
);
beforeAll(async () => {
  for (const id of userIds)
    await db.user.create({ data: { id, email: `${id}@example.test`, passwordHash: 'test-only' } });
  app = await buildServer({ db, logging: false, now: () => now });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app?.close();
    for (const lease of leases) await releaseLease(db, lease);
    if (!failed) {
      await db.world.deleteMany({ where: { id: { in: worldIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    await db.$disconnect();
  }
});
type CityInfo = {
  key: number;
  level: number;
  kind?: string;
  ruin?: { percent: 10 | 40 | 70 } | null;
  population?: number;
};
async function api<T>(path: string, input?: unknown, cookie?: string) {
  const response = await fetch(
    `${base}/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
    { headers: { origin: 'http://127.0.0.1:5173', ...(cookie ? { cookie } : {}) } },
  );
  const body = (await response.json()) as { result?: { data: T }; error?: { data: { code: string } } };
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
async function cookie(index = 0) {
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: userIds[index]!, expiresAt: session.expiresAt } });
  return `sid=${session.token}`;
}
function initialWorld(expanded = true) {
  const input = operationalInput();
  if (expanded) {
    const first = input.map.sites.find((site) => site.kind === 'CITY' && site.anchorKey === 1)!;
    const second = input.map.sites.find((site) => site.kind === 'CITY' && site.anchorKey === 2)!;
    if (first.kind !== 'CITY' || second.kind !== 'CITY') throw new Error('도시 고정물이 없습니다.');
    Object.assign(first, { name: '낙양', level: 8 });
    Object.assign(second, { name: '장안', level: 8 });
    input.map.sites.push({
      ...structuredClone(second),
      id: 'city:3',
      anchorKey: 3,
      legacyCityId: 3,
      name: '마을',
      level: 7,
      position: { x: 500, y: 400 },
      max: { population: 1000, agriculture: 50, commerce: 50, security: 50, defence: 50, wall: 50 },
      initial: { population: 1000, agriculture: 0, commerce: 0, security: 0, defence: 50, wall: 50 },
    });
    input.map.routes.push({
      id: 'route:3',
      from: 'city:2',
      to: 'city:3',
      mode: 'LAND',
      direction: 'BOTH',
      enabled: true,
    });
    input.scenario.nation[0]![8] = ['낙양', '관문'];
    input.scenario.nation[1]![8] = ['장안'];
    input.scenario.general[0]![4] = '낙양';
    input.scenario.general[1]![4] = '장안';
  }
  const initial = buildInitialWorld({
    ...input,
    scenario: {
      ...input.scenario,
      ...(expanded
        ? {
            cityScale: {
              cities: [
                { city: '낙양', level: 9, ruin: true },
                { city: '장안', level: 9 },
                { city: '마을', level: 0, ruin: true },
              ],
            },
          }
        : {}),
    },
  });
  for (const general of initial.generals) general.userId = userIds[general.id - 1]!;
  return initial;
}
async function world(expanded = true) {
  const initial = initialWorld(expanded);
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'AC-INT-21 저장·HTTP·재생',
    turnTermMinutes: 60,
    endYear: null,
  });
  worldIds.push(worldId);
  return { initial, worldId };
}
const snapshot = (worldId: string) =>
  db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });

it('무·경·폐허의 최초 저장과 실제 TCP 조회는 원래 규모·공개 표식·비공개 수치 경계를 지킨다', async () => {
  const { worldId, initial } = await world();
  expect(hashState(await snapshot(worldId))).toBe(hashState(initialReplayState(initial)));
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).cityRuinsState).toEqual(
    initialReplayState(initial).state.cityRuins,
  );
  const own = await cookie(),
    other = await cookie(1);
  expect((await api('city.get', { worldId, cityKey: 1 })).code).toBe('UNAUTHORIZED');
  expect((await api<CityInfo>('city.get', { worldId, cityKey: 1 }, own)).data).toMatchObject({
    level: 9,
    ruin: { percent: 10 },
    population: 300,
  });
  const hidden = (await api<CityInfo>('city.get', { worldId, cityKey: 1 }, other)).data!;
  expect(hidden).toMatchObject({ level: 9, ruin: { percent: 10 } });
  expect(hidden).not.toHaveProperty('population');
  expect((await api<{ city: CityInfo }>('home.get', { worldId }, own)).data?.city.ruin).toEqual({ percent: 10 });
  const map = (await api<{ cities: CityInfo[] }>('world.map', { worldId }, own)).data!;
  expect(map.cities.find((city) => city.key === 3)).toMatchObject({ level: 0, kind: 'CITY', ruin: { percent: 10 } });
  expect(map.cities.find((city) => city.key === 99)).toMatchObject({ level: 0, kind: 'PASS', ruin: null });
  expect(map.cities.find((city) => city.key === 2)).toMatchObject({ level: 9, ruin: null });
});

it('실제 월 정산·재적재와 DB 없는 별도 재생이 일치하고 공개 지도는 지연된 복구 단계만 보낸다', async () => {
  now = epoch;
  const { worldId, initial } = await world();
  await controlClock(db, worldId, 'start', now);
  const lease = (await acquireLease(db, worldId, undefined, 120_000))!;
  leases.push(lease);
  const first = await snapshot(worldId);
  const config = { delayMinutes: 10, intervalMinutes: 5 };
  await db.$transaction((tx) => persistPublicMap(tx, lease, first.state, 0, now, config));
  const loop = new TurnLoop(db, lease, { publicMapNow: () => now });
  await loop.advanceTo(TICKS_PER_MONTH);
  const stored = await snapshot(worldId);
  let replay = initialReplayState(initial);
  const row = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  for (let sequence = 0; sequence < row.actionSequence; sequence++)
    replay = runReplayAction(replay, initial.seed, initial.unitSet);
  expect(hashState(stored)).toBe(hashState(replay));
  expect(stored.state.cityRuins!.cities.find((city) => city.cityKey === 1)!.stage).toBe(1);
  expect(stored.state.cityRuins!.cities.find((city) => city.cityKey === 3)!.stage).toBe(0);
  now = epoch + 5 * minute;
  await db.$transaction((tx) => persistPublicMap(tx, lease, stored.state, TICKS_PER_MONTH, now, config));
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
      timeout: 10_000,
    },
  );
  expect(JSON.parse(output)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  type PublicMaps = {
    worlds: { id: string; map: { cities: { key: string; ruin?: { percent: number } | null }[] } | null }[];
  };
  now = epoch + 10 * minute;
  const delayed = (await api<PublicMaps>('world.publicMaps')).data!.worlds.find((entry) => entry.id === worldId)!.map!;
  expect(delayed.cities.find((city) => city.key === '1')!.ruin).toEqual({ percent: 10 });
  now = epoch + 15 * minute;
  const next = (await api<PublicMaps>('world.publicMaps')).data!.worlds.find((entry) => entry.id === worldId)!.map!;
  expect(next.cities.find((city) => city.key === '1')!.ruin).toEqual({ percent: 40 });
  await releaseLease(db, lease);
  const reopened = createDb(url);
  try {
    expect(hashState(await loadReplayState(reopened, worldId))).toBe(hashState(stored));
  } finally {
    await reopened.$disconnect();
  }
});

it('누락·위조한 저장 원장과 실패한 CAS를 거부하고 트랜잭션 실패는 도시와 폐허 상태를 모두 되돌린다', async () => {
  const { worldId } = await world();
  const before = await snapshot(worldId);
  const original = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).cityRuinsState!;
  await db.world.update({ where: { id: worldId }, data: { cityRuinsState: { version: 1, cities: [] } } });
  await expect(loadWorld(db, worldId)).rejects.toThrow('해제');
  await expect(exportReplay(db, worldId)).rejects.toThrow('해제');
  expect((await api('world.map', { worldId }, await cookie())).code).toBe('INTERNAL_SERVER_ERROR');
  await db.world.update({ where: { id: worldId }, data: { cityRuinsState: original as Prisma.InputJsonValue } });
  const final = structuredClone(before.state);
  final.cityRuins!.cities[0]!.stage = 1;
  const city = final.cities[1]!,
    max = final.cityRuins!.cities[0]!.baseMax;
  for (const field of ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const)
    city[`${field}Max`] = Math.floor(max[field] * 0.4);
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      await tx.city.update({
        where: { worldId_cityKey: { worldId, cityKey: 1 } },
        data: { populationMax: city.populationMax },
      });
      await persistCityRuins(tx, worldId, before.state, final);
      throw new Error('rollback-city-scale');
    }),
  ).rejects.toThrow('rollback-city-scale');
  expect(hashState(await snapshot(worldId))).toBe(hashState(before));
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    await expect(persistCityRuins(tx, worldId, final, before.state)).rejects.toThrow('바뀌었습니다');
  });
});

it('기존 월드의 저장값은 NULL이고 도시·지도·홈 응답에는 새 키가 없다', async () => {
  const { worldId, initial } = await world(false);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).cityRuinsState).toBeNull();
  expect(hashState(await snapshot(worldId))).toBe(hashState(initialReplayState(initial)));
  const session = await cookie();
  expect((await api<CityInfo>('city.get', { worldId, cityKey: 1 }, session)).data).not.toHaveProperty('ruin');
  expect((await api<{ city: CityInfo }>('home.get', { worldId }, session)).data!.city).not.toHaveProperty('ruin');
  const map = (await api<{ cities: CityInfo[] }>('world.map', { worldId }, session)).data!;
  expect(map.cities.every((city) => !Object.hasOwn(city, 'ruin'))).toBe(true);
});
