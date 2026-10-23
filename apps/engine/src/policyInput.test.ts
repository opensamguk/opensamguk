import { expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import { emptyQueue } from '@opensamguk/rules';
import { processPendingInput } from './inputs';

// 입력 갈래의 검사·쓰기 인자만 보는 단위 시험이다. 펜싱·원자 저장 증거는 실제 PG 시험으로 확인한다.
function fixture() {
  const world = {
    id: 'world',
    status: 'PAUSED',
    policyFromSequence: null,
    actionSequence: 7,
    clockTick: 600,
    turnTermMinutes: 30,
  } as Prisma.WorldGetPayload<Record<string, never>>;
  const marker = {
    id: 1n,
    userId: 'system:policy',
    generalId: null as number | null,
    idempotencyKey: 'system.policy.enable:5',
    kind: 'system.policy.enable',
    status: 'PENDING',
    sequence: null,
    result: null,
    payload: { version: 5, emptySlots: [1] },
  };
  const generals = [{ id: 1, userId: null as string | null }];
  const tx = {
    inputEvent: { findFirst: vi.fn().mockResolvedValue(marker), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    general: { findMany: vi.fn().mockResolvedValue(generals), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    generalTurn: {
      findMany: vi.fn().mockResolvedValue(emptyQueue().map((slot, index) => ({ ...slot, generalId: 1, slot: index }))),
    },
    world: {
      update: vi.fn().mockResolvedValue({ actionSequence: 8 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return {
    world,
    marker,
    generals,
    tx,
    run: (baselineActiveTick?: number) =>
      processPendingInput(tx as unknown as Prisma.TransactionClient, world, 999, baselineActiveTick),
  };
}

it('NPC 전환은 잠근 월드 tick과 null 기준으로 F·표지·장수 열만 쓴다', async () => {
  const f = fixture();
  expect(await f.run()).toBe(true);
  expect(f.tx.world.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { id: 'world', policyFromSequence: null },
    data: { policyFromSequence: 8 },
  });
  expect(f.tx.general.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { worldId: 'world' },
    data: { defaultPolicy: 'none', lastActiveTick: null, lastActiveAt: null },
  });
  expect(f.tx.inputEvent.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { id: 1n, status: 'PENDING' },
    data: {
      status: 'APPLIED',
      sequence: 8,
      result: { fromSequence: 8, emptySlots: [1], clockTick: 600, turnTermMinutes: 30, baselineActiveTick: null },
    },
  });
});

it.each(['PREOPEN', 'human'] as const)('%s는 값이나 sequence를 쓰지 않고 기다린다', async (state) => {
  const f = fixture();
  if (state === 'PREOPEN') f.world.status = 'PREOPEN';
  else f.generals[0]!.userId = 'human';
  expect(await f.run()).toBeNull();
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.tx.world.updateMany).not.toHaveBeenCalled();
  expect(f.tx.general.updateMany).not.toHaveBeenCalled();
  expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
});

it.each(['ENDED', 'futureF', 'userId', 'generalId', 'key', 'overflow'] as const)(
  '%s 손상은 전환 쓰기 전에 거부한다',
  async (invalid) => {
    const f = fixture();
    if (invalid === 'ENDED') f.world.status = 'ENDED';
    if (invalid === 'futureF') f.world.policyFromSequence = 100;
    if (invalid === 'userId') f.marker.userId = 'other';
    if (invalid === 'generalId') f.marker.generalId = 1;
    if (invalid === 'key') f.marker.idempotencyKey = 'other';
    if (invalid === 'overflow') f.world.actionSequence = 2_147_483_647;
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.world.update).not.toHaveBeenCalled();
    expect(f.tx.world.updateMany).not.toHaveBeenCalled();
    expect(f.tx.general.updateMany).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
  },
);

function humanFixture() {
  const f = fixture();
  f.generals.push({ id: 2, userId: 'human' });
  f.tx.generalTurn.findMany.mockResolvedValue(
    [1, 2].flatMap((generalId) =>
      emptyQueue().map((slot, index) => ({ ...slot, explicit: generalId === 2, generalId, slot: index })),
    ),
  );
  return f;
}

it.each([0, 600])(
  '사람 전환의 명시 기준 %s는 기록과 사람 열에만 쓰고 활동 시각은 지어내지 않는다',
  async (baseline) => {
    const f = humanFixture();
    expect(await f.run(baseline)).toBe(true);
    expect(f.tx.inputEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'APPLIED',
          sequence: 8,
          result: expect.objectContaining({ baselineActiveTick: baseline, clockTick: 600 }),
        }),
      }),
    );
    expect(f.tx.general.updateMany).toHaveBeenNthCalledWith(1, {
      where: { worldId: 'world' },
      data: { defaultPolicy: 'none', lastActiveTick: null, lastActiveAt: null },
    });
    expect(f.tx.general.updateMany).toHaveBeenNthCalledWith(2, {
      where: { worldId: 'world', userId: { not: null } },
      data: { lastActiveTick: baseline },
    });
  },
);

it.each([1, 599, 601, 999, 0.5, -1, NaN, Infinity])(
  '사람 전환의 잘못된 명시 기준 %s는 쓰기 전에 거부한다',
  async (baseline) => {
    const f = humanFixture();
    await expect(f.run(baseline)).rejects.toThrow('명시 활동 기준');
    expect(f.tx.world.update).not.toHaveBeenCalled();
    expect(f.tx.general.updateMany).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
  },
);

it('인자 없는 사람 전환은 순서 상한에서도 계속 기다리고 NPC에 명시 값을 넣으면 거부한다', async () => {
  const f = humanFixture();
  f.world.actionSequence = 2_147_483_647;
  expect(await f.run()).toBeNull();
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.tx.general.updateMany).not.toHaveBeenCalled();
  await expect(fixture().run(0)).rejects.toThrow('사람 장수가 없는 전환');
});

it('PENDING이 없으면 명시 인자는 쓰이지 않는다', async () => {
  const f = fixture();
  f.tx.inputEvent.findFirst.mockResolvedValue(null);
  expect(await f.run(600)).toBe(false);
  expect(f.tx.world.update).not.toHaveBeenCalled();
});
