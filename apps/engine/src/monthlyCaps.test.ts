import type { Prisma } from '@opensamguk/db';
import {
  capsResourceHashInput,
  monthlyDate,
  runMonthly,
  settleTreaties,
  toWorldState,
  type CapsOrigin,
} from '@opensamguk/rules';
import { rngFor } from '@opensamguk/shared';
import { hashState } from '@opensamguk/shared/node';
import { expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { loadReplayState, persistMonthly } from './monthly';
import { resourceHash } from './replay';
import { loadWorld } from './worldLoader';

type Row = Record<string, unknown>;
type Read = { select?: Record<string, boolean>; omit?: Record<string, boolean> };
type Update = { where: Record<string, Row>; data: Row };
type Treaty = {
  id: number;
  fromNationId: number;
  toNationId: number;
  clauses: unknown[];
  status: 'PROPOSED' | 'ACTIVE' | 'EXPIRED' | 'ENDED';
  proposedTick: number;
  respondByTick: number;
  startTick: number | null;
  endTick: number | null;
  costFrom: number | null;
  costTo: number | null;
  closedSequence: number | null;
};
function proposed(): Treaty {
  return {
    id: 1,
    fromNationId: 1,
    toNationId: 2,
    clauses: [{ kind: 'peace' }],
    status: 'PROPOSED',
    proposedTick: 0,
    respondByTick: 60000,
    startTick: null,
    endTick: null,
    costFrom: null,
    costTo: null,
    closedSequence: null,
  };
}
function active(permanent = false): Treaty {
  return {
    ...proposed(),
    status: 'ACTIVE',
    clauses: permanent
      ? [{ kind: 'peace' }, { kind: 'note', text: '외교 회담을 이어 간다.' }]
      : [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }],
    startTick: 50000,
    endTick: permanent ? null : 60000,
    costFrom: 17,
    costTo: 17,
  };
}

// 실제 월간·투영·닫힘·해시 함수를 호출한다. 메모리 TX이므로 DB 원자성 증거가 아니다.
async function fixture(treaties: Treaty[] = [], caps = true, policyFromSequence: number | null = null) {
  const initial = await monthlyFixture();
  initial.diplomacies = treaties.some((entry) => entry.endTick === 60000)
    ? [{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 60000 }]
    : [];
  const origin: CapsOrigin = {
    version: 6,
    initial: structuredClone(initial),
    initialStateHash: hashState(initial),
    resourceHash: '',
    capabilities: { version: 1, treaty: { version: 1 } },
  };
  origin.resourceHash = hashState(capsResourceHashInput(origin));
  const world = {
    id: 'world',
    startYear: initial.startYear,
    monthlyTick: 50000,
    treatyFormat: caps ? 1 : null,
    personnelFormat: null,
    replayOrigin: caps
      ? origin
      : {
          version: 1,
          initial: origin.initial,
          initialStateHash: origin.initialStateHash,
          resourceHash: resourceHash(initial),
        },
    actionSequence: 7,
    policyFromSequence,
    turnTermMinutes: 30,
    endYear: null,
    outcomeFromSequence: 0,
    preset: null,
    commandMeta: null,
  };
  const trace: string[] = [];
  const withWorld = <T extends object>(rows: T[]) =>
    rows.map((row) => ({ ...structuredClone(row), worldId: world.id }));
  const cities = withWorld(initial.cities);
  const nations = withWorld(initial.nations);
  const generals = withWorld(initial.generals).map((row) => ({
    ...row,
    turnRevision: 0,
    battleWins: 0,
    captures: 0,
    defaultPolicy: 'none',
    lastActiveTick: null,
    lastActiveAt: null,
    noticeSeen: 0,
  }));
  let diplomacies = withWorld(initial.diplomacies);
  const rows = withWorld(treaties);
  const read = (values: object[], args: Read = {}) =>
    values.map((value) => {
      const result = { ...structuredClone(value) } as Row;
      if (args.select) return Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]]));
      for (const key of Object.keys(args.omit ?? {})) delete result[key];
      return result;
    });
  const update = (values: object[], key: string, label: string) =>
    vi.fn(async ({ where, data }: Update) => {
      const id = Object.values(where)[0]![key];
      const found = values.find((value) => (value as Row)[key] === id);
      if (!found) throw new Error('단위 저장 행이 없습니다.');
      trace.push(label);
      Object.assign(found, structuredClone(data));
      return found;
    });
  const snapshots: Row[] = [];
  const tx = {
    world: {
      findUniqueOrThrow: vi.fn(async () => ({ ...world })),
      update: vi.fn(async ({ data }: { data: Row }) => {
        if ('actionSequence' in data) throw new Error('월간 처리기가 sequence를 배정했습니다.');
        trace.push('monthlyTick');
        Object.assign(world, data);
        return { ...world };
      }),
    },
    city: { findMany: vi.fn(async (args: Read) => read(cities, args)), update: update(cities, 'cityKey', 'city') },
    nation: { findMany: vi.fn(async (args: Read) => read(nations, args)), update: update(nations, 'id', 'nation') },
    general: { findMany: vi.fn(async (args: Read) => read(generals, args)), update: update(generals, 'id', 'general') },
    diplomacy: {
      findMany: vi.fn(async () => read(diplomacies)),
      deleteMany: vi.fn(async () => {
        trace.push('diplomacy-delete');
        diplomacies = [];
      }),
      createMany: vi.fn(async ({ data }: { data: typeof diplomacies }) => {
        trace.push('diplomacy-create');
        diplomacies = structuredClone(data);
      }),
    },
    treaty: {
      findMany: vi.fn(async ({ where, ...args }: Read & { where: { status?: { in: string[] } } }) => {
        trace.push('treaty-read');
        return read(
          rows.filter((row) => !where.status || where.status.in.includes(row.status)),
          args,
        );
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: number; status: string; closedSequence: null }; data: Row }) => {
          trace.push('closure');
          const found = rows.find(
            (row) => row.id === where.id && row.status === where.status && row.closedSequence === null,
          );
          if (!found) return { count: 0 };
          Object.assign(found, data);
          return { count: 1 };
        },
      ),
    },
    generalTurn: {
      findMany: vi.fn(async () =>
        policyFromSequence === null
          ? []
          : generals.flatMap((general) =>
              Array.from({ length: 30 }, (_, slot) => ({
                worldId: world.id,
                generalId: general.id,
                slot,
                commandKey: 'rest',
                args: {},
                explicit: true,
              })),
            ),
      ),
    },
    nationTurn: { findMany: vi.fn().mockResolvedValue([]) },
    yearbookSnapshot: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        trace.push('snapshot');
        snapshots.push(structuredClone(data));
      }),
    },
    yearbookNation: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    nationHistory: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    rankingSnapshot: { upsert: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => {
      throw new Error('예상하지 않은 단위 쓰기입니다.');
    }),
  };
  return {
    initial,
    world,
    rows,
    trace,
    snapshots,
    nations,
    cities,
    generals,
    tx,
    client: tx as unknown as Prisma.TransactionClient,
    run: () => persistMonthly(tx as unknown as Prisma.TransactionClient, world.id, initial.seed, 60000, 7),
  };
}

