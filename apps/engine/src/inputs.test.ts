import type { Prisma } from '@opensamguk/db';
import { capsResourceHashInput, emptyQueue, parsePreset, presetRules, type CapsOrigin } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { expect, it, vi } from 'vitest';
import legacy from '../test/fixtures/replay-v1-b8f5074.json';
import { processPendingInput } from './inputs';

const regular = {
  name: '정규',
  turnTermMinutes: 60,
  scenario: '1030',
  map: 'che',
  unitSet: 'basic',
  commands: null,
  npc: {
    fillRatio: 1,
    aggression: 1,
  },
  protection: {
    foundUntilMonths: 0,
    peaceMonths: 0,
    maxGeneralsPerNation: null,
  },
  boost: {
    smallWorld: null,
    lateJoin: null,
  },
  features: {
    advisor: false,
  },
};

type World = Prisma.WorldGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;

// 정적 선택과 실제 처리기 호출을 보는 단위 fixture다. DB 월드 생성이나 PG 증거가 아니다.
function world(changes: Partial<World> = {}): World {
  const origin: CapsOrigin = {
    ...legacy.origin,
    version: 6,
    capabilities: { version: 1, treaty: { version: 1 } },
  } as CapsOrigin;
  origin.resourceHash = hashState(capsResourceHashInput(origin));
  return {
    id: 'world',
    status: 'ENDED',
    treatyFormat: 1,
    personnelFormat: null,
    replayOrigin: origin,
    policyFromSequence: null,
    actionSequence: 0,
    clockTick: 600,
    monthlyTick: 0,
    turnTermMinutes: 30,
    startYear: legacy.origin.initial.startYear,
    endYear: null,
    outcomeFromSequence: 0,
    ...changes,
  } as unknown as World;
}
function event(kind: string, id = 1n): Event {
  return {
    id,
    worldId: 'world',
    kind,
    userId: 'actor',
    generalId: 1,
    idempotencyKey: `${kind}:request`,
    status: 'PENDING',
    sequence: null,
    tick: null,
    stepTick: null,
    result: null,
    createdAt: new Date(0),
    payload:
      kind === 'treaty.respond' ? { treatyId: '1', accept: false } : { toNationId: 2, clauses: [{ kind: 'peace' }] },
  } as Event;
}
function fixture(events: Event[], stored = world()) {
  const sequence = vi.fn(async (args: Prisma.WorldUpdateArgs) => {
    expect(args).toEqual({
      where: { id: stored.id },
      data: { actionSequence: { increment: 1 } },
      select: { actionSequence: true },
    });
    return { actionSequence: ++stored.actionSequence };
  });
  const save = vi.fn(async ({ where, data }: Prisma.InputEventUpdateArgs) => {
    Object.assign(
      events.find((row) => row.id === where.id)!,
      data,
    );
    return events.find((row) => row.id === where.id)!;
  });
  const findFirst = vi.fn(async ({ where, orderBy }: Prisma.InputEventFindFirstArgs) => {
    expect(where).toEqual({ worldId: stored.id, status: 'PENDING' });
    expect(orderBy).toEqual({ id: 'asc' });
    return events.filter((row) => row.status === 'PENDING').sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
  });
  const tx = {
    inputEvent: {
      findFirst,
      update: save,
      updateMany: vi.fn(async ({ where, data }: Prisma.InputEventUpdateManyArgs) => {
        Object.assign(
          events.find((row) => row.id === where?.id)!,
          data,
        );
        return { count: 1 };
      }),
    },
    world: {
      update: sequence,
      updateMany: vi.fn(async ({ data }: Prisma.WorldUpdateManyArgs) => {
        Object.assign(stored, data);
        return { count: 1 };
      }),
    },
    worldResult: { findUnique: vi.fn().mockResolvedValue({ endedTick: 500 }) },
    general: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    generalTurn: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return {
    stored,
    events,
    tx,
    sequence,
    findFirst,
    run: (baseline?: number) =>
      processPendingInput(tx as unknown as Prisma.TransactionClient, stored, stored.clockTick, baseline),
  };
}

it.each(['unknown', 'turns.set', 'personnel.appoint', 'treaty.break', '__proto__'])(
  '가장 작은 %s PENDING은 뒤 입력을 건너뛰지 않고 sequence 전에 실패한다 (단위)',
  async (kind) => {
    const f = fixture([event('general.create', 2n), event(kind)]);
    await expect(f.run()).rejects.toThrow('처리할 수 없는 대기 입력');
    expect(f.findFirst).toHaveBeenCalledOnce();
    expect(f.sequence).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.update).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
    expect(f.events.every((row) => row.status === 'PENDING' && row.sequence === null)).toBe(true);
  },
);

it.each(['treaty.propose', 'treaty.respond'])('off 월드의 %s는 sequence 전에 실패한다 (단위)', async (kind) => {
  for (const replayOrigin of [null, { version: 1 }]) {
    const f = fixture([event(kind)], world({ treatyFormat: null, replayOrigin }));
    await expect(f.run()).rejects.toThrow('조약을 끈 월드');
    expect(f.sequence).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
  }
});

