import type { Prisma } from '@opensamguk/db';
import { assertSlotSet, emptyTurns, isPolicyMode, toWorldState, type ReplayState } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { loadReplayState } from './monthly';
import { loadWorld } from './worldLoader';

// Only the slot projection is under test. This memory TX is not engine/PG acceptance.
vi.mock('./worldLoader', () => ({ loadWorld: vi.fn() }));
vi.mock('./features', () => ({ engineFeatures: [] }));
type General = {
  id: number;
  turnRevision: number;
  defaultPolicy: 'none';
  userId: string | null;
  lastActiveTick: number | null;
};
type Slot = { generalId: number; slot: number; commandKey: string; args: unknown; explicit: boolean };
type World = {
  replayFormat: number;
  ruleFeatures: string[];
  policyFromSequence: number | null;
  actionSequence: number;
  turnTermMinutes: number;
  monthlyTick: number;
};

async function fixture(count?: number) {
  const initial = await monthlyFixture(),
    state = toWorldState(initial);
  const ids =
    count === undefined
      ? initial.generals.map((row) => row.id)
      : Array.from({ length: count }, (_, index) => index + 1);
  const generals: General[] = ids.map((id, index) => ({
    id,
    turnRevision: index + 1,
    defaultPolicy: 'none',
    userId: index === 0 ? 'fixture-user' : null,
    lastActiveTick: index === 0 ? 7 : null,
  }));
  const slots: Slot[] = Array.from({ length: 30 }, (_, slot) =>
    generals.map(({ id }) => ({
      generalId: id,
      slot,
      commandKey: slot % 2 ? 'rest' : 'farm',
      args: { unitId: id, nested: [slot, null, { text: '원래 인자' }] },
      explicit: slot % 3 === 0,
    })),
  ).flat();
  const world: World = {
    replayFormat: 3,
    ruleFeatures: ['policy'],
    policyFromSequence: null,
    actionSequence: 10,
    turnTermMinutes: 60,
    monthlyTick: 10000,
  };
  const tx = {
    world: { findUniqueOrThrow: vi.fn(async () => world) },
    general: { findMany: vi.fn(async () => generals) },
    generalTurn: { findMany: vi.fn(async () => slots) },
  };
  vi.mocked(loadWorld).mockImplementation(async () => state);
  return {
    initial,
    state,
    generals,
    slots,
    world,
    tx,
    read: () => loadReplayState(tx as unknown as Prisma.TransactionClient, 'fixture-world'),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Frozen pre-change filter algorithm is the behavioral oracle, not the new grouping algorithm.
function previousProjection(f: Fixture): ReplayState {
  const { state, world, generals, slots } = f,
    modern =
      world.replayFormat === 3
        ? world.ruleFeatures.includes('policy')
        : isPolicyMode({ fromSequence: world.policyFromSequence, actionSequence: world.actionSequence });
  const turns = Object.fromEntries(generals.map(({ id }) => [id, emptyTurns()]));
  for (const general of generals) if (modern) assertSlotSet(slots.filter((slot) => slot.generalId === general.id));
  for (const slot of slots)
    turns[slot.generalId]![slot.slot] = {
      commandKey: slot.commandKey,
      args: slot.args,
      ...(modern ? { explicit: slot.explicit } : {}),
    };
  return {
    state,
    turns,
    revisions: Object.fromEntries(generals.map(({ id, turnRevision }) => [id, turnRevision])),
    monthlyTick: world.monthlyTick,
    ...(modern
      ? {
          policy: {
            turnTermMinutes: world.turnTermMinutes,
            policies: Object.fromEntries(generals.map((row) => [row.id, row.defaultPolicy])),
            lastActiveTicks: Object.fromEntries(
              generals.filter((row) => row.userId !== null).map((row) => [row.id, row.lastActiveTick!]),
            ),
          },
        }
      : {}),
  };
}
function failure(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected original projection rejection');
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
beforeEach(() => vi.clearAllMocks());

describe('replay slot indexing preserves the complete original projection', () => {
  it.each([
    [3, ['policy'], null, 10],
    [3, [], 0, 10],
    [1, [], null, 10],
    [1, [], 5, 4],
    [1, [], 5, 5],
    [1, [], 0, 0],
  ] as const)(
    'keeps format%s features%j F=%s sequence%s and exact hashes',
    async (format, features, fromSequence, sequence) => {
      const f = await fixture();
      Object.assign(f.world, {
        replayFormat: format,
        ruleFeatures: [...features],
        policyFromSequence: fromSequence,
        actionSequence: sequence,
      });
      const before = structuredClone({ state: f.state, world: f.world, generals: f.generals, slots: f.slots });
      const expected = previousProjection(f);
      freeze(f.state);
      freeze(f.world);
      freeze(f.generals);
      freeze(f.slots);
      const actual = await f.read();
      expect(actual).toEqual(expected);
      expect(hashState(actual)).toBe(hashState(expected));
      expect({ state: f.state, world: f.world, generals: f.generals, slots: f.slots }).toEqual(before);
      expect(loadWorld).toHaveBeenCalledExactlyOnceWith(f.tx, 'fixture-world');
      expect(f.tx.generalTurn.findMany).toHaveBeenCalledExactlyOnceWith({
        where: { worldId: 'fixture-world' },
        orderBy: { slot: 'asc' },
      });
      expect(f.tx.general.findMany).toHaveBeenCalledTimes(1);
      expect(f.tx.world.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    },
  );
  it('interleaved and reversed row order preserves each original slot, nested args and revisions', async () => {
    const f = await fixture(),
      before = previousProjection(f);
    f.slots.reverse();
    const rowOrder = [...f.slots],
      actual = await f.read();
    expect(actual).toEqual(before);
    expect(hashState(actual)).toBe(hashState(before));
    expect(f.slots).toEqual(rowOrder);
    for (const row of f.slots) expect(actual.turns[row.generalId]![row.slot]!.args).toBe(row.args);
  });
  it.each([
    'whole-group-missing',
    '29-slots',
    '31-slots',
    'duplicate-slot',
    'negative-slot',
    'slot30',
    'fractional-slot',
  ])('rejects the same incomplete/corrupt modern queue: %s', async (kind) => {
    const f = await fixture(),
      id = f.generals[0]!.id;
    if (kind === 'whole-group-missing')
      f.slots.splice(0, f.slots.length, ...f.slots.filter((row) => row.generalId !== id));
    else if (kind === '29-slots')
      f.slots.splice(
        f.slots.findIndex((row) => row.generalId === id),
        1,
      );
    else if (kind === '31-slots') f.slots.push({ ...f.slots[0]! });
    else
      f.slots[0]!.slot = kind === 'duplicate-slot' ? 1 : kind === 'negative-slot' ? -1 : kind === 'slot30' ? 30 : 0.5;
    const previous = failure(() => previousProjection(f));
    expect(previous).toBeInstanceOf(Error);
    await expect(f.read()).rejects.toThrow((previous as Error).message);
    expect((previous as Error).message).toBe('예턴 칸은 0부터 29까지 한 칸씩 있어야 합니다.');
  });
  it('an orphan general is still rejected by the original output loop, never silently discarded', async () => {
    const f = await fixture();
    f.slots.push({ ...f.slots[0]!, generalId: 2147483647 });
    const previous = failure(() => previousProjection(f));
    expect(previous).toBeInstanceOf(TypeError);
    await expect(f.read()).rejects.toThrow((previous as Error).message);
  });
  it('legacy sparse and duplicate queues retain empty defaults and the original last-row result', async () => {
    const f = await fixture();
    Object.assign(f.world, { replayFormat: 1, ruleFeatures: [], policyFromSequence: null });
    f.slots.splice(
      0,
      f.slots.length,
      { ...f.slots[0]! },
      { ...f.slots[0]!, commandKey: 'rest', args: { final: true } },
    );
    const expected = previousProjection(f),
      actual = await f.read();
    expect(actual).toEqual(expected);
    expect(hashState(actual)).toBe(hashState(expected));
    expect(actual.turns[f.generals[0]!.id]![0]).toEqual({ commandKey: 'rest', args: { final: true } });
    expect(actual.turns[f.generals[0]!.id]).toHaveLength(30);
  });
  it('zero generals and zero slots preserve the empty replay shape', async () => {
    const f = await fixture(0);
    expect(await f.read()).toEqual(previousProjection(f));
  });
  it('all493 queues are validated with linear slot-owner reads rather than493 full scans', async () => {
    const f = await fixture(493);
    let ownerReads = 0;
    for (const row of f.slots) {
      const owner = row.generalId;
      Object.defineProperty(row, 'generalId', {
        enumerable: true,
        get: () => {
          ownerReads++;
          return owner;
        },
      });
    }
    const actual = await f.read();
    expect(Object.keys(actual.turns)).toHaveLength(493);
    expect(Object.values(actual.turns).every((queue) => queue.length === 30)).toBe(true);
    expect(ownerReads).toBeLessThan(f.slots.length * 4);
    expect(f.tx.generalTurn.findMany).toHaveBeenCalledTimes(1);
  });
});
