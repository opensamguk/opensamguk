import type { Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { parsePreset, presetRules } from '@opensamguk/rules';
import { expect, it, vi } from 'vitest';
import legacy from '../test/fixtures/replay-v1-b8f5074.json';
import { assertWorldCapabilities } from './capsGate';
import { loadWorld } from './worldLoader';

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
const statuses = ['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED'] as const;
const keys = [
  'id',
  'fromNationId',
  'toNationId',
  'clauses',
  'status',
  'proposedTick',
  'respondByTick',
  'startTick',
  'endTick',
  'costFrom',
  'costTo',
  'closedSequence',
];
function world(changes: Partial<World> = {}): World {
  return {
    id: 'world',
    replayFormat: 1,
    ruleFeatures: [],
    status: 'RUNNING',
    preset: null,
    commandMeta: null,
    startYear: legacy.origin.initial.startYear,
    treatyFormat: 1,
    personnelFormat: null,
    policyFromSequence: null,
    actionSequence: 0,
    turnTermMinutes: 30,
    endYear: null,
    outcomeFromSequence: 0,
    replayOrigin: { ...legacy.origin, version: 6, capabilities: { version: 1, treaty: { version: 1 } } },
    ...changes,
  } as unknown as World;
}
function row(status: (typeof statuses)[number] = 'ACTIVE', id = 1) {
  const open = status === 'PROPOSED' || status === 'ACTIVE';
  return {
    worldId: 'world',
    id,
    fromNationId: 1,
    toNationId: 2,
    clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }],
    status,
    proposedTick: 500,
    respondByTick: 60500,
    startTick: status === 'PROPOSED' ? null : 1500,
    endTick: status === 'PROPOSED' ? null : 11500,
    costFrom: status === 'PROPOSED' ? null : 17,
    costTo: status === 'PROPOSED' ? null : 9,
    closedSequence: open ? null : 20,
  };
}
type Query = {
  where: { worldId: string; status?: { in: string[] } };
  select?: Record<string, boolean>;
  orderBy?: unknown;
};
function transaction(rows: unknown[] = [], storedWorld = world()) {
  const write = vi.fn(() => {
    throw new Error('읽기 시험에서 쓰기를 호출했습니다.');
  });
  const findMany = vi.fn(async (query: Query) => {
    expect(query.where.worldId).toBe(storedWorld.id);
    const found = rows.filter(
      (value) => !query.where.status || query.where.status.in.includes((value as { status: string }).status),
    );
    return structuredClone(
      query.select
        ? found.map((value) =>
            Object.fromEntries(Object.keys(query.select!).map((key) => [key, (value as Record<string, unknown>)[key]])),
          )
        : found,
    );
  });
  const city = vi.fn().mockResolvedValue([]);
  const tx = {
    world: { findUniqueOrThrow: vi.fn().mockResolvedValue(storedWorld), update: write, updateMany: write },
    treaty: { findMany, create: write, update: write, updateMany: write, deleteMany: write },
    city: { findMany: city, update: write },
    nation: { findMany: vi.fn().mockResolvedValue([]) },
    general: { findMany: vi.fn().mockResolvedValue([]) },
    diplomacy: { findMany: vi.fn().mockResolvedValue([]) },
    nationTurn: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: write,
  };
  return { tx: tx as unknown as Prisma.TransactionClient, findMany, city, write };
}

it('3a gate는 모든 status의 열두 칸을 읽고 선택만 반환한다 (단위 stub)', async () => {
  const input = statuses.map((status, id) => row(status, id + 1));
  const before = structuredClone(input);
  const { tx, findMany, write } = transaction(input);
  expect((await assertWorldCapabilities(tx, world())).kind).toBe('caps');
  expect(findMany).toHaveBeenCalledOnce();
  const query = findMany.mock.calls[0]![0];
  expect(query.where).toEqual({ worldId: 'world' });
  expect(Object.keys(query.select!).sort()).toEqual([...keys].sort());
  expect(input).toEqual(before);
  expect(write).not.toHaveBeenCalled();
});

it('T4-17 B ext 단독의 조약 잔존 검사는 한 번이고 loadWorld는 열린 조약을 읽지 않는다 (단위)', async () => {
  const commands = { general: ['fire_attack'], nation: [] };
  const preset = parsePreset({ ...regular, commands });
  // 조약 guard만 보는 손 행이다. 실제 생성·적재와 프리셋 대조의 증거가 아니다.
  const stored = world({
    preset: preset as unknown as Prisma.JsonObject,
    treatyFormat: null,
    policyFromSequence: 0,
    replayOrigin: {
      ...legacy.origin,
      version: 6,
      initial: { ...legacy.origin.initial, presetRules: presetRules(preset) },
      capabilities: { version: 1, ext: { version: 1, commands, preset, resources: {}, sliceKeys: [] } },
    } as unknown as Prisma.JsonObject,
  });
  const empty = transaction([], stored);
  const loaded = await loadWorld(empty.tx, stored.id);
  expect(loaded).not.toHaveProperty('treaties');
  expect(empty.findMany).toHaveBeenCalledOnce();
  expect(empty.findMany.mock.calls[0]![0].where).toEqual({ worldId: stored.id });
  expect(empty.write).not.toHaveBeenCalled();
  for (const status of statuses) {
    const f = transaction([row(status)], stored);
    await expect(assertWorldCapabilities(f.tx, stored)).rejects.toThrow('조약을 끈 월드');
    expect(f.findMany).toHaveBeenCalledOnce();
    expect(f.write).not.toHaveBeenCalled();
  }
});