it.each(['treaty.propose', 'treaty.respond'])(
  'T4-17 B ext 단독의 %s도 sequence·쓰기 전에 거부한다 (단위)',
  async (kind) => {
    const commands = { general: ['fire_attack'], nation: [] };
    const preset = parsePreset({ ...regular, commands });
    const f = fixture(
      [event(kind)],
      world({
        treatyFormat: null,
        policyFromSequence: 0,
        replayOrigin: {
          ...legacy.origin,
          version: 6,
          initial: { ...legacy.origin.initial, presetRules: presetRules(preset) },
          capabilities: { version: 1, ext: { version: 1, commands, preset, resources: {}, sliceKeys: [] } },
        } as unknown as Prisma.JsonObject,
      }),
    );
    await expect(f.run()).rejects.toThrow('조약을 끈 월드');
    expect(f.sequence).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.update).not.toHaveBeenCalled();
  },
);

it.each(['treaty.propose', 'treaty.respond'])('PAUSED %s는 실제 Ops 처리기에서 한 번 배정한다 (단위)', async (kind) => {
  const f = fixture([event(kind), event('general.create', 2n)], world({ status: 'PAUSED' }));
  expect(await f.run()).toBe(true);
  expect(f.sequence).toHaveBeenCalledOnce();
  expect(f.tx.inputEvent.updateMany).toHaveBeenCalledOnce();
  expect(f.events[0]).toMatchObject({ status: 'REJECTED', sequence: 1, result: { code: 'WORLD_CLOSED', tick: 600 } });
  expect(f.events[1]).toMatchObject({ status: 'PENDING', sequence: null });
  expect(f.tx.worldResult.findUnique).not.toHaveBeenCalled();
});

it.each(['treaty.propose', 'treaty.respond'])(
  'ENDED %s도 실제 종료 tick 이후 WORLD_CLOSED로 닫는다 (단위)',
  async (kind) => {
    const f = fixture([event(kind)]);
    expect(await f.run()).toBe(true);
    expect(f.sequence).toHaveBeenCalledOnce();
    expect(f.events[0]).toMatchObject({ status: 'REJECTED', sequence: 1, result: { tick: 600, code: 'WORLD_CLOSED' } });
    expect(f.tx.worldResult.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world' },
      select: { endedTick: true },
    });
  },
);

it.each(['treaty.propose', 'treaty.respond'])(
  'ENDED의 파손된 %s는 배정 없이 PENDING으로 남는다 (단위)',
  async (kind) => {
    const pending = event(kind);
    pending.payload = {};
    const f = fixture([pending]);
    await expect(f.run()).rejects.toThrow();
    expect(f.sequence).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
    expect(pending).toMatchObject({ status: 'PENDING', sequence: null });
  },
);

it('생성·정책·조약 계열은 같은 최소 id 큐에서 각자 한 번씩 배정한다 (단위)', async () => {
  const f = fixture([
    event('treaty.respond', 4n),
    event('general.active', 3n),
    event('general.setPolicy', 2n),
    event('general.create', 1n),
  ]);
  for (let i = 0; i < 4; i++) expect(await f.run()).toBe(true);
  expect(await f.run()).toBe(false);
  expect(f.sequence).toHaveBeenCalledTimes(4);
  expect([...f.events].sort((a, b) => (a.id < b.id ? -1 : 1)).map((row) => [row.id, row.sequence, row.status])).toEqual(
    [
      [1n, 1, 'REJECTED'],
      [2n, 2, 'REJECTED'],
      [3n, 3, 'REJECTED'],
      [4n, 4, 'REJECTED'],
    ],
  );
  expect(f.tx.inputEvent.update).toHaveBeenCalledTimes(3);
  expect(f.tx.inputEvent.updateMany).toHaveBeenCalledOnce();
});

it.each(['PREOPEN', 'PAUSED'] as const)(
  '%s 표지 null은 뒤 조약을 가린 채 sequence를 쓰지 않는다 (단위)',
  async (status) => {
    const marker = event('system.policy.enable');
    Object.assign(marker, {
      userId: 'system:policy',
      generalId: null,
      idempotencyKey: 'system.policy.enable:5',
      payload: { version: 5, emptySlots: [1] },
    });
    const f = fixture([event('treaty.propose', 2n), marker], world({ status }));
    f.tx.general.findMany.mockResolvedValue([{ id: 1, userId: 'human' }] as never);
    f.tx.generalTurn.findMany.mockResolvedValue(
      emptyQueue().map((slot, index) => ({ ...slot, generalId: 1, slot: index })) as never,
    );
    expect(await f.run()).toBeNull();
    expect(await f.run()).toBeNull();
    expect(f.sequence).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
    expect(f.events.every((row) => row.status === 'PENDING')).toBe(true);
  },
);

it('NPC 표지를 처리한 뒤 조약 처리기의 sequence를 다시 중앙에서 올리지 않는다 (단위)', async () => {
  const marker = event('system.policy.enable');
  Object.assign(marker, {
    userId: 'system:policy',
    generalId: null,
    idempotencyKey: 'system.policy.enable:5',
    payload: { version: 5, emptySlots: [] },
  });
  const f = fixture([event('treaty.propose', 2n), marker], world({ status: 'PAUSED' }));
  expect(await f.run()).toBe(true);
  expect(f.stored.policyFromSequence).toBe(1);
  expect(await f.run()).toBe(true);
  expect(f.sequence).toHaveBeenCalledTimes(2);
  expect(f.events.map((row) => row.sequence)).toEqual([2, 1]);
});

it('실제 조약 처리기의 저장 오류는 중앙에서 삼키지 않는다 (단위, 롤백 증거 아님)', async () => {
  const f = fixture([event('treaty.propose')]);
  f.tx.inputEvent.updateMany.mockRejectedValueOnce(new Error('저장 실패'));
  await expect(f.run()).rejects.toThrow('저장 실패');
  expect(f.sequence).toHaveBeenCalledOnce();
});
