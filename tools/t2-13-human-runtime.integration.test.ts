import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { checkReplayOrigin, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { renewLeaseDuringTest } from '../apps/engine/test/leaseHeartbeat';
import { saveFixtureWorld } from '../e2e/worldFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, LeaseLostError } from '../apps/engine/src/lease';
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
    name: '상시 방침 human-runtime',
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
it('AC-INT-28 생성 때부터 형식3·상시 방침을 준비하고 전환 입력이 없다', async () => {
  const f = await fixture();
  const state = await snapshot(f.worldId);
  expect(state.world).toMatchObject({ replayFormat: 3, policyFromSequence: null });
  checkReplayOrigin(state.world.replayOrigin);
  expect(state.world.replayOrigin).toMatchObject({
    version: 3,
    featureData: { policy: { version: 1, turnTermMinutes: 30 } },
  });
  expect(state.inputs.some((input) => input.kind === 'system.policy.enable')).toBe(false);
  expect(state.generals.every((g) => g.defaultPolicy === 'none')).toBe(true);
  expect(state.turns).toHaveLength(state.generals.length * 30);
});
it.each(['legacy', 'policy', 1] as const)(
  '새 월드의 구형 생성 옵션 %s를 트랜잭션 전에 거부한다',
  async (replayFormat) => {
    const initial = await monthlyFixture();
    const count = await db.world.count();
    await expect(
      saveInitialWorld(db, initial, { name: '구형 생성 거부', turnTermMinutes: 30, endYear: null, replayFormat }),
    ).rejects.toThrow('새 월드는 재생 형식 3만 사용합니다.');
    expect(await db.world.count()).toBe(count);
  },
);
it('PREOPEN은 게임 턴을 진행하지 않고 RUNNING 재시작은 같은 월간 기록을 재생한다', async () => {
  const f = await fixture();
  renewLeaseDuringTest(db, f.lease);
  const before = await snapshot(f.worldId);
  await f.loop.advanceTo(0);
  expect(await snapshot(f.worldId)).toEqual(before);
  await controlClock(db, f.worldId, 'start');
  await f.loop.advanceTo(6 * TICKS_PER_MONTH);
  const first = await exportReplay(db, f.worldId);
  expect(first.version).toBe(3);
  expect(replayArchive(first, 6)).toEqual(first.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  await new TurnLoop(db, f.lease).advanceTo(12 * TICKS_PER_MONTH);
  const archive = await exportReplay(db, f.worldId);
  expect(archive.months.slice(0, 6)).toEqual(first.months);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(archive.inputs.some((input) => input.kind === 'system.policy.enable')).toBe(false);
}, 120_000);
it('오래된 실행권은 상태를 바꾸지 못하고 새 실행권만 턴을 진행한다', async () => {
  const f = await fixture();
  await controlClock(db, f.worldId, 'start');
  await releaseLease(db, f.lease);
  const next = await acquireLease(db, f.worldId);
  if (!next) throw Error('새 실행권이 없습니다.');
  leases.push(next);
  const before = await snapshot(f.worldId);
  await expect(f.loop.advanceTo(100)).rejects.toBeInstanceOf(LeaseLostError);
  expect(await snapshot(f.worldId)).toEqual(before);
  await new TurnLoop(db, next).advanceTo(100);
  expect((await snapshot(f.worldId)).world.policyFromSequence).toBeNull();
});

async function enqueue(f: Awaited<ReturnType<typeof fixture>>, policy: unknown = 'farm', userId = f.actor.id) {
  return db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId,
      generalId: f.initial.generals[0]!.id,
      kind: 'general.setPolicy',
      idempotencyKey: randomUUID(),
      payload: { policy } as { policy: string },
    },
  });
}
it('사람 소유권은 생성 원본에 넣지 않고 실제 맡기 입력과 함께 기록한다', async () => {
  const f = await fixture();
  const state = await snapshot(f.worldId);
  const origin = state.world.replayOrigin as { initial: { generals: { userId: string | null }[] } };
  expect(origin.initial.generals.every((g) => g.userId === null)).toBe(true);
  expect(state.generals[0]!.userId).toBe(f.actor.id);
  expect(state.inputs).toMatchObject([{ kind: 'general.possess', status: 'APPLIED' }]);
});
it('PAUSED 입력의 commit 실패는 전체 상태를 되돌리고 재시작은 한 번만 적용한다', async () => {
  const f = await fixture();
  await controlClock(db, f.worldId, 'start');
  await controlClock(db, f.worldId, 'pause');
  const input = await enqueue(f);
  const before = await snapshot(f.worldId);
  const failed = new TurnLoop(db, f.lease, {
    beforeCommit: async () => {
      throw Error('입력 commit 중단');
    },
  });
  await expect(failed.poll()).rejects.toThrow('입력 commit 중단');
  expect(await snapshot(f.worldId)).toEqual(before);
  await new TurnLoop(db, f.lease).poll();
  const after = await snapshot(f.worldId);
  expect(after.inputs.find((row) => row.id === input.id)).toMatchObject({ status: 'APPLIED' });
  expect(after.generals[0]!.defaultPolicy).toBe('farm');
  expect(after.world.actionSequence).toBe(before.world.actionSequence + 1);
  await new TurnLoop(db, f.lease).poll();
  expect(await snapshot(f.worldId)).toEqual(after);
});
it.each(['invalid', 'foreign', 'sanctioned'] as const)(
  '실제 방침 입력의 %s 오류는 장수·예턴을 바꾸지 않는다',
  async (mode) => {
    const f = await fixture();
    await controlClock(db, f.worldId, 'start');
    await controlClock(db, f.worldId, 'pause');
    if (mode === 'sanctioned') await db.user.update({ where: { id: f.actor.id }, data: { status: 'SANCTIONED' } });
    const input = await enqueue(
      f,
      mode === 'invalid' ? 'missing' : 'farm',
      mode === 'foreign' ? 'missing-user' : f.actor.id,
    );
    const before = await snapshot(f.worldId);
    await f.loop.poll();
    const after = await snapshot(f.worldId);
    expect(after.generals).toEqual(before.generals);
    expect(after.turns).toEqual(before.turns);
    expect(after.inputs.find((row) => row.id === input.id)).toMatchObject({ status: 'REJECTED' });
  },
);
