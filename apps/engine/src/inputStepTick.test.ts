import type { Prisma } from '@opensamguk/db';
import { creationFailure } from '@opensamguk/rules';
import { expect, it, vi } from 'vitest';
import legacy from '../test/fixtures/replay-v1-b8f5074.json';
import { processPendingInput } from './inputs';

type World = Prisma.WorldGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;

// 실제 처리 함수의 쓰기 인자를 보는 단위 입력이다. public 인사 선택을 열거나 PG 원자성을 검증하지 않는다.
function fixture(personnelFormat: 1 | null, policyFromSequence: number | null = null) {
  const world: World = {
    id: 'world',
    name: '입력 시험',
    operationalMap: null,
    campaignState: null,
    cityResourcesState: null,
    presetKey: null,
    scenarioKey: legacy.origin.initial.scenarioKey,
    mapKey: legacy.origin.initial.mapKey,
    unitSetKey: legacy.origin.initial.unitSetKey,
    status: 'RUNNING',
    replayFormat: 1,
    ruleFeatures: [],
    treatyFormat: null,
    personnelFormat,
    policyFromSequence,
    replayOrigin: null,
    actionSequence: 7,
    endYear: null,
    outcomeFromSequence: 0,
    clockMode: 'REALTIME',
    clockTick: 0,
    clockAnchorAt: new Date(0),
    clockRevision: 0,
    startedAt: new Date(0),
    endedAt: null,
    turnTermMinutes: 30,
    monthlyTick: 0,
    initialStateHash: legacy.origin.initialStateHash,
    startYear: legacy.origin.initial.startYear,
    statRules: legacy.origin.initial.statRules,
    unitSet: legacy.origin.initial.unitSet,
    seed: legacy.origin.initial.seed,
    preset: null,
    commandMeta: null,
    createdAt: new Date(0),
  };
  const event: Event = {
    id: 1n,
    worldId: world.id,
    userId: 'actor',
    generalId: null,
    idempotencyKey: 'general.create:request',
    kind: 'general.create',
    payload: { name: '장수', leadership: 55, strength: 55, intel: 55, portraitId: null },
    status: 'PENDING',
    sequence: null,
    tick: null,
    stepTick: null,
    result: null,
    createdAt: new Date(1234),
  };
  const existing: { id: number; userId: string | null; name: string }[] = [];
  const actor = { status: 'ACTIVE' };
  const save = vi.fn(async ({ data }: Prisma.InputEventUpdateArgs) => {
    Object.assign(event, data);
    return event;
  });
  const tx = {
    inputEvent: { findFirst: vi.fn().mockResolvedValue(event), update: save },
    user: { findUnique: vi.fn().mockResolvedValue(actor) },
    general: {
      findMany: vi.fn().mockResolvedValue(existing),
      create: vi.fn<(args: Prisma.GeneralCreateArgs) => Promise<null>>().mockResolvedValue(null),
    },
    generalTurn: {
      createMany: vi
        .fn<(args: Prisma.GeneralTurnCreateManyArgs) => Promise<{ count: number }>>()
        .mockResolvedValue({ count: 30 }),
    },
    city: { findMany: vi.fn().mockResolvedValue([{ cityKey: 1 }]) },
    world: { update: vi.fn().mockResolvedValue({ actionSequence: 8 }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return {
    world,
    event,
    actor,
    existing,
    tx,
    run: (tick: number) => processPendingInput(tx as unknown as Prisma.TransactionClient, world, tick),
  };
}

it.each([null, 0, 5].flatMap((fromSequence) => [0, 999].map((tick) => ({ fromSequence, tick }))))(
  '정책 시작 순서 $fromSequence 값에서 생성 tick $tick 값을 같은 APPLIED update에 쓴다',
  async ({ fromSequence, tick }) => {
    const off = fixture(null, fromSequence);
    const personnel = fixture(1, fromSequence);
    for (const f of [off, personnel]) {
      f.world.clockTick = tick === 0 ? 0 : 600;
      const payload = structuredClone(f.event.payload);
      expect(f.event.stepTick).toBeNull();
      expect(await f.run(tick)).toBe(true);
      expect(f.tx.world.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: 'world' },
        data: { actionSequence: { increment: 1 } },
        select: { actionSequence: true },
      });
      expect(f.tx.inputEvent.update).toHaveBeenCalledOnce();
      expect(f.tx.inputEvent.update).toHaveBeenCalledWith({
        where: { id: 1n },
        data: {
          status: 'APPLIED',
          generalId: 1,
          sequence: 8,
          ...(f === personnel ? { stepTick: tick } : {}),
          result: expect.any(Object),
        },
      });
      expect(f.event.payload).toEqual(payload);
      expect(f.tx.general.create).toHaveBeenCalledOnce();
      expect(f.tx.generalTurn.createMany).toHaveBeenCalledOnce();
    }
    expect(personnel.event.stepTick).toBe(tick);
    expect(off.event.stepTick).toBeNull();
    expect(Object.hasOwn(off.tx.inputEvent.update.mock.calls[0]![0].data, 'stepTick')).toBe(false);
    expect(JSON.stringify(personnel.event.result)).toBe(JSON.stringify(off.event.result));
    expect(personnel.tx.general.create.mock.calls).toEqual(off.tx.general.create.mock.calls);
    expect(personnel.tx.generalTurn.createMany.mock.calls).toEqual(off.tx.generalTurn.createMany.mock.calls);
    expect(Object.keys(personnel.event.result!)).toEqual(
      fromSequence === null ? ['general'] : ['general', 'activeTick'],
    );
    if (fromSequence !== null) expect(personnel.event.result).toHaveProperty('activeTick', tick);
    const created = personnel.tx.general.create.mock.calls[0]![0].data;
    expect(created.nextTurnTick).toBeGreaterThan(tick);
    expect(created).toMatchObject({ userId: 'actor', worldId: 'world', name: '장수' });
    if (fromSequence !== null)
      expect(created).toMatchObject({ defaultPolicy: 'none', lastActiveTick: tick, lastActiveAt: new Date(1234) });
    else expect(Object.hasOwn(created, 'lastActiveTick')).toBe(false);
  },
);

const rejectionCases = [
  'PREOPEN',
  'PAUSED',
  'ENDED',
  'ALREADY_EXISTS',
  'ACTOR_INACTIVE',
  'BAD_STATS',
  'NAME_TAKEN',
] as const;
it.each(
  ([null, 1] as const).flatMap((personnelFormat) => rejectionCases.map((reason) => ({ personnelFormat, reason }))),
)(
  '인사 형식 $personnelFormat 값의 $reason 거절은 기존 검사 순서와 null을 보존한다',
  async ({ personnelFormat, reason }) => {
    const f = fixture(personnelFormat);
    if (reason === 'PREOPEN' || reason === 'PAUSED' || reason === 'ENDED') {
      f.world.status = reason;
      f.actor.status = 'SUSPENDED';
      f.event.payload = {};
    } else if (reason === 'ALREADY_EXISTS') {
      f.existing.push({ id: 2, userId: 'actor', name: '기존' });
      f.actor.status = 'SUSPENDED';
    } else if (reason === 'ACTOR_INACTIVE') {
      f.actor.status = 'SUSPENDED';
      f.event.payload = {};
    } else if (reason === 'BAD_STATS') {
      f.event.payload = { name: '장수', leadership: 0, strength: 0, intel: 0, portraitId: null };
      f.existing.push({ id: 2, userId: 'other', name: '장수' });
    } else f.existing.push({ id: 2, userId: 'other', name: '장수' });
    const code = reason === 'PREOPEN' || reason === 'PAUSED' || reason === 'ENDED' ? 'WORLD_CLOSED' : reason;
    expect(await f.run(999)).toBe(true);
    expect(f.tx.inputEvent.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 1n },
      data: { status: 'REJECTED', sequence: 8, result: creationFailure(code) },
    });
    expect(f.event).toMatchObject({ status: 'REJECTED', sequence: 8, generalId: null, stepTick: null });
    expect(f.tx.world.update).toHaveBeenCalledOnce();
    expect(f.tx.general.create).not.toHaveBeenCalled();
    expect(f.tx.generalTurn.createMany).not.toHaveBeenCalled();
    if (code === 'WORLD_CLOSED' || code === 'ALREADY_EXISTS') expect(f.tx.user.findUnique).not.toHaveBeenCalled();
  },
);

