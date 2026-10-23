import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { createDb, nextActionSequence } from '../packages/db/src/index';
import { emptyQueue, emptyTurns, isInactive } from '../packages/rules/src/index';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, lockLease, assertLease, LeaseLostError } from '../apps/engine/src/lease';
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
async function user() {
  const row = await db.user.create({
    data: { email: `t213-runtime-${randomUUID()}@example.invalid`, passwordHash: 'fixture-only' },
  });
  users.push(row.id);
  return row.id;
}
async function fixture(tick = 60000) {
  const initial = await monthlyFixture();
  for (const general of initial.generals.slice(0, 2)) general.userId = await user();
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '방침 사람 정상 T 시험',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 'legacy',
  });
  worlds.push(worldId);
  for (const general of initial.generals.filter((general) => general.userId !== null))
    await db.generalTurn.createMany({
      data: emptyTurns().map((turn, slot) => ({
        ...turn,
        args: {},
        explicit: true,
        slot,
        worldId,
        generalId: general.id,
      })),
    });
  await db.world.update({ where: { id: worldId }, data: { status: 'PAUSED', clockTick: tick } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  return { worldId, initial, lease, loop: new TurnLoop(db, lease) };
}
async function marker(worldId: string) {
  const generals = await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
  const emptySlots: number[] = [];
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

it('PAUSED 정상 T는 원자 저장하고 활동 시각 없음·14일 경계·정지 시간을 보존한다', async () => {
  const f = await fixture(6_730_000);
  await marker(f.worldId);
  const before = await snapshot(f.worldId);
  await f.loop.poll();
  const after = await snapshot(f.worldId),
    baseline = before.world.clockTick;
  expect(after.world).toEqual({ ...before.world, policyFromSequence: 1, actionSequence: 1 });
  expect(after.turns).toEqual(before.turns);
  expect(after.generals).toEqual(
    before.generals.map((general) => ({
      ...general,
      defaultPolicy: 'none',
      lastActiveTick: general.userId === null ? null : baseline,
      lastActiveAt: null,
    })),
  );
  expect(after.inputs[0]).toMatchObject({
    status: 'APPLIED',
    sequence: 1,
    result: { fromSequence: 1, clockTick: baseline, baselineActiveTick: baseline },
  });
  const replay = await db.$transaction((tx) => loadReplayState(tx, f.worldId));
  expect(replay.policy!.lastActiveTicks).toEqual({ 1: baseline, 2: baseline });
  const realAt = Date.now();
  expect((await controlClock(db, f.worldId, 'status', realAt + 365 * 86400000)).tick).toBe(baseline);
  expect(await snapshot(f.worldId)).toEqual(after);
  const boundary = baseline + 6_720_000;
  for (const tick of [boundary, boundary + 1]) {
    await db.world.update({ where: { id: f.worldId }, data: { clockTick: tick } });
    const current = await snapshot(f.worldId);
    for (const general of current.generals.filter((general) => general.userId !== null))
      expect(isInactive(general.lastActiveTick!, current.world.clockTick, 30)).toBe(tick > boundary);
    expect(current.generals[2]!.lastActiveTick).toBeNull();
    expect(current.generals.every((general) => general.lastActiveAt === null)).toBe(true);
  }
});

async function oldCommand(f: Awaited<ReturnType<typeof fixture>>) {
  await db.$transaction(async (tx) => {
    await lockLease(tx, f.lease);
    await tx.$queryRaw`SELECT id FROM "World" WHERE id=${f.worldId} FOR UPDATE`;
    const turns = emptyTurns();
    turns[0] = { commandKey: 'farm', args: {} };
    turns[7] = { commandKey: 'farm', args: {} };
    await tx.generalTurn.deleteMany({ where: { worldId: f.worldId, generalId: 1 } });
    await tx.generalTurn.createMany({
      data: turns.map((turn, slot) => ({ ...turn, args: {}, explicit: true, slot, worldId: f.worldId, generalId: 1 })),
    });
    await tx.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { turnRevision: 1 } });
    await tx.inputEvent.create({
      data: {
        worldId: f.worldId,
        generalId: 1,
        userId: f.initial.generals[0]!.userId!,
        kind: 'turns.set',
        idempotencyKey: randomUUID(),
        status: 'APPLIED',
        sequence: await nextActionSequence(tx, f.worldId),
        payload: { turns, revision: 0 },
        result: { revision: 1 },
      },
    });
    await assertLease(tx, f.lease);
  });
}

