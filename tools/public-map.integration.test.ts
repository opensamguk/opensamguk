import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { acquireLease, LeaseLostError } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive, replayToEnd } from '../apps/engine/src/replay';
import { hashState } from '../packages/shared/src/node/hashState';
import { initialReplayState, runReplayAction } from '../packages/rules/src/replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const minute = 60_000;
const epoch = 1_800_000_000_000;
let now = epoch;
const app = await buildServer({ db, now: () => now, logging: false });
let base: string;
let template: Awaited<ReturnType<typeof monthlyFixture>>;
const userIds = [randomUUID(), randomUUID(), randomUUID()];

beforeAll(async () => {
  template = await monthlyFixture();
  template.generals = template.generals.slice(0, 2).map((general, i) => ({ ...general, userId: userIds[i]! }));
  for (const [i, id] of userIds.entries()) {
    await db.user.create({
      data: { id, email: `${id}@example.test`, passwordHash: 'test-only', status: i === 2 ? 'SANCTIONED' : 'ACTIVE' },
    });
  }
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
beforeEach(async () => {
  now = epoch;
  await db.world.deleteMany();
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany();
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});
async function world() {
  const initial = structuredClone(template);
  const { worldId } = await saveInitialWorld(db, initial, {
    replayFormat: 'legacy',
    name: '공개 지도 시험',
    turnTermMinutes: 60,
    endYear: null,
  });
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(epoch) } });
  const lease = (await acquireLease(db, worldId, randomUUID(), 120_000))!;
  return { worldId, initial, lease, loop: new TurnLoop(db, lease, { publicMapNow: () => now }) };
}
async function rows(worldId: string) {
  return db.publicMapSnapshot.findMany({ where: { worldId }, orderBy: { takenAt: 'asc' } });
}
async function replayHash(worldId: string) {
  return db.$transaction(async (tx) => hashState(await loadReplayState(tx, worldId)));
}
async function maps(input?: unknown, cookie?: string) {
  const query = input === undefined ? '' : `&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`;
  const response = await fetch(`${base}/trpc/world.publicMaps?batch=1${query}`, { headers: cookie ? { cookie } : {} });
  const body = (await response.json())[0] as {
    result?: {
      data: {
        delayMinutes: number;
        worlds: Array<{
          id: string;
          name: string;
          status: string;
          map: null | {
            takenAt: string;
            year: number;
            month: number;
            cities: Array<{ key: string; nationId: number | null }>;
            nations: Array<{ id: number; name: string; color: string }>;
          };
        }>;
      };
    };
    error?: { data: { code: string } };
  };
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
async function cookie(index: number) {
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: userIds[index]!, expiresAt: session.expiresAt } });
  return `sid=${session.token}`;
}

it('실제 엔진 사본 A/B는 10분 경계를 포함해 늦게 공개되고 현재 소유·이름·미래 사본은 새지 않는다', async () => {
  const { worldId, loop } = await world();
  expect((await maps()).data?.worlds[0]?.map).toBeNull();
  await loop.advanceTo(100);
  const a = (await rows(worldId))[0]!;
  const city = template.cities[0]!;
  const oldNation = city.nationId;
  await db.city.update({ where: { worldId_cityKey: { worldId, cityKey: city.cityKey } }, data: { nationId: 2 } });
  await db.nation.update({ where: { worldId_id: { worldId, id: 2 } }, data: { name: '사본 B 국가' } });
  now = epoch + 5 * minute;
  await loop.advanceTo(10_000);
  const b = (await rows(worldId))[1]!;
  expect(b).toMatchObject({ tick: 10_000, year: template.startYear, month: 2 });
  await db.nation.update({ where: { worldId_id: { worldId, id: 2 } }, data: { name: '현재 비공개 이름' } });
  await db.publicMapSnapshot.create({
    data: {
      ...b,
      takenAt: new Date(epoch + 60 * minute),
      data: { cities: [], nations: [{ id: 2, name: '미래 이름', color: '#ffffff' }] },
    },
  });
  now = epoch + 10 * minute - 1;
  expect((await maps()).data?.worlds[0]?.map).toBeNull();
  for (const time of [epoch + 10 * minute, epoch + 15 * minute - 1]) {
    now = time;
    const map = (await maps()).data!.worlds[0]!.map!;
    expect(map.takenAt).toBe(a.takenAt.toISOString());
    expect(map.cities.find((entry) => entry.key === String(city.cityKey))?.nationId).toBe(oldNation);
    expect(JSON.stringify(map)).not.toContain('현재 비공개 이름');
  }
  now = epoch + 15 * minute;
  const map = (await maps()).data!.worlds[0]!.map!;
  expect(map.takenAt).toBe(b.takenAt.toISOString());
  expect(map.cities.find((entry) => entry.key === String(city.cityKey))?.nationId).toBe(2);
  expect(map.nations.find((entry) => entry.id === 2)?.name).toBe('사본 B 국가');
  expect(JSON.stringify(map)).not.toContain('미래 이름');
});

