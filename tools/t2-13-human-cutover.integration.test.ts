import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { createDb, nextActionSequence } from '../packages/db/src/index';
import { emptyQueue, emptyTurns, isInactive } from '../packages/rules/src/index';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, lockLease, assertLease, LeaseLostError } from '../apps/engine/src/lease';
import { processPendingInput } from '../apps/engine/src/inputs';
import { TurnLoop } from '../apps/engine/src/turnLoop';
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
    data: { email: `t213-human-${randomUUID()}@example.invalid`, passwordHash: 'fixture-only' },
  });
  users.push(row.id);
  return row.id;
}
async function fixture(humans = 2, tick = 60000) {
  const initial = await monthlyFixture();
  for (let index = 0; index < humans; index++) initial.generals[index]!.userId = await user();
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '방침 사람 명시 인자 시험',
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
// 소유 fixture의 준비 검증에만 쓴다. 운영 호출·설정으로 노출하지 않으며 일반 TurnLoop는 값을 넘기지 않는다.
async function explicit(f: Awaited<ReturnType<typeof fixture>>, baseline?: number, rollback = false) {
  return db.$transaction(async (tx) => {
    await lockLease(tx, f.lease);
    await tx.$queryRaw`SELECT id FROM "World" WHERE id=${f.worldId} FOR UPDATE`;
    const world = await tx.world.findUniqueOrThrow({ where: { id: f.worldId } });
    const result = await processPendingInput(tx, world, world.clockTick + 100, baseline);
    if (rollback) throw new Error('명시 전환 commit 중단');
    await assertLease(tx, f.lease);
    return result;
  });
}

it.each(['zero', 'tick'] as const)(
  '명시 %s fixture만 원자 전환하며 사람·NPC 활동과 30칸·시계를 보존한다',
  async (candidate) => {
    const f = await fixture(2, 6_730_000);
    const event = await marker(f.worldId);
    const before = await snapshot(f.worldId);
    const baseline = candidate === 'zero' ? 0 : before.world.clockTick;
    expect(await explicit(f, baseline)).toBe(true);
    const after = await snapshot(f.worldId);
    expect(after.world).toEqual({ ...before.world, actionSequence: 1, policyFromSequence: 1 });
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
      id: event.id,
      status: 'APPLIED',
      sequence: 1,
      result: { fromSequence: 1, emptySlots: [3], clockTick: before.world.clockTick, baselineActiveTick: baseline },
    });
    for (const general of after.generals.filter((general) => general.userId !== null)) {
      expect(general.lastActiveAt).toBeNull();
      expect(isInactive(general.lastActiveTick!, after.world.clockTick, 30)).toBe(candidate === 'zero');
    }
  },
);

