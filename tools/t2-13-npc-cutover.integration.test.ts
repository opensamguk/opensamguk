import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { emptyQueue, enableReplayPolicy } from '../packages/rules/src/index';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, LeaseLostError } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
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

async function human() {
  const user = await db.user.create({
    data: { email: `t213-cutover-${randomUUID()}@example.invalid`, passwordHash: 'fixture-only' },
  });
  users.push(user.id);
  return user.id;
}
async function fixture(options: { human?: boolean; empty?: boolean } = {}) {
  const initial = await monthlyFixture();
  if (options.empty) initial.generals = [];
  if (options.human) initial.generals[0]!.userId = await human();
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '방침 NPC 전환 시험',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 'legacy',
  });
  worlds.push(worldId);
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  return { worldId, initial, lease, loop: new TurnLoop(db, lease) };
}
async function marker(worldId: string) {
  const generals = await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
  const emptySlots: number[] = [];
  // 이 새 fixture 월드에만 migration의 누락 칸 준비를 재현한다. 보존 기준 월드는 건드리지 않는다.
  for (const general of generals) {
    let rows = await db.generalTurn.findMany({ where: { worldId, generalId: general.id } });
    if (!rows.length) {
      await db.generalTurn.createMany({
        data: emptyQueue().map((turn, slot) => ({ ...turn, args: {}, slot, worldId, generalId: general.id })),
      });
      rows = await db.generalTurn.findMany({ where: { worldId, generalId: general.id } });
    }
    if (rows.every((row) => !row.explicit)) emptySlots.push(general.id);
  }
  return db.inputEvent.create({
    data: {
      worldId,
      userId: 'system:policy',
      kind: 'system.policy.enable',
      idempotencyKey: 'system.policy.enable:5',
      payload: { version: 5, emptySlots },
    },
  });
}
async function snapshot(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    inputs: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
  };
}