it('PENDING이 없거나 처리 전 오류가 나면 null과 sequence를 그대로 둔다', async () => {
  const absent = fixture(1);
  absent.tx.inputEvent.findFirst.mockResolvedValue(null);
  expect(await absent.run(999)).toBe(false);
  const unsupported = fixture(1);
  unsupported.event.kind = 'unknown';
  await expect(unsupported.run(999)).rejects.toThrow('처리할 수 없는 대기 입력');
  for (const f of [absent, unsupported]) {
    expect(f.event).toMatchObject({ status: 'PENDING', sequence: null, stepTick: null, result: null });
    expect(f.tx.world.update).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.update).not.toHaveBeenCalled();
    expect(f.tx.general.create).not.toHaveBeenCalled();
  }
});

it('APPLIED 저장 실패는 추가 tick 쓰기나 재시도 없이 호출자에게 전한다', async () => {
  const f = fixture(1);
  f.tx.inputEvent.update.mockRejectedValueOnce(new Error('저장 실패'));
  await expect(f.run(999)).rejects.toThrow('저장 실패');
  expect(f.tx.inputEvent.update).toHaveBeenCalledOnce();
  expect(f.tx.inputEvent.update).toHaveBeenCalledWith({
    where: { id: 1n },
    data: { status: 'APPLIED', generalId: 1, sequence: 8, stepTick: 999, result: expect.any(Object) },
  });
  expect(f.event).toMatchObject({ status: 'PENDING', sequence: null, stepTick: null, result: null });
});