async function seedOldCommand(f: Awaited<ReturnType<typeof fixture>>) {
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
it.each(['zero', 'tick'] as const)(
  '명시 %s fixture의 전환 전후 6개월을 재생하고 일반 호출은 선택하지 않는다',
  async (candidate) => {
    const f = await fixture(2, 0);
    const oldUser = await user();
    const oldPart = Math.floor(f.initial.statRules.total / 3);
    const oldCreation = await db.inputEvent.create({
      data: {
        worldId: f.worldId,
        userId: oldUser,
        kind: 'general.create',
        idempotencyKey: randomUUID(),
        payload: {
          name: '옛생성장수',
          leadership: oldPart,
          strength: oldPart,
          intel: f.initial.statRules.total - oldPart * 2,
          portraitId: null,
        },
      },
    });
    await controlClock(db, f.worldId, 'resume');
    await f.loop.advanceTo(0);
    const oldApplied = await db.inputEvent.findUniqueOrThrow({ where: { id: oldCreation.id } });
    expect(oldApplied).toMatchObject({ status: 'APPLIED', sequence: 1 });
    expect(oldApplied.result).not.toHaveProperty('activeTick');
    const oldGeneral = await db.general.findFirstOrThrow({ where: { worldId: f.worldId, userId: oldUser } });
    expect(oldGeneral).toMatchObject({ lastActiveTick: null, lastActiveAt: null });
    const oldTurns = await db.generalTurn.findMany({ where: { worldId: f.worldId, generalId: oldGeneral.id } });
    expect(oldTurns).toHaveLength(30);
    expect(oldTurns.every((turn) => turn.explicit)).toBe(true);
    await seedOldCommand(f);
    await f.loop.advanceTo(60000);
    const legacy = await exportReplay(db, f.worldId);
    expect(legacy.version).toBe(2);
    expect(replayArchive(legacy, 6)).toHaveLength(6);
    await controlClock(db, f.worldId, 'pause');
    await marker(f.worldId);
    const before = await snapshot(f.worldId);
    await f.loop.poll();
    expect(await snapshot(f.worldId)).toEqual(before);
    const baseline = candidate === 'zero' ? 0 : before.world.clockTick;
    await explicit(f, baseline);
    const cutover = await snapshot(f.worldId);
    expect(cutover.turns).toEqual(before.turns);
    expect(cutover.generals.every((general) => general.lastActiveAt === null)).toBe(true);
    expect(cutover.generals.find((general) => general.userId === oldUser)).toMatchObject({ lastActiveTick: baseline });
    const prefix = await exportReplay(db, f.worldId);
    expect(prefix.version).toBe(5);
    expect(prefix.origin).toEqual(legacy.origin);
    expect(prefix.inputs.some((input) => input.kind === 'system.policy.enable')).toBe(false);
    expect(replayArchive(prefix, 6)).toEqual(replayArchive(legacy, 6));
    const newUser = await user();
    const part = Math.floor(f.initial.statRules.total / 3);
    for (const data of [
      { userId: f.initial.generals[0]!.userId!, generalId: 1, kind: 'general.setPolicy', payload: { policy: 'farm' } },
      { userId: f.initial.generals[1]!.userId!, generalId: 2, kind: 'general.active', payload: {} },
      {
        userId: newUser,
        generalId: null,
        kind: 'general.create',
        payload: {
          name: '명시후장수',
          leadership: part,
          strength: part,
          intel: f.initial.statRules.total - part * 2,
          portraitId: null,
        },
      },
    ])
      await db.inputEvent.create({ data: { ...data, worldId: f.worldId, idempotencyKey: randomUUID() } });
    await controlClock(db, f.worldId, 'resume');
    await new TurnLoop(db, f.lease).advanceTo(120000);
    const archive = await exportReplay(db, f.worldId);
    expect(archive.months.slice(0, 6)).toEqual(legacy.months);
    expect(archive.inputs.filter((input) => input.kind === 'general.create')).toHaveLength(2);
    expect(archive.inputs.every((input) => input.status === 'APPLIED')).toBe(true);
    const expected = archive.months.map(({ tick, stateHash }) => ({ tick, stateHash }));
    expect(replayArchive(archive, 12)).toEqual(expected);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      expect(replayArchive(archive, 12)).toEqual(expected);
    } finally {
      wall.mockRestore();
    }
    const rest = await db.generalLog.findUniqueOrThrow({
      where: { worldId_generalId_tick: { worldId: f.worldId, generalId: 1, tick: 60100 } },
    });
    expect(rest.commandKey).toBe('rest');
    expect(rest.text).not.toContain('기본 방침');
    const farm = await db.generalLog.findUniqueOrThrow({
      where: { worldId_generalId_tick: { worldId: f.worldId, generalId: 1, tick: 70100 } },
    });
    expect(farm.commandKey).toBe('farm');
    expect(farm.text).not.toContain('기본 방침');
  },
);

it.each(['zero', 'tick'] as const)('명시 %s의 commit 실패는 사람 값·F·표지까지 모두 되돌린다', async (candidate) => {
  const f = await fixture();
  await marker(f.worldId);
  const before = await snapshot(f.worldId);
  const baseline = candidate === 'zero' ? 0 : before.world.clockTick;
  await expect(explicit(f, baseline, true)).rejects.toThrow('명시 전환 commit 중단');
  expect(await snapshot(f.worldId)).toEqual(before);
  await f.loop.poll();
  expect(await snapshot(f.worldId)).toEqual(before);
  await explicit(f, baseline);
  expect((await snapshot(f.worldId)).world.policyFromSequence).toBe(1);
});

it('두 후보 이외의 인자는 실제 트랜잭션에서 쓰기 없이 거부한다', async () => {
  const f = await fixture();
  await marker(f.worldId);
  const before = await snapshot(f.worldId);
  for (const baseline of [1, 59999, 60001, 60100, 0.5, -1, NaN, Infinity]) {
    await expect(explicit(f, baseline)).rejects.toThrow('명시 활동 기준');
    expect(await snapshot(f.worldId)).toEqual(before);
  }
});

it('순서 상한에서도 일반 사람 호출은 선택 없이 PENDING이다', async () => {
  const f = await fixture();
  await marker(f.worldId);
  await db.world.update({ where: { id: f.worldId }, data: { actionSequence: 2_147_483_647 } });
  const before = await snapshot(f.worldId);
  await f.loop.poll();
  expect(await snapshot(f.worldId)).toEqual(before);
});