it('RUNNING·PAUSED만 createdAt/id 순서로 나열하고 사본 없는 월드는 null이다', async () => {
  const { worldId } = await world();
  const source = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  await db.world.update({ where: { id: worldId }, data: { createdAt: new Date(epoch + minute) } });
  for (const [id, status, createdAt] of [
    ['00000000-0000-4000-8000-000000000002', 'RUNNING', epoch],
    ['00000000-0000-4000-8000-000000000001', 'PAUSED', epoch],
    ['00000000-0000-4000-8000-000000000003', 'PREOPEN', epoch - minute],
    ['00000000-0000-4000-8000-000000000004', 'ENDED', epoch - minute],
  ] as const)
    await db.world.create({
      data: {
        ...source,
        operationalMap: undefined,
        campaignState: undefined,
        id,
        status,
        createdAt: new Date(createdAt),
      },
    });
  const response = await maps();
  expect(response.data?.worlds.map((entry) => entry.id)).toEqual([
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    worldId,
  ]);
  expect(response.data?.worlds.every((entry) => entry.map === null)).toBe(true);
  expect(response.data?.delayMinutes).toBe(10);
});

it('무인증·다른 계정·제재 세션은 같고 입력 ID 주입은 거부하며 오염 JSON은 허용 키만 남긴다', async () => {
  const { worldId, loop } = await world();
  await loop.advanceTo(100);
  const snapshot = (await rows(worldId))[0]!;
  const data = snapshot.data as Prisma.JsonObject;
  const polluted = structuredClone(data);
  (polluted.cities as Prisma.JsonObject[])[0]!.supplied = true;
  (polluted.cities as Prisma.JsonObject[])[0]!.crew = 123456;
  (polluted.nations as Prisma.JsonObject[])[0]!.gold = 654321;
  polluted.generals = [{ userId: 'private-user', crew: 999 }];
  await db.publicMapSnapshot.update({
    where: { worldId_takenAt: { worldId, takenAt: snapshot.takenAt } },
    data: { data: polluted },
  });
  now = epoch + 10 * minute;
  const before = await replayHash(worldId);
  const beforeMaps = await rows(worldId);
  const anonymous = await maps();
  for (const index of [0, 1, 2]) expect((await maps(undefined, await cookie(index))).data).toEqual(anonymous.data);
  expect(anonymous.status).toBe(200);
  expect(Object.keys(anonymous.data!).sort()).toEqual(['delayMinutes', 'worlds']);
  const entry = anonymous.data!.worlds[0]!;
  expect(Object.keys(entry).sort()).toEqual(['id', 'map', 'name', 'status']);
  expect(Object.keys(entry.map!).sort()).toEqual(['cities', 'month', 'nations', 'takenAt', 'year']);
  expect(Object.keys(entry.map!.cities[0]!).sort()).toEqual(['key', 'level', 'links', 'name', 'nationId', 'x', 'y']);
  expect(Object.keys(entry.map!.nations[0]!).sort()).toEqual(['color', 'id', 'name']);
  for (const input of [{ worldId }, { userId: userIds[0] }, { generalId: 1 }, null, []])
    expect((await maps(input)).code).toBe('BAD_REQUEST');
  expect(await replayHash(worldId)).toBe(before);
  expect(await rows(worldId)).toEqual(beforeMaps);
  for (const data of [
    { cities: [], nations: 'broken' },
    { cities: [], nations: [{ id: 'private', name: 'name', color: 'red' }] },
  ]) {
    await db.publicMapSnapshot.update({
      where: { worldId_takenAt: { worldId, takenAt: snapshot.takenAt } },
      data: { data },
    });
    expect((await maps()).data?.worlds[0]?.map).toBeNull();
  }
});

it('간격 직전에는 안 찍고 경계에는 찍으며 오래된 cutoff 사본은 가장 최근 하나만 남긴다', async () => {
  const { worldId, loop } = await world();
  await loop.advanceTo(100);
  now = epoch + 5 * minute - 1;
  await loop.advanceTo(10_000);
  expect(await rows(worldId)).toHaveLength(1);
  now++;
  await loop.advanceTo(10_100);
  expect((await rows(worldId)).map((entry) => entry.takenAt.getTime())).toEqual([epoch, epoch + 5 * minute]);
  now = epoch + 20 * minute;
  await loop.advanceTo(20_100);
  expect((await rows(worldId)).map((entry) => entry.takenAt.getTime())).toEqual([epoch + 5 * minute, now]);
  const before = await rows(worldId);
  now += 20 * minute;
  await loop.advanceTo(20_100);
  expect(await rows(worldId)).toEqual(before);
  for (const status of ['PAUSED', 'ENDED'] as const) {
    await db.world.update({ where: { id: worldId }, data: { status } });
    await loop.advanceTo(30_100);
    expect(await rows(worldId)).toEqual(before);
  }
});

