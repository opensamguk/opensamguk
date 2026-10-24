import type { Prisma, PrismaClient } from '@opensamguk/db';
import * as rules from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { afterEach, expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { type Lease } from './lease';
import * as monthly from './monthly';
import { persistEffects, shiftTurns } from './persist';
import { TurnLoop } from './turnLoop';
import { loadWorld } from './worldLoader';

vi.mock('./worldLoader', () => ({ loadWorld: vi.fn() }));
vi.mock('./persist', () => ({ persistEffects: vi.fn(), shiftTurns: vi.fn() }));
vi.mock('./publicMap', () => ({ persistPublicMap: vi.fn().mockResolvedValue(false) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
type World = Prisma.WorldGetPayload<Record<string, never>>;
type Row = Record<string, unknown>;

// World 상태 저장과 예턴 이동은 stub이다. 실제 rule·gate·끝 해시 연결만 보는 단위 시험이다.
async function fixture(caps = true, modern = false) {
  const initial = await monthlyFixture();
  initial.generals = initial.generals
    .slice(0, 1)
    .map((general) => ({ ...general, userId: 'human', nextTurnTick: 100 }));
  initial.diplomacies = [];
  let state = rules.toWorldState(initial);
  const treaty: NonNullable<rules.WorldState['treaties']>[number] = {
    id: 1,
    fromNationId: 1,
    toNationId: 2,
    clauses: [{ kind: 'peace' }, { kind: 'note', text: '외교 회담을 이어 간다.' }],
    status: 'ACTIVE',
    proposedTick: 0,
    respondByTick: 60000,
    startTick: 0,
    endTick: null,
  };
  if (caps) state.treaties = [structuredClone(treaty)];
  const origin: rules.CapsOrigin = {
    version: 6,
    initial: structuredClone(initial),
    initialStateHash: hashState(initial),
    resourceHash: '',
    capabilities: { version: 1, treaty: { version: 1 } },
  };
  origin.resourceHash = hashState(rules.capsResourceHashInput(origin));
  const world = {
    id: '00000000-0000-4000-8000-000000000003',
    replayFormat: 1,
    ruleFeatures: [],
    status: 'RUNNING',
    startYear: initial.startYear,
    seed: initial.seed,
    unitSet: initial.unitSet,
    preset: null,
    commandMeta: null,
    treatyFormat: caps ? 1 : null,
    personnelFormat: null,
    replayOrigin: caps ? origin : null,
    policyFromSequence: modern ? 0 : null,
    actionSequence: 0,
    turnTermMinutes: 30,
    monthlyTick: 0,
    clockTick: 0,
    clockMode: 'REALTIME',
    clockAnchorAt: new Date(0),
    clockRevision: 0,
    endYear: null,
    outcomeFromSequence: 0,
  } as unknown as World;
  const rows: Row[] = caps ? [{ ...structuredClone(treaty), costFrom: 0, costTo: 0, closedSequence: null }] : [];
  let revision = 0;
  const ended: Row[] = [];
  const apply = (target: object, data: Row) => {
    const record = target as Row;
    for (const [key, value] of Object.entries(data)) {
      record[key] =
        value && typeof value === 'object' && 'increment' in value
          ? Number(record[key]) + Number(value.increment)
          : structuredClone(value);
    }
  };
  const rawGeneral = () => ({
    ...state.generals[1]!,
    worldId: world.id,
    turnRevision: revision,
    defaultPolicy: 'none',
    lastActiveTick: 0,
    lastActiveAt: null,
    battleWins: 0,
    captures: 0,
  });
  const slots = () =>
    Array.from({ length: 30 }, (_, slot) => ({
      worldId: world.id,
      generalId: 1,
      slot,
      commandKey: 'rest',
      args: {},
      explicit: true,
    }));
  const tx = {
    world: {
      findUniqueOrThrow: vi.fn(async () => ({ ...world })),
      update: vi.fn(async ({ data }: { data: Row }) => {
        apply(world, data);
        return { ...world };
      }),
      updateMany: vi.fn(async ({ data }: { data: Row }) => {
        apply(world, data);
        return { count: 1 };
      }),
    },
    treaty: { findMany: vi.fn(async () => structuredClone(rows)), updateMany: vi.fn() },
    inputEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    general: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        if ('userId' in where) return { id: 1 };
        const limit = (where.nextTurnTick as { lte: number }).lte;
        return state.generals[1]!.nextTurnTick <= limit ? rawGeneral() : null;
      }),
      findUniqueOrThrow: vi.fn(async () => rawGeneral()),
      findMany: vi.fn(async () => [rawGeneral()]),
      updateMany: vi.fn(async () => {
        revision++;
        return { count: 1 };
      }),
    },
    generalTurn: { findUnique: vi.fn(async () => slots()[0]), findMany: vi.fn(async () => slots()) },
    worldResult: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        ended.push(structuredClone(data));
      }),
    },
    generalLog: { create: vi.fn() },
    battleLog: { createMany: vi.fn() },
    nationHistory: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?').trim().replace(/\s+/g, ' ');
      if (sql.startsWith('SELECT 1 FROM "EngineLease"')) return [{}];
      if (sql.startsWith('SELECT clock_timestamp()')) return [{ now: new Date(0) }];
      if (sql.includes('FOR UPDATE') || sql.includes('FROM "WorldExtSlice"')) return [];
      throw new Error(`예상하지 않은 단위 조회: ${sql}`);
    }),
  };
  vi.mocked(loadWorld).mockImplementation(async () => structuredClone(state));
  vi.mocked(persistEffects).mockImplementation(async (_tx, _worldId, next) => {
    state = structuredClone(next);
  });
  vi.mocked(shiftTurns).mockResolvedValue(undefined);
  const transaction = vi.fn(async (run: (value: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient),
  );
  const db = { $transaction: transaction, $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;
  const lease: Lease = { worldId: world.id, ownerId: 'owner', fencingToken: 1, ttlMs: 15000 };
  return {
    world,
    rows,
    ended,
    tx,
    transaction,
    loop: new TurnLoop(db, lease, { elapsedNow: () => 0 }),
    client: tx as unknown as Prisma.TransactionClient,
    state: () => structuredClone(state),
    setState: (next: rules.WorldState) => {
      state = structuredClone(next);
    },
  };
}

it.each([false, true])(
  '실제 장수 턴은 조약 목록과 options·resolver 자리를 보존한다 (modern=%s, 단위)',
  async (modern) => {
    const f = await fixture(true, modern);
    const before = f.state().treaties;
    const run = vi.spyOn(rules, 'runGeneralTurn');
    expect(await f.loop.advanceTo(100)).toHaveLength(1);
    expect(f.state().treaties).toEqual(before);
    expect(f.loop.state?.treaties).toEqual(before);
    expect(run).toHaveBeenCalledOnce();
    const args = run.mock.calls[0]!;
    expect(args).toHaveLength(6);
    expect(args[4]).toEqual(modern ? { policy: 'none' } : {});
    expect([...args[5]!.list('general'), ...args[5]!.list('nation')]).toHaveLength(37);
    expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
  },
);

it.each(['remove', 'mutate'] as const)(
  '턴 결과의 조약 %s는 기본 상태 쓰기 전에 거부한다 (단위 stub)',
  async (change) => {
    const f = await fixture();
    vi.spyOn(rules, 'runGeneralTurn').mockImplementationOnce((state) => {
      const next = structuredClone(state);
      if (change === 'remove') delete next.treaties;
      else next.treaties![0]!.clauses = [{ kind: 'peace' }];
      return { state: next, result: { effects: [], logs: [] }, commandKey: 'rest', nation: undefined };
    });
    await expect(f.loop.advanceTo(100)).rejects.toThrow('조약 목록이 바뀌었습니다');
    expect(persistEffects).not.toHaveBeenCalled();
    expect(f.tx.generalLog.create).not.toHaveBeenCalled();
    expect(f.tx.world.updateMany).not.toHaveBeenCalled();
    expect(f.loop.state).toBeNull();
  },
);

it('빈 caps 상태에 생긴 빈 treaties 키도 키 생략 대조로 거부한다 (단위 stub)', async () => {
  const f = await fixture();
  const state = f.state();
  delete state.treaties;
  f.setState(state);
  f.rows.length = 0;
  vi.spyOn(rules, 'runGeneralTurn').mockImplementationOnce((before) => ({
    state: { ...before, treaties: [] },
    result: { effects: [], logs: [] },
    commandKey: 'rest',
    nation: undefined,
  }));
  await expect(f.loop.advanceTo(100)).rejects.toThrow('조약 목록이 바뀌었습니다');
  expect(persistEffects).not.toHaveBeenCalled();
});

it('off legacy 턴은 조약 키를 만들지 않는다 (실제 rule, 상태 저장 stub)', async () => {
  const f = await fixture(false);
  expect(await f.loop.advanceTo(100)).toHaveLength(1);
  expect(Object.hasOwn(f.state(), 'treaties')).toBe(false);
  expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
});

it('빈 caps 실제 턴은 키 생략 wrapper를 유지한다 (상태 저장 stub)', async () => {
  const f = await fixture();
  const state = f.state();
  delete state.treaties;
  f.setState(state);
  f.rows.length = 0;
  expect(await f.loop.advanceTo(100)).toHaveLength(1);
  expect(Object.hasOwn(f.state(), 'treaties')).toBe(false);
  expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
});

it('턴 종료는 조약을 일괄 닫지 않고 실제 loadReplayState 해시를 기록한다 (정복 결과 연결 stub)', async () => {
  const f = await fixture();
  const treaties = f.state().treaties;
  vi.spyOn(rules, 'runGeneralTurn').mockImplementationOnce((before) => {
    const next = structuredClone(before);
    delete next.nations[2];
    for (const city of Object.values(next.cities)) city.nationId = 1;
    return { state: next, result: { effects: [], logs: [] }, commandKey: 'rest', nation: undefined };
  });
  expect(await f.loop.advanceTo(100)).toHaveLength(1);
  expect(f.ended[0]).toMatchObject({ reason: 'UNIFIED', endedTick: 100, endedSequence: 1 });
  expect(f.state().treaties).toEqual(treaties);
  expect(f.rows[0]).toMatchObject({ status: 'ACTIVE', closedSequence: null });
  expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
  expect(f.ended[0]!.finalStateHash).toBe(hashState(await monthly.loadReplayState(f.client, f.world.id)));
});

it('월간 뒤 기수 종료는 정산된 상태의 실제 loadReplayState 해시를 기록한다 (정산 연결 stub)', async () => {
  const f = await fixture();
  f.world.monthlyTick = 110000;
  f.world.endYear = f.world.startYear;
  const state = f.state();
  state.generals[1]!.nextTurnTick = 130000;
  state.treaties![0]!.clauses = [{ kind: 'peace' }, { kind: 'nonAggression', months: 12 }];
  state.treaties![0]!.endTick = 120000;
  f.setState(state);
  Object.assign(f.rows[0]!, structuredClone(state.treaties![0]));
  vi.spyOn(monthly, 'persistMonthly').mockImplementationOnce(async (_tx, _id, _seed, tick) => {
    const settled = rules.settleTreaties(f.state(), tick);
    f.setState(settled);
    f.world.monthlyTick = tick;
    Object.assign(f.rows[0]!, { status: 'ENDED', closedSequence: 1 });
    return settled;
  });
  expect(await f.loop.advanceTo(120000)).toEqual([]);
  expect(f.ended[0]).toMatchObject({ reason: 'END_YEAR', endedTick: 120000, endedSequence: 1 });
  expect(Object.hasOwn(f.state(), 'treaties')).toBe(false);
  expect(f.ended[0]!.finalStateHash).toBe(hashState(await monthly.loadReplayState(f.client, f.world.id)));
  expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
});