it.each(['zero', 'tick'] as const)(
  '앞 생성은 명시 인자를 읽지 않고 새 사람도 무선택 경로에서 기다린다(%s)',
  async (candidate) => {
    const f = await fixture(0, 600);
    await controlClock(db, f.worldId, 'resume');
    const part = Math.floor(f.initial.statRules.total / 3);
    await db.inputEvent.create({
      data: {
        worldId: f.worldId,
        userId: await user(),
        kind: 'general.create',
        idempotencyKey: randomUUID(),
        payload: {
          name: '명시전장수',
          leadership: part,
          strength: part,
          intel: f.initial.statRules.total - part * 2,
          portraitId: null,
        },
      },
    });
    const event = await marker(f.worldId);
    expect(await explicit(f, 1)).toBe(true);
    const before = await snapshot(f.worldId);
    expect(before.inputs[0]).toMatchObject({ status: 'APPLIED', sequence: 1 });
    expect(before.inputs[0]!.result).not.toHaveProperty('activeTick');
    await f.loop.advanceTo(600);
    expect(await snapshot(f.worldId)).toEqual(before);
    await explicit(f, candidate === 'zero' ? 0 : before.world.clockTick);
    const after = await snapshot(f.worldId);
    expect(after.inputs.find((input) => input.id === event.id)).toMatchObject({ status: 'APPLIED', sequence: 2 });
    const created = after.generals.find((general) => general.id === before.inputs[0]!.generalId);
    expect(created).toMatchObject({
      lastActiveTick: candidate === 'zero' ? 0 : before.world.clockTick,
      lastActiveAt: null,
    });
    const createdTurns = after.turns.filter((turn) => turn.generalId === created!.id);
    expect(createdTurns).toHaveLength(30);
    expect(createdTurns.every((turn) => turn.explicit)).toBe(true);
  },
);

it('오래된 리스는 명시 기준으로도 쓸 수 없다', async () => {
  const f = await fixture();
  await marker(f.worldId);
  await releaseLease(db, f.lease);
  const next = (await acquireLease(db, f.worldId))!;
  leases.push(next);
  const before = await snapshot(f.worldId);
  await expect(explicit(f, 0)).rejects.toBeInstanceOf(LeaseLostError);
  expect(await snapshot(f.worldId)).toEqual(before);
  await explicit({ ...f, lease: next }, 0);
});

it.each(['PREOPEN', 'ENDED'] as const)('%s는 명시 값으로도 상태 경계를 넘지 않는다', async (status) => {
  const f = await fixture();
  await marker(f.worldId);
  await db.world.update({ where: { id: f.worldId }, data: { status } });
  const before = await snapshot(f.worldId);
  if (status === 'PREOPEN') expect(await explicit(f, 0)).toBeNull();
  else await expect(explicit(f, 0)).rejects.toThrow('월드 상태');
  expect(await snapshot(f.worldId)).toEqual(before);
});

it.each(['partial', 'key', 'emptySlots', 'overflow'] as const)(
  '%s 손상은 명시 값으로도 우회하지 못한다',
  async (invalid) => {
    const f = await fixture();
    const event = await marker(f.worldId);
    if (invalid === 'partial')
      await db.generalTurn.delete({
        where: { worldId_generalId_slot: { worldId: f.worldId, generalId: 1, slot: 29 } },
      });
    if (invalid === 'key') await db.inputEvent.update({ where: { id: event.id }, data: { idempotencyKey: 'other' } });
    if (invalid === 'emptySlots')
      await db.inputEvent.update({ where: { id: event.id }, data: { payload: { version: 5, emptySlots: [] } } });
    if (invalid === 'overflow')
      await db.world.update({ where: { id: f.worldId }, data: { actionSequence: 2_147_483_647 } });
    const before = await snapshot(f.worldId);
    await expect(explicit(f, 0)).rejects.toThrow();
    expect(await snapshot(f.worldId)).toEqual(before);
  },
);

it('NPC 전용 월드에는 명시 값을 넣지 않고 기존 null 경로를 쓴다', async () => {
  const f = await fixture(0);
  await marker(f.worldId);
  const before = await snapshot(f.worldId);
  await expect(explicit(f, 0)).rejects.toThrow('사람 장수가 없는 전환');
  expect(await snapshot(f.worldId)).toEqual(before);
  await f.loop.poll();
  expect((await snapshot(f.worldId)).inputs[0]).toMatchObject({
    status: 'APPLIED',
    result: { baselineActiveTick: null },
  });
});