it.each(statuses)('3a off 월드는 %s 잔여 행도 거부한다 (단위 stub)', async (status) => {
  for (const replayOrigin of [null, { version: 1 }]) {
    const stored = world({ treatyFormat: null, replayOrigin });
    const { tx, write } = transaction([row(status)], stored);
    await expect(assertWorldCapabilities(tx, stored)).rejects.toThrow('조약을 끈 월드');
    expect(write).not.toHaveBeenCalled();
  }
});

it.each(['REJECTED', 'EXPIRED', 'ENDED'] as const)(
  '3a 닫힌 %s의 마감·비용 파손을 열린 행과 같은 투영기로 거부한다 (단위 stub)',
  async (status) => {
    for (const broken of [
      { ...row(status), closedSequence: null },
      { ...row(status), costFrom: -1 },
      { ...row(status), clauses: null },
    ]) {
      const { tx, write } = transaction([broken]);
      await expect(assertWorldCapabilities(tx, world())).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    }
  },
);

it.each(['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED'] as const)(
  '3a gate는 %s에서도 닫힌 파손 행을 건너뛰지 않는다 (단위 stub)',
  async (status) => {
    const stored = world({ status });
    const { tx, write } = transaction([{ ...row('ENDED'), closedSequence: null }], stored);
    await expect(assertWorldCapabilities(tx, stored)).rejects.toThrow('마감 기록');
    expect(write).not.toHaveBeenCalled();
  },
);

it('3a 형식·origin·정책 불일치는 저장 행 읽기 전에 실패한다 (단위 stub)', async () => {
  const personnelOrigin = {
    ...legacy.origin,
    version: 6,
    capabilities: { version: 1, treaty: { version: 1 }, personnel: { version: 1 } },
  };
  for (const stored of [
    world({ treatyFormat: null }),
    world({ replayOrigin: null }),
    world({ policyFromSequence: 20, actionSequence: 19 }),
    world({ personnelFormat: 1 }),
    world({ replayOrigin: personnelOrigin }),
    world({ personnelFormat: 1, replayOrigin: personnelOrigin }),
  ]) {
    const { tx, findMany, write } = transaction([], stored);
    await expect(assertWorldCapabilities(tx, stored)).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  }
});

it('3a loadWorld는 실제 loadTreaties의 열린 fragment만 합친다 (단위 stub)', async () => {
  const { tx, findMany, write } = transaction([row(), row('PROPOSED', 2), row('ENDED', 3)]);
  const loaded = await loadWorld(tx, 'world');
  expect(loaded.treaties?.map(({ id }) => id)).toEqual([1, 2]);
  expect(Object.keys(loaded.treaties![0]!).sort()).toEqual(
    keys.filter((key) => !['costFrom', 'costTo', 'closedSequence'].includes(key)).sort(),
  );
  expect(findMany).toHaveBeenCalledTimes(2);
  expect(findMany.mock.calls[0]![0].where).toEqual({ worldId: 'world' });
  expect(findMany.mock.calls[1]![0].where.status).toEqual({ in: ['PROPOSED', 'ACTIVE'] });
  expect(write).not.toHaveBeenCalled();
});

it('3a 닫힌 행만 있으면 runtime에 빈 treaties 키를 만들지 않는다 (단위 stub)', async () => {
  const { tx, write } = transaction([row('ENDED')]);
  const loaded = await loadWorld(tx, 'world');
  expect(Object.hasOwn(loaded, 'treaties')).toBe(false);
  expect(loaded).toEqual({ startYear: world().startYear, cities: {}, nations: {}, generals: {}, diplomacies: [] });
  expect(write).not.toHaveBeenCalled();
});

it('3a off·origin null의 읽기는 기존 상태 모양과 해시를 유지한다 (단위 stub)', async () => {
  for (const replayOrigin of [null, { version: 1 }]) {
    const stored = world({ treatyFormat: null, replayOrigin });
    const { tx, findMany, write } = transaction([], stored);
    const loaded = await loadWorld(tx, 'world');
    expect(hashState(loaded)).toBe(
      hashState({ startYear: stored.startYear, cities: {}, nations: {}, generals: {}, diplomacies: [] }),
    );
    expect(Object.hasOwn(loaded, 'treaties')).toBe(false);
    expect(findMany).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  }
});

it('3a loadWorld는 닫힌 파손 행이면 기본 상태 읽기도 시작하지 않는다 (단위 stub)', async () => {
  const { tx, city, write } = transaction([{ ...row('ENDED'), closedSequence: null }]);
  await expect(loadWorld(tx, 'world')).rejects.toThrow('마감 기록');
  expect(city).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