it('사본 생성·삭제와 턴 상태는 commit 실패와 리스 만료 때 함께 롤백한다', async () => {
  const { worldId, loop, lease } = await world();
  await loop.advanceTo(100);
  now += 5 * minute;
  await loop.advanceTo(10_100);
  const before = await rows(worldId);
  const beforeHash = await replayHash(worldId);
  now += 15 * minute;
  const failed = new TurnLoop(db, lease, {
    publicMapNow: () => now,
    beforeCommit: async (tx) => {
      const snapshots = await tx.publicMapSnapshot.findMany({ where: { worldId }, orderBy: { takenAt: 'asc' } });
      expect(snapshots.map((entry) => entry.takenAt.getTime())).toEqual([epoch + 5 * minute, now]);
      throw new Error('공개 지도 commit 중단');
    },
  });
  await expect(failed.advanceTo(20_100)).rejects.toThrow('commit 중단');
  expect(await rows(worldId)).toEqual(before);
  expect(await replayHash(worldId)).toBe(beforeHash);
  const expired = new TurnLoop(db, lease, {
    publicMapNow: () => now,
    beforeCommit: async (tx) => {
      await tx.engineLease.update({ where: { worldId }, data: { expiresAt: new Date(0) } });
    },
  });
  await expect(expired.advanceTo(20_100)).rejects.toBeInstanceOf(LeaseLostError);
  expect(await rows(worldId)).toEqual(before);
  expect(await replayHash(worldId)).toBe(beforeHash);
});

it('실행권 재획득·재시작은 저장 간격을 DB에서 복원하고 이전 토큰은 쓰지 못한다', async () => {
  const { worldId, loop, lease } = await world();
  await loop.advanceTo(100);
  await db.engineLease.update({ where: { worldId }, data: { expiresAt: new Date(0) } });
  const nextLease = (await acquireLease(db, worldId, randomUUID(), 120_000))!;
  expect(nextLease.fencingToken).toBeGreaterThan(lease.fencingToken);
  now += minute;
  const before = await replayHash(worldId);
  await expect(loop.advanceTo(10_000)).rejects.toBeInstanceOf(LeaseLostError);
  expect(await replayHash(worldId)).toBe(before);
  expect(await rows(worldId)).toHaveLength(1);
  const restarted = new TurnLoop(db, nextLease, { publicMapNow: () => now });
  await restarted.advanceTo(10_000);
  expect(await rows(worldId)).toHaveLength(1);
  now = epoch + 5 * minute;
  await restarted.advanceTo(10_100);
  expect(await rows(worldId)).toHaveLength(2);
});

it('밀린 월드는 사본의 실제 반영 tick을 쓰고 12개월 stateHash·v2 재생은 사본 유무와 같다', async () => {
  const { worldId, initial, lease } = await world();
  let calls = 0;
  const captured: Array<{ tick: number; year: number; month: number }> = [];
  const loop = new TurnLoop(db, lease, {
    publicMapNow: () => epoch + calls++ * 5 * minute,
    beforeCommit: async (tx) => {
      captured.push(
        await tx.publicMapSnapshot.findFirstOrThrow({
          where: { worldId },
          orderBy: { takenAt: 'desc' },
          select: { tick: true, year: true, month: true },
        }),
      );
    },
  });
  await loop.advanceTo(120_000);
  expect(captured[0]).toEqual({ tick: 100, year: initial.startYear, month: 1 });
  const snapshots = await rows(worldId);
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every((entry) => entry.tick <= 120_000)).toBe(true);
  for (const snapshot of snapshots) {
    expect(snapshot.year).toBe(initial.startYear + Math.floor(snapshot.tick / 120_000));
    expect(snapshot.month).toBe((Math.floor(snapshot.tick / 10_000) % 12) + 1);
  }
  const archive = await exportReplay(db, worldId);
  expect(archive.version).toBe(2);
  expect(replayArchive(archive, 12)).toHaveLength(12);
  let pure = initialReplayState(initial);
  while (pure.monthlyTick < 120_000) pure = runReplayAction(pure, initial.seed, initial.unitSet);
  const finalMonthly = archive.months[11]!;
  expect(finalMonthly.stateHash).toBe(hashState(pure));
  const before = await replayHash(worldId);
  await db.publicMapSnapshot.deleteMany({ where: { worldId } });
  expect(await replayHash(worldId)).toBe(before);
  expect(await exportReplay(db, worldId)).toEqual(archive);
});

it('실제로 종료하는 턴에서는 새 사본을 찍지 않고 마지막 사본과 종료 재생을 보존한다', async () => {
  const { worldId, initial, lease } = await world();
  await db.world.update({ where: { id: worldId }, data: { endYear: initial.startYear } });
  const loop = new TurnLoop(db, lease, { publicMapNow: () => now });
  await loop.advanceTo(119999);
  const before = await rows(worldId);
  now += 5 * minute;
  await loop.advanceTo(120000);
  expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).status).toBe('ENDED');
  expect(await rows(worldId)).toEqual(before);
  expect((await maps()).data?.worlds).toEqual([]);
  const archive = await exportReplay(db, worldId);
  expect(replayToEnd(archive).finalStateHash).toBe(archive.end!.finalStateHash);
});