it('정상 RUNNING은 지평과 다른 잠근 T로 전환하고 옛 생성 포함 6+6개월을 재생한다', async () => {
  const f = await fixture(0),
    oldUser = await user();
  const part = Math.floor(f.initial.statRules.total / 3);
  await db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: oldUser,
      kind: 'general.create',
      idempotencyKey: randomUUID(),
      payload: {
        name: '정상전환장수',
        leadership: part,
        strength: part,
        intel: f.initial.statRules.total - part * 2,
        portraitId: null,
      },
    },
  });
  await controlClock(db, f.worldId, 'resume');
  await f.loop.advanceTo(0);
  await oldCommand(f);
  await f.loop.advanceTo(60000);
  await controlClock(db, f.worldId, 'pause');
  const legacy = await exportReplay(db, f.worldId),
    legacyBytes = JSON.stringify(legacy);
  expect(legacy.version).toBe(2);
  const firstSix = replayArchive(legacy, 6);
  await marker(f.worldId);
  await controlClock(db, f.worldId, 'resume');
  const before = await snapshot(f.worldId),
    fromSequence = before.world.actionSequence + 1;
  const baseline = before.world.clockTick;
  let observed = false;
  const loop = new TurnLoop(db, f.lease, {
    beforeCommit: async (tx) => {
      if (observed) return;
      observed = true;
      const world = await tx.world.findUniqueOrThrow({ where: { id: f.worldId } });
      expect(world).toEqual({ ...before.world, actionSequence: fromSequence, policyFromSequence: fromSequence });
      expect(
        await tx.generalTurn.findMany({
          where: { worldId: f.worldId },
          orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
        }),
      ).toEqual(before.turns);
      expect(
        await tx.inputEvent.findFirst({ where: { worldId: f.worldId, kind: 'system.policy.enable' } }),
      ).toMatchObject({
        status: 'APPLIED',
        sequence: fromSequence,
        result: { clockTick: baseline, baselineActiveTick: baseline },
      });
    },
  });
  await loop.advanceTo(baseline + 1);
  expect(observed).toBe(true);
  const transitioned = await snapshot(f.worldId);
  expect(
    transitioned.generals
      .filter((general) => general.userId !== null)
      .every((general) => general.lastActiveTick === baseline && general.lastActiveAt === null),
  ).toBe(true);
  expect(transitioned.generals.find((general) => general.userId === oldUser)).toBeDefined();
  const prefix = await exportReplay(db, f.worldId);
  expect(prefix.version).toBe(5);
  expect(prefix.origin).toEqual(legacy.origin);
  expect(prefix.inputs).toEqual(legacy.inputs);
  expect(prefix.months).toEqual(legacy.months);
  expect(replayArchive(prefix, 6)).toEqual(firstSix);
  expect(JSON.stringify(legacy)).toBe(legacyBytes);
  await new TurnLoop(db, f.lease).advanceTo(120000);
  const archive = await exportReplay(db, f.worldId);
  expect(archive.inputs.filter((input) => input.kind === 'system.policy.enable')).toHaveLength(1);
  expect(archive.months.slice(0, 6)).toEqual(legacy.months);
  const expected = archive.months.map(({ tick, stateHash }) => ({ tick, stateHash }));
  expect(replayArchive(archive, 12)).toEqual(expected);
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1);
  try {
    expect(replayArchive(archive, 12)).toEqual(expected);
  } finally {
    wall.mockRestore();
  }
  const after = await snapshot(f.worldId);
  await new TurnLoop(db, f.lease).advanceTo(120000);
  expect((await snapshot(f.worldId)).world.actionSequence).toBe(after.world.actionSequence);
  for (const [tick, commandKey] of [
    [60100, 'rest'],
    [70100, 'farm'],
  ] as const) {
    const log = await db.generalLog.findFirstOrThrow({
      where: { worldId: f.worldId, generalId: 1, tick, sequence: null },
    });
    expect(log.commandKey).toBe(commandKey);
    expect(log.text).not.toContain('기본 방침');
  }
});