it('옛 NPC 월드의 전환 전후 6개월과 재시작·coverage·해시가 일치한다', async () => {
  const f = await fixture();
  await controlClock(db, f.worldId, 'start');
  await f.loop.advanceTo(60000);
  const legacy = await exportReplay(db, f.worldId);
  expect(legacy.version).toBe(2);
  expect(replayArchive(legacy, 6)).toHaveLength(6);
  await controlClock(db, f.worldId, 'pause');
  const event = await marker(f.worldId);
  const before = await snapshot(f.worldId);
  const beforeReplay = await db.$transaction((tx) => loadReplayState(tx, f.worldId));
  await f.loop.poll();
  const after = await snapshot(f.worldId);
  const fromSequence = before.world.actionSequence + 1;
  expect(after.world).toEqual({ ...before.world, actionSequence: fromSequence, policyFromSequence: fromSequence });
  expect(after.generals).toEqual(
    before.generals.map((general) => ({ ...general, defaultPolicy: 'none', lastActiveTick: null, lastActiveAt: null })),
  );
  expect(after.turns).toEqual(before.turns);
  expect(after.inputs[0]).toMatchObject({
    id: event.id,
    userId: 'system:policy',
    status: 'APPLIED',
    sequence: fromSequence,
    result: {
      fromSequence,
      emptySlots: [3],
      clockTick: before.world.clockTick,
      turnTermMinutes: 30,
      baselineActiveTick: null,
    },
  });
  const activated = await db.$transaction((tx) => loadReplayState(tx, f.worldId));
  expect(activated).toEqual(enableReplayPolicy(beforeReplay, 30, null, [3]));
  expect(activated.policy!.lastActiveTicks).toEqual({});
  const prefix = await exportReplay(db, f.worldId);
  expect(prefix.version).toBe(5);
  expect(prefix.inputs).toHaveLength(0);
  expect(prefix.origin).toEqual(legacy.origin);
  expect(replayArchive(prefix, 6)).toEqual(replayArchive(legacy, 6));
  await controlClock(db, f.worldId, 'resume');
  const restarted = new TurnLoop(db, f.lease);
  await restarted.advanceTo(120000);
  const archive = await exportReplay(db, f.worldId);
  expect(archive.inputs[0]!.kind).toBe('system.policy.enable');
  expect(archive.months.slice(0, 6)).toEqual(legacy.months);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it.each([false, true])('PREOPEN은 기다리고 시작 뒤 첫 단계에서 집행한다(장수 없음=%s)', async (empty) => {
  const f = await fixture({ empty });
  await marker(f.worldId);
  const before = await snapshot(f.worldId);
  await f.loop.poll();
  expect(await snapshot(f.worldId)).toEqual(before);
  await controlClock(db, f.worldId, 'start');
  await f.loop.advanceTo(0);
  const state = await snapshot(f.worldId);
  expect(state.world).toMatchObject({ policyFromSequence: 1, actionSequence: 1 });
  expect(state.inputs[0]).toMatchObject({
    status: 'APPLIED',
    sequence: 1,
    result: { baselineActiveTick: null, clockTick: 0 },
  });
  expect(await db.generalLog.count({ where: { worldId: f.worldId } })).toBe(0);
});

it('RUNNING 전환은 진행 지평 대신 잠근 시계를 기록하고 다음 단계부터 게임 턴을 실행한다', async () => {
  const f = await fixture();
  await marker(f.worldId);
  await controlClock(db, f.worldId, 'start');
  let checked = false;
  const loop = new TurnLoop(db, f.lease, {
    beforeCommit: async (tx) => {
      if (checked) return;
      checked = true;
      const event = await tx.inputEvent.findFirstOrThrow({
        where: { worldId: f.worldId, kind: 'system.policy.enable' },
      });
      expect(event).toMatchObject({
        status: 'APPLIED',
        sequence: 1,
        result: { clockTick: 0, baselineActiveTick: null },
      });
      expect(await tx.generalLog.count({ where: { worldId: f.worldId } })).toBe(0);
      expect((await tx.world.findUniqueOrThrow({ where: { id: f.worldId } })).clockTick).toBe(0);
    },
  });
  const executions = await loop.advanceTo(100);
  expect(checked).toBe(true);
  expect(executions).toEqual([{ generalId: 1, tick: 100, commandKey: expect.any(String) }]);
  expect((await snapshot(f.worldId)).world).toMatchObject({ clockTick: 100, actionSequence: 2, policyFromSequence: 1 });
});

it('commit 실패는 F·순서·장수·표지를 모두 되돌리고 재시도는 한 번만 집행한다', async () => {
  const f = await fixture();
  await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED' } });
  await marker(f.worldId);
  const before = await snapshot(f.worldId);
  const failing = new TurnLoop(db, f.lease, {
    beforeCommit: async () => {
      throw new Error('전환 commit 중단');
    },
  });
  await expect(failing.poll()).rejects.toThrow('전환 commit 중단');
  expect(await snapshot(f.worldId)).toEqual(before);
  await f.loop.poll();
  const after = await snapshot(f.worldId);
  expect(after.world).toMatchObject({ policyFromSequence: 1, actionSequence: 1 });
  await new TurnLoop(db, f.lease).poll();
  expect(await snapshot(f.worldId)).toEqual(after);
});

it('오래된 리스는 전환을 못 쓰고 새 리스만 집행한다', async () => {
  const f = await fixture();
  await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED' } });
  await marker(f.worldId);
  await releaseLease(db, f.lease);
  const next = (await acquireLease(db, f.worldId))!;
  leases.push(next);
  expect(next.fencingToken).toBeGreaterThan(f.lease.fencingToken);
  const before = await snapshot(f.worldId);
  await expect(f.loop.poll()).rejects.toBeInstanceOf(LeaseLostError);
  expect(await snapshot(f.worldId)).toEqual(before);
  await new TurnLoop(db, next).poll();
  expect((await snapshot(f.worldId)).world.policyFromSequence).toBe(1);
});

it('기존 사람 장수와 표지 앞 생성으로 생긴 사람 장수는 기준 선택 없이 기다린다', async () => {
  for (const existing of [true, false]) {
    const f = await fixture({ human: existing });
    if (existing) await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED' } });
    else await controlClock(db, f.worldId, 'start');
    if (!existing) {
      const total = f.initial.statRules.total,
        part = Math.floor(total / 3);
      await db.inputEvent.create({
        data: {
          worldId: f.worldId,
          userId: await human(),
          kind: 'general.create',
          idempotencyKey: randomUUID(),
          payload: { name: '전환전장수', leadership: part, strength: part, intel: total - part * 2, portraitId: null },
        },
      });
    }
    const event = await marker(f.worldId);
    await f.loop.advanceTo(0);
    const after = await snapshot(f.worldId);
    expect(after.world).toMatchObject({ policyFromSequence: null, actionSequence: existing ? 0 : 1 });
    expect(after.inputs.find((input) => input.id === event.id)).toMatchObject({
      status: 'PENDING',
      sequence: null,
      result: null,
    });
    expect(
      after.generals.every(
        (general) => general.lastActiveTick === null && general.lastActiveAt === null && general.defaultPolicy === null,
      ),
    ).toBe(true);
    if (!existing) {
      const created = after.inputs[0]!;
      expect(created.status).toBe('APPLIED');
      expect(created.result).not.toHaveProperty('activeTick');
      expect(after.turns.filter((turn) => turn.generalId === created.generalId).map((turn) => turn.explicit)).toEqual(
        Array.from({ length: 30 }, () => true),
      );
    }
    expect(await db.generalLog.count({ where: { worldId: f.worldId } })).toBe(0);
  }
});

it.each(['ENDED', 'futureF', 'userId', 'generalId', 'key', 'emptySlots', 'partial', 'overflow'] as const)(
  '%s 손상은 표지와 세계를 그대로 두고 되돌린다',
  async (invalid) => {
    const f = await fixture();
    await db.world.update({ where: { id: f.worldId }, data: { status: 'PAUSED' } });
    const event = await marker(f.worldId);
    if (invalid === 'ENDED') await db.world.update({ where: { id: f.worldId }, data: { status: 'ENDED' } });
    if (invalid === 'futureF') await db.world.update({ where: { id: f.worldId }, data: { policyFromSequence: 100 } });
    if (invalid === 'userId') await db.inputEvent.update({ where: { id: event.id }, data: { userId: 'other' } });
    if (invalid === 'generalId') await db.inputEvent.update({ where: { id: event.id }, data: { generalId: 1 } });
    if (invalid === 'key') await db.inputEvent.update({ where: { id: event.id }, data: { idempotencyKey: 'other' } });
    if (invalid === 'emptySlots')
      await db.inputEvent.update({ where: { id: event.id }, data: { payload: { version: 5, emptySlots: [] } } });
    if (invalid === 'partial')
      await db.generalTurn.delete({
        where: { worldId_generalId_slot: { worldId: f.worldId, generalId: 1, slot: 29 } },
      });
    if (invalid === 'overflow')
      await db.world.update({ where: { id: f.worldId }, data: { actionSequence: 2_147_483_647 } });
    const before = await snapshot(f.worldId);
    await expect(f.loop.poll()).rejects.toThrow();
    expect(await snapshot(f.worldId)).toEqual(before);
  },
);

it('DB CHECK는 PENDING 표지의 sequence·result 모순을 저장 전에 막는다', async () => {
  const f = await fixture();
  const event = await marker(f.worldId);
  for (const data of [{ sequence: 1 }, { result: {} }]) {
    await expect(db.inputEvent.update({ where: { id: event.id }, data })).rejects.toThrow('InputEvent_completion');
  }
  expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
    status: 'PENDING',
    sequence: null,
    result: null,
  });
});