it('제안 만료를 월간 sequence로 저장한 뒤 현재 replay 해시를 스냅샷에 쓴다 (단위)', async () => {
  const f = await fixture([proposed()]);
  const before = await loadWorld(f.client, f.world.id);
  f.trace.length = 0;
  const date = monthlyDate(before.startYear, 60000);
  const expected = settleTreaties(
    runMonthly(before, 60000, rngFor(f.initial.seed, 'monthly', date.year, date.month)).state,
    60000,
  );
  const next = await f.run();
  expect(next).toEqual(expected);
  expect(Object.hasOwn(next, 'treaties')).toBe(false);
  expect(f.rows[0]).toMatchObject({ status: 'EXPIRED', closedSequence: 7 });
  expect(f.tx.treaty.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { worldId: 'world', id: 1, status: 'PROPOSED', closedSequence: null },
    data: { status: 'EXPIRED', closedSequence: 7 },
  });
  const closure = f.trace.indexOf('closure'),
    tick = f.trace.indexOf('monthlyTick'),
    snapshot = f.trace.indexOf('snapshot');
  expect(f.trace.indexOf('diplomacy-create')).toBeLessThan(closure);
  expect(closure).toBeLessThan(tick);
  expect(tick).toBeLessThan(snapshot);
  expect(f.trace.slice(tick + 1, snapshot)).toContain('treaty-read');
  expect(f.snapshots[0]!.stateHash).toBe(hashState(await loadReplayState(f.client, 'world')));
  expect(f.tx.world.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'world' }, data: { monthlyTick: 60000 } });
  for (const write of [f.tx.city.update, f.tx.nation.update, f.tx.general.update]) {
    const targets = write.mock.calls.map(([args]) => JSON.stringify(args.where));
    expect(new Set(targets).size).toBe(targets.length);
  }
});