it('정상 T의 beforeCommit 실패는 모두 되돌리고 재시작은 F를 한 번만 저장한다', async () => {
  const f = await fixture();
  await marker(f.worldId);
  const before = await snapshot(f.worldId);
  const failed = new TurnLoop(db, f.lease, {
    beforeCommit: async () => {
      throw new Error('정상 T commit 중단');
    },
  });
  await expect(failed.poll()).rejects.toThrow('정상 T commit 중단');
  expect(await snapshot(f.worldId)).toEqual(before);
  await new TurnLoop(db, f.lease).poll();
  const after = await snapshot(f.worldId);
  expect(after.world).toMatchObject({ actionSequence: 1, policyFromSequence: 1 });
  expect(after.inputs[0]).toMatchObject({ status: 'APPLIED', sequence: 1 });
  await new TurnLoop(db, f.lease).poll();
  expect(await snapshot(f.worldId)).toEqual(after);
});

it('오래된 정상 루프는 T를 적용하지 못하고 새 리스만 전환한다', async () => {
  const f = await fixture();
  await marker(f.worldId);
  await releaseLease(db, f.lease);
  const next = (await acquireLease(db, f.worldId))!;
  leases.push(next);
  const before = await snapshot(f.worldId);
  await expect(f.loop.poll()).rejects.toBeInstanceOf(LeaseLostError);
  expect(await snapshot(f.worldId)).toEqual(before);
  await new TurnLoop(db, next).poll();
  expect((await snapshot(f.worldId)).world).toMatchObject({ policyFromSequence: 1, actionSequence: 1 });
});

it('사람 PREOPEN은 기다리고 시작 뒤 첫 단계에서 T 0을 기록한다', async () => {
  const f = await fixture(0);
  await marker(f.worldId);
  await db.world.update({ where: { id: f.worldId }, data: { status: 'PREOPEN' } });
  const before = await snapshot(f.worldId);
  await f.loop.poll();
  expect(await snapshot(f.worldId)).toEqual(before);
  await controlClock(db, f.worldId, 'start');
  await new TurnLoop(db, f.lease).advanceTo(0);
  const after = await snapshot(f.worldId);
  expect(after.inputs[0]).toMatchObject({
    status: 'APPLIED',
    sequence: 1,
    result: { clockTick: 0, baselineActiveTick: 0 },
  });
  expect(
    after.generals
      .filter((general) => general.userId !== null)
      .every((general) => general.lastActiveTick === 0 && general.lastActiveAt === null),
  ).toBe(true);
  expect(await db.generalLog.count({ where: { worldId: f.worldId } })).toBe(0);
});

it.each(['partial', 'key'] as const)('정상 T도 %s 손상 표지를 우회하지 않는다', async (invalid) => {
  const f = await fixture();
  const event = await marker(f.worldId);
  if (invalid === 'partial')
    await db.generalTurn.delete({
      where: { worldId_generalId_slot: { worldId: f.worldId, generalId: 1, slot: 29 } },
    });
  else await db.inputEvent.update({ where: { id: event.id }, data: { idempotencyKey: 'other' } });
  const before = await snapshot(f.worldId);
  await expect(f.loop.poll()).rejects.toThrow();
  expect(await snapshot(f.worldId)).toEqual(before);
});
