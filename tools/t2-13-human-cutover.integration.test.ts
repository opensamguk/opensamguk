import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { renewLeaseDuringTest } from '../apps/engine/test/leaseHeartbeat';
import { saveFixtureWorld } from '../e2e/worldFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [],
  users: string[] = [];
const leases: NonNullable<Awaited<ReturnType<typeof acquireLease>>>[] = [];
afterAll(async () => {
  for (const lease of leases) await releaseLease(db, lease);
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function fixture(empty = false) {
  const initial = await monthlyFixture();
  if (empty) initial.generals = [];
  const actor = await db.user.create({ data: { email: randomUUID() + '@example.test', passwordHash: 'fixture-only' } });
  users.push(actor.id);
  initial.generals[0]!.userId = actor.id;
  const saved = await saveFixtureWorld(db, initial, {
    name: '상시 방침 human-cutover',
    turnTermMinutes: 30,
    endYear: null,
  });
  worlds.push(saved.worldId);
  const lease = await acquireLease(db, saved.worldId);
  if (!lease) throw Error('시험 실행권이 없습니다.');
  leases.push(lease);
  return { ...saved, initial, lease, loop: new TurnLoop(db, lease), actor };
}
async function snapshot(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    inputs: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
  };
}

const payload = {
  name: '새방침장수',
  leadership: 55,
  strength: 55,
  intel: 55,
  politics: 55,
  charm: 55,
  sex: 'MALE',
  portraitId: null,
};
async function newcomer() {
  const user = await db.user.create({ data: { email: randomUUID() + '@example.test', passwordHash: 'fixture-only' } });
  users.push(user.id);
  return user.id;
}
async function enqueue(worldId: string, userId: string, value: unknown = payload) {
  return db.inputEvent.create({
    data: { worldId, userId, kind: 'general.create', idempotencyKey: randomUUID(), payload: value as typeof payload },
  });
}
it('AC-INT-28 생성 원본에 사람 소유자를 넣으면 트랜잭션 전에 거부한다', async () => {
  const f = await fixture();
  const count = await db.world.count();
  await expect(
    saveInitialWorld(db, f.initial, { name: '원본 사람 거부', turnTermMinutes: 30, endYear: null }),
  ).rejects.toThrow('인사 생성 기록에는 기존 사람 장수나 추정 앵커를 넣을 수 없습니다.');
  expect(await db.world.count()).toBe(count);
});
it('공식 맡기 입력은 생성 원본을 보존하고 초기 revision을 한 번만 올린다', async () => {
  const f = await fixture();
  const state = await snapshot(f.worldId);
  expect(state.inputs).toMatchObject([{ kind: 'general.possess', status: 'APPLIED', sequence: 1 }]);
  expect(state.generals[0]).toMatchObject({ userId: f.actor.id, turnRevision: 1, defaultPolicy: 'none' });
  expect(
    (state.world.replayOrigin as { initial: { generals: { userId: string | null }[] } }).initial.generals.every(
      (g) => g.userId === null,
    ),
  ).toBe(true);
});
it.each(['PREOPEN', 'PAUSED', 'ENDED'] as const)(
  '%s의 생성 입력은 종료 이유를 기록하고 장수를 만들지 않는다',
  async (status) => {
    const f = await fixture();
    const userId = await newcomer();
    await db.world.update({ where: { id: f.worldId }, data: { status } });
    const event = await enqueue(f.worldId, userId);
    await f.loop.advanceTo(0);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'REJECTED',
      result: { code: 'WORLD_CLOSED' },
    });
    expect(await db.general.count({ where: { worldId: f.worldId, userId } })).toBe(0);
  },
);
it.each(['stats', 'sex'] as const)('현행 생성 입력의 잘못된 %s는 원자 거절된다', async (mode) => {
  const f = await fixture();
  const userId = await newcomer();
  await controlClock(db, f.worldId, 'start');
  const event = await enqueue(
    f.worldId,
    userId,
    mode === 'stats' ? { ...payload, charm: 56 } : { ...payload, sex: 'invalid' },
  );
  const before = await snapshot(f.worldId);
  await f.loop.advanceTo(0);
  const after = await snapshot(f.worldId);
  expect(after.generals).toEqual(before.generals);
  expect(after.turns).toEqual(before.turns);
  expect(after.inputs.find((row) => row.id === event.id)).toMatchObject({ status: 'REJECTED' });
});
it('생성 commit 실패는 장수·예턴·인사 원장·입력을 되돌리고 재시작은 한 번만 생성한다', async () => {
  const f = await fixture();
  const userId = await newcomer();
  await controlClock(db, f.worldId, 'start');
  const event = await enqueue(f.worldId, userId);
  const before = await snapshot(f.worldId);
  const failed = new TurnLoop(db, f.lease, {
    beforeCommit: async () => {
      throw Error('사람 생성 commit 중단');
    },
  });
  await expect(failed.advanceTo(0)).rejects.toThrow('사람 생성 commit 중단');
  expect(await snapshot(f.worldId)).toEqual(before);
  await new TurnLoop(db, f.lease).advanceTo(0);
  await new TurnLoop(db, f.lease).advanceTo(0);
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: 'APPLIED' });
  expect(await db.general.count({ where: { worldId: f.worldId, userId } })).toBe(1);
});
it('중복 생성 입력은 장수 한 명을 기록하고 기존 사람·새 사람과 12개월을 재생한다', async () => {
  const f = await fixture();
  renewLeaseDuringTest(db, f.lease);
  const userId = await newcomer();
  await controlClock(db, f.worldId, 'start');
  const first = await enqueue(f.worldId, userId),
    second = await enqueue(f.worldId, userId);
  await f.loop.advanceTo(0);
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'APPLIED' });
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
    status: 'REJECTED',
    result: { code: 'ALREADY_EXISTS' },
  });
  const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: f.worldId, userId } } });
  expect(general).toMatchObject({ defaultPolicy: 'none', leadership: 55, politics: 55, charm: 55 });
  expect(await db.generalTurn.count({ where: { worldId: f.worldId, generalId: general.id } })).toBe(30);
  await new TurnLoop(db, f.lease).advanceTo(12 * TICKS_PER_MONTH);
  const archive = await exportReplay(db, f.worldId);
  expect(archive.version).toBe(3);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
}, 120_000);