it('불가침 관계를 먼저 정산하고 끝난 ACTIVE 조약을 해시 전에 닫는다 (단위)', async () => {
  const f = await fixture([active()]);
  const next = await f.run();
  expect(next.diplomacies).toEqual([]);
  expect(Object.hasOwn(next, 'treaties')).toBe(false);
  expect(f.rows[0]).toMatchObject({ status: 'ENDED', closedSequence: 7 });
  expect(f.tx.diplomacy.deleteMany).toHaveBeenCalledOnce();
  expect(f.tx.diplomacy.createMany).toHaveBeenCalledOnce();
  expect(f.snapshots[0]!.stateHash).toBe(hashState(await loadReplayState(f.client, 'world')));
});

it('기한 없는 note 조약은 월간 뒤에도 canonical fragment로 남는다 (단위)', async () => {
  const f = await fixture([active(true)]);
  const original = structuredClone(f.rows);
  const next = await f.run();
  expect(next.treaties?.[0]).toMatchObject({
    status: 'ACTIVE',
    endTick: null,
    clauses: [{ kind: 'peace' }, { kind: 'note', text: '외교 회담을 이어 간다.' }],
  });
  expect(f.rows).toEqual(original);
  expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
  expect((await loadReplayState(f.client, 'world')).state.treaties).toEqual(next.treaties);
  expect(f.snapshots[0]!.stateHash).toBe(hashState(await loadReplayState(f.client, 'world')));
});

it('멸망한 당사국의 ACTIVE 조약도 같은 월간 sequence로 닫는다 (단위)', async () => {
  const f = await fixture([active(true)]);
  f.nations.splice(1, 1);
  for (const city of f.cities) if (city.nationId === 2) city.nationId = null;
  for (const general of f.generals) if (general.nationId === 2) general.nationId = null;
  expect(Object.hasOwn(await f.run(), 'treaties')).toBe(false);
  expect(f.rows[0]).toMatchObject({ status: 'ENDED', closedSequence: 7 });
});

it('off legacy 월간의 상태와 해시는 기존 정산 결과를 유지한다 (단위)', async () => {
  const f = await fixture([], false);
  const before = toWorldState(f.initial);
  const date = monthlyDate(before.startYear, 60000);
  const expected = runMonthly(before, 60000, rngFor(f.initial.seed, 'monthly', date.year, date.month)).state;
  expect(await f.run()).toEqual(expected);
  expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
  expect(Object.hasOwn((await loadReplayState(f.client, 'world')).state, 'treaties')).toBe(false);
  expect(f.snapshots[0]!.stateHash).toBe(hashState(await loadReplayState(f.client, 'world')));
});

it('빈 caps 월간은 빈 treaties 키를 만들지 않고 legacy와 같은 replay 해시를 쓴다 (단위)', async () => {
  const caps = await fixture(),
    off = await fixture([], false);
  expect(await caps.run()).toEqual(await off.run());
  expect(Object.hasOwn(await loadWorld(caps.client, 'world'), 'treaties')).toBe(false);
  expect(caps.snapshots[0]!.stateHash).toBe(off.snapshots[0]!.stateHash);
  expect(caps.tx.treaty.updateMany).not.toHaveBeenCalled();
});

it('닫힘 저장 실패는 monthlyTick과 스냅샷보다 먼저 전달된다 (단위, 롤백 증거 아님)', async () => {
  const f = await fixture([proposed()]);
  f.tx.treaty.updateMany.mockResolvedValueOnce({ count: 0 });
  await expect(f.run()).rejects.toThrow('마감 대상');
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.tx.yearbookSnapshot.create).not.toHaveBeenCalled();
});

it.each([0, 1])('정책 F=%s 월간도 닫힌 행 뒤 policy 포함 replay 해시를 쓴다 (단위)', async (fromSequence) => {
  const f = await fixture([proposed()], true, fromSequence);
  await f.run();
  const replay = await loadReplayState(f.client, 'world');
  expect(replay.policy).toEqual({
    turnTermMinutes: 30,
    policies: { 1: 'none', 2: 'none', 3: 'none' },
    lastActiveTicks: {},
  });
  expect(Object.hasOwn(replay.state, 'treaties')).toBe(false);
  expect(f.rows[0]).toMatchObject({ status: 'EXPIRED', closedSequence: 7 });
  expect(f.snapshots[0]!.stateHash).toBe(hashState(replay));
});

it('아직 연결하지 않은 passage 저장 행은 월간 쓰기 전에 기존 gate가 거부한다 (단위)', async () => {
  const row = active(true);
  row.clauses = [{ kind: 'peace' }, { kind: 'passage', cityKeys: [2] }];
  const f = await fixture([row]);
  await expect(f.run()).rejects.toThrow('조항을 확인하세요');
  expect(f.tx.city.update).not.toHaveBeenCalled();
  expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
  expect(f.tx.world.update).not.toHaveBeenCalled();
  expect(f.tx.yearbookSnapshot.create).not.toHaveBeenCalled();
});
