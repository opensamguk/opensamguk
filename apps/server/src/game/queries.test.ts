import type { Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { expect, it, vi } from 'vitest';
import { readView } from './queries';

const statuses = ['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED'] as const;
const origin = {
  version: 6,
  initial: { startYear: 190 },
  initialStateHash: 'initial',
  resourceHash: 'resource',
  capabilities: { version: 1, treaty: { version: 1 } },
};
function row(status: (typeof statuses)[number] = 'ACTIVE', id = 1) {
  return {
    worldId: 'world',
    id,
    fromNationId: 1,
    toNationId: 2,
    status,
    clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }],
    proposedTick: 500,
    respondByTick: 60500,
    startTick: status === 'PROPOSED' ? null : 1500,
    endTick: status === 'PROPOSED' ? null : 11500,
    costFrom: status === 'PROPOSED' ? null : 17,
    costTo: status === 'PROPOSED' ? null : 9,
    closedSequence: status === 'PROPOSED' || status === 'ACTIVE' ? null : 20,
  };
}
type Query = { where: { worldId: string }; select: Record<string, boolean> };
function transaction(rows: unknown[] = [], changes: Record<string, unknown> = {}) {
  const world = {
    id: 'world',
    preset: null,
    commandMeta: null,
    status: 'RUNNING',
    startYear: 190,
    treatyFormat: 1,
    personnelFormat: null,
    policyFromSequence: null,
    actionSequence: 0,
    turnTermMinutes: 30,
    endYear: null,
    outcomeFromSequence: 0,
    replayOrigin: origin,
    ...changes,
  };
  const write = vi.fn(() => {
    throw new Error('읽기 시험에서 쓰기를 호출했습니다.');
  });
  const findMany = vi.fn(async (query: Query) => {
    expect(query.where).toEqual({ worldId: world.id });
    return structuredClone(
      rows.map((value) =>
        Object.fromEntries(Object.keys(query.select).map((key) => [key, (value as Record<string, unknown>)[key]])),
      ),
    );
  });
  const city = vi.fn().mockResolvedValue([]);
  const tx = {
    world: { findUnique: vi.fn().mockResolvedValue(world), update: write },
    treaty: { findMany, create: write, update: write },
    city: { findMany: city },
    nation: { findMany: vi.fn().mockResolvedValue([]) },
    general: { findMany: vi.fn().mockResolvedValue([]) },
    diplomacy: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: write,
  };
  return { tx: tx as unknown as Prisma.TransactionClient, findMany, city, write };
}

it('3a readView는 모든 status를 검사하고 toWorldState 뒤 열린 조약만 붙인다 (단위 stub)', async () => {
  const { tx, findMany, write } = transaction(statuses.map((status, id) => row(status, id + 1)));
  const loaded = await readView(tx, 'world');
  expect(loaded.treaties?.map(({ id }) => id)).toEqual([1, 2]);
  expect(Object.keys(loaded.treaties![0]!).sort()).toEqual(
    [
      'id',
      'fromNationId',
      'toNationId',
      'status',
      'clauses',
      'proposedTick',
      'respondByTick',
      'startTick',
      'endTick',
    ].sort(),
  );
  expect(findMany).toHaveBeenCalledOnce();
  expect(findMany.mock.calls[0]![0].where).toEqual({ worldId: 'world' });
  expect(Object.keys(findMany.mock.calls[0]![0].select)).toHaveLength(12);
  expect(write).not.toHaveBeenCalled();
});

it.each(['REJECTED', 'EXPIRED', 'ENDED'] as const)(
  '3a readView도 닫힌 %s 파손을 거부한다 (단위 stub)',
  async (status) => {
    for (const broken of [
      { ...row(status), closedSequence: null },
      { ...row(status), clauses: null },
      { ...row(status), costFrom: -1 },
    ]) {
      const { tx, city, write } = transaction([broken]);
      await expect(readView(tx, 'world')).rejects.toThrow();
      expect(city).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }
  },
);

it.each(statuses)('3a readView는 off의 %s 잔여 행을 거부한다 (단위 stub)', async (status) => {
  const { tx, city, write } = transaction([row(status)], { treatyFormat: null, replayOrigin: null });
  await expect(readView(tx, 'world')).rejects.toThrow('조약을 끈 월드');
  expect(city).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('3a readView도 World 상태와 관계없이 같은 검사를 한다 (단위 stub)', async () => {
  for (const status of ['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED']) {
    const { tx, write } = transaction([{ ...row('ENDED'), closedSequence: null }], { status });
    await expect(readView(tx, 'world')).rejects.toThrow('마감 기록');
    expect(write).not.toHaveBeenCalled();
  }
});

it('3a readView는 off·닫힌 행뿐인 경우 빈 키와 metadata를 싣지 않는다 (단위 stub)', async () => {
  for (const fixture of [
    transaction([], { treatyFormat: null, replayOrigin: null }),
    transaction([], { treatyFormat: null, replayOrigin: { version: 1 } }),
    transaction([row('ENDED')]),
  ]) {
    const loaded = await readView(fixture.tx, 'world');
    expect(Object.hasOwn(loaded, 'treaties')).toBe(false);
    expect(hashState(loaded)).toBe(
      hashState({ startYear: 190, cities: {}, nations: {}, generals: {}, diplomacies: [] }),
    );
    expect(fixture.write).not.toHaveBeenCalled();
  }
});

it('3a readView의 정적 불일치는 저장 행 읽기 전에 실패한다 (단위 stub)', async () => {
  for (const changes of [{ treatyFormat: null }, { policyFromSequence: 20, actionSequence: 19 }]) {
    const { tx, findMany, city, write } = transaction([], changes);
    await expect(readView(tx, 'world')).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
    expect(city).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  }
});

it('3a readView는 열린 행과 닫힌 행의 중복 ID도 거부한다 (단위 stub)', async () => {
  const { tx, city, write } = transaction([row(), row('ENDED')]);
  await expect(readView(tx, 'world')).rejects.toThrow('ID');
  expect(city).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
