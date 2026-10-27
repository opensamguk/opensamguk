import { createDb, type Prisma } from '@opensamguk/db';
import {
  applyTreatyInput,
  calculateTreatyFee,
  selectWorldCapabilities,
  toGameDate,
  toWorldState,
} from '@opensamguk/rules';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFixture } from '../../test/readFixture';
import { listTreaties, quoteTreaty } from './treatyReads';

type World = Prisma.WorldGetPayload<Record<string, never>>;
type General = Prisma.GeneralGetPayload<Record<string, never>>;
type Nation = Prisma.NationGetPayload<Record<string, never>>;
type Treaty = Prisma.TreatyGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
const alice = 'session-alice',
  bob = 'session-bob';
const requestId = '10000000-0000-4000-8000-000000000001';
const foreignRequestId = '20000000-0000-4000-8000-000000000002';
const identity = { worldId: 'world', userId: alice, cursor: undefined };
let initial: Awaited<ReturnType<typeof readFixture>>;
beforeAll(async () => {
  initial = await readFixture();
  initial.generals[0]!.nationId = 1;
  initial.generals[0]!.officerLevel = 12;
  initial.generals[1]!.nationId = 2;
  initial.generals[1]!.officerLevel = 12;
  initial.nations.forEach((n) => {
    n.isNpc = false;
    n.gold = 10000;
  });
});
const json = (value: unknown): Prisma.JsonValue => JSON.parse(JSON.stringify(value));
// selector와 조회 투영을 위한 저장 행 단위다. DB 생성·factory·HTTP의 증거가 아니다.
function world(patch: Partial<World> = {}): World {
  return {
    id: 'world',
    name: '조약 조회 단위',
    operationalMap: null,
    presetKey: null,
    preset: null,
    scenarioKey: '1030',
    mapKey: 'che',
    unitSetKey: 'basic',
    seed: 'read-unit',
    startYear: 191,
    endYear: null,
    clockMode: 'REALTIME',
    outcomeFromSequence: 0,
    turnTermMinutes: 30,
    status: 'RUNNING',
    clockTick: 1501,
    clockAnchorAt: null,
    clockRevision: 0,
    startedAt: null,
    endedAt: null,
    initialStateHash: 'unit-storage-only',
    statRules: {},
    unitSet: {},
    createdAt: new Date(0),
    monthlyTick: 0,
    actionSequence: 100,
    policyFromSequence: null,
    treatyFormat: 1,
    replayFormat: 1,
    ruleFeatures: [],
    personnelFormat: null,
    replayOrigin: json({
      version: 6,
      initial,
      initialStateHash: 'unit-storage-only',
      resourceHash: 'unit-resource',
      capabilities: { version: 1, treaty: { version: 1 } },
    }),
    commandMeta: null,
    ...patch,
  };
}
function general(patch: Partial<General> = {}): General {
  return {
    ...initial.generals[0]!,
    politics: null,
    charm: null,
    worldId: 'world',
    userId: alice,
    battleWins: 0,
    captures: 0,
    turnRevision: 0,
    defaultPolicy: null,
    lastActiveTick: null,
    lastActiveAt: null,
    residenceTick: null,
    noticeSeen: null,
    ...patch,
  };
}
function nation(id = 1, patch: Partial<Nation> = {}): Nation {
  return {
    ...initial.nations[id - 1]!,
    worldId: 'world',
    notice: '비공개 표지',
    noticeRevision: 0,
    noticeUpdatedAt: null,
    noticeUpdatedBy: null,
    ...patch,
  };
}
function proposal() {
  const result = applyTreatyInput(
    toWorldState(initial),
    {
      generalId: 1,
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'nonAggression', months: 12 }] },
    },
    { tick: 1500, sequence: 10 },
  );
  if (!result.ok || result.result.outcome !== 'PROPOSED') throw new Error('제안 fixture 실패');
  return result;
}
function stored(patch: Partial<Treaty> = {}): Treaty {
  const result = proposal();
  return {
    ...result.state.treaties![0]!,
    worldId: 'world',
    clauses: json(result.state.treaties![0]!.clauses),
    costFrom: null,
    costTo: null,
    closedSequence: null,
    ...patch,
  };
}
function pending(patch: Partial<Event> = {}): Event {
  return {
    id: 1n,
    worldId: 'world',
    userId: alice,
    generalId: 1,
    kind: 'treaty.propose',
    idempotencyKey: `treaty.propose:${requestId}`,
    payload: { toNationId: 2, clauses: [{ kind: 'nonAggression', months: 12 }] },
    status: 'PENDING',
    sequence: null,
    stepTick: null,
    tick: null,
    result: null,
    createdAt: new Date(0),
    ...patch,
  };
}
function completed(patch: Partial<Event> = {}): Event {
  const result = proposal();
  return pending({ status: 'APPLIED', sequence: 10, result: json(result.result), ...patch });
}
const clients: ReturnType<typeof createDb>[] = [];
function fixture() {
  const db = createDb('postgresql://unused@127.0.0.1:1/unused');
  clients.push(db);
  const w = world(),
    actor = general();
  const worlds = vi.spyOn(db.world, 'findUnique').mockResolvedValue(w);
  const actorQuery = vi.spyOn(db.general, 'findUnique').mockResolvedValue(actor);
  const generals = vi.spyOn(db.general, 'findMany').mockResolvedValue([actor]);
  const nations = vi.spyOn(db.nation, 'findMany').mockResolvedValue([nation(1), nation(2)]);
  const nationQuery = vi.spyOn(db.nation, 'findUnique').mockResolvedValue(nation(1));
  const diplomacies = vi.spyOn(db.diplomacy, 'findMany').mockResolvedValue([]);
  const diplomacy = vi.spyOn(db.diplomacy, 'findUnique').mockResolvedValue(null);
  const treaties = vi.spyOn(db.treaty, 'findMany').mockResolvedValue([]);
  const events = vi.spyOn(db.inputEvent, 'findMany').mockResolvedValue([]);
  const count = vi.spyOn(db.city, 'count').mockResolvedValue(1);
  const groups = vi.spyOn(db.city, 'groupBy').mockResolvedValue([
    {
      ...initial.cities[0]!,
      kind: null,
      worldId: 'world',
      nationId: 1,
      _count: { _all: 1 },
      _avg: undefined,
      _sum: undefined,
      _min: undefined,
      _max: undefined,
    },
    {
      ...initial.cities[1]!,
      kind: null,
      worldId: 'world',
      nationId: 2,
      _count: { _all: 1 },
      _avg: undefined,
      _sum: undefined,
      _min: undefined,
      _max: undefined,
    },
  ]);
  const nested = vi.spyOn(db, '$transaction').mockImplementation(() => {
    throw new Error('새 트랜잭션을 열면 안 됩니다.');
  });
  const write = vi.spyOn(db.inputEvent, 'create').mockImplementation(() => {
    throw new Error('입력을 쓰면 안 됩니다.');
  });
  return {
    db,
    w,
    actor,
    worlds,
    actorQuery,
    generals,
    nations,
    nationQuery,
    diplomacies,
    diplomacy,
    treaties,
    events,
    count,
    groups,
    nested,
    write,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((db) => db.$disconnect()));
});
function incoming(f: ReturnType<typeof fixture>, row = stored({ fromNationId: 2, toNationId: 1 })) {
  f.treaties.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
}
function assertNoPrivate(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      'gold',
      'rice',
      'tech',
      'isNpc',
      'generalId',
      'userId',
      'idempotencyKey',
      'sequence',
      'resultTick',
      'brokenBy',
      'counterpartTrust',
      'canBreak',
      'monthsLeft',
    ]).not.toContain(key);
    assertNoPrivate(child);
  }
}

describe('T2-07 / AC-M2-06 새 조회 leaf 보조 단위', () => {
  it('L1 한 tx에서 공개 국가·관계·날짜·쪽 나누기만 고른다', async () => {
    const f = fixture();
    expect(selectWorldCapabilities(f.w).kind).toBe('caps');
    f.diplomacies.mockResolvedValue([
      { worldId: 'world', nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 120000 },
    ]);
    const rows = Array.from({ length: 31 }, (_, i) => stored({ id: 100 - i }));
    f.treaties.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    const result = await listTreaties(f.db, { ...identity, cursor: '101' });
    expect(result.items.map((r) => r.id)).toEqual(rows.slice(0, 30).map((r) => String(r.id)));
    expect(result.nextCursor).toBe('71');
    expect(result.items[0]).toMatchObject({
      from: { id: 1, name: nation(1).name, color: nation(1).color },
      to: { id: 2 },
      proposedAt: toGameDate(191, 1500),
      respondBy: toGameDate(191, 61500),
      startAt: null,
      endAt: null,
      estimate: { mine: 100, theirs: 100 },
      canAccept: null,
      canReject: null,
      cost: null,
    });
    expect(result.targets).toEqual([
      {
        nation: { id: 2, name: nation(2).name, color: nation(2).color },
        relation: 'NON_AGGRESSION',
        relationEndAt: toGameDate(191, 120000),
      },
    ]);
    for (const state of ['DECLARED', 'WAR'] as const) {
      f.diplomacies.mockResolvedValue([{ worldId: 'world', nationA: 1, nationB: 2, state, untilTick: 120000 }]);
      const page = await listTreaties(f.db, identity);
      expect(page.targets).toEqual([
        {
          nation: { id: 2, name: nation(2).name, color: nation(2).color },
          relation: state,
          relationEndAt: state === 'DECLARED' ? toGameDate(191, 120000) : null,
        },
      ]);
    }
    expect(f.treaties).toHaveBeenNthCalledWith(1, {
      where: { worldId: 'world', fromNationId: 1, id: { lt: 101 } },
      orderBy: { id: 'desc' },
      take: 31,
    });
    expect(f.treaties).toHaveBeenNthCalledWith(2, {
      where: { worldId: 'world', toNationId: 1, id: { lt: 101 } },
      orderBy: { id: 'desc' },
      take: 31,
    });
    expect(f.nations).toHaveBeenCalledWith({
      where: { worldId: 'world' },
      select: { id: true, name: true, color: true },
      orderBy: { id: 'asc' },
    });
    expect(Object.keys(result).sort()).toEqual(['canPropose', 'items', 'myRecent', 'nextCursor', 'pending', 'targets']);
    expect(Object.keys(result.items[0]!).length).toBe(20);
    expect(f.nationQuery).not.toHaveBeenCalled();
    expect(f.nested).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    assertNoPrivate(result);
  });
  it('L2 양쪽 index의 결과를 합쳐 같은 국가의 받은 제안 안내를 계산한다', async () => {
    const f = fixture();
    f.treaties
      .mockResolvedValueOnce([stored({ id: 10 })])
      .mockResolvedValueOnce([stored({ id: 20, fromNationId: 2, toNationId: 1 })]);
    const result = await listTreaties(f.db, identity);
    expect(result.items.map((r) => r.id)).toEqual(['20', '10']);
    expect(result.items[0]).toMatchObject({
      incoming: true,
      canAccept: { ok: true },
      canReject: { ok: true },
      estimate: { mine: 100, theirs: 100 },
    });
    expect(f.nationQuery).toHaveBeenCalledExactlyOnceWith({
      where: { worldId_id: { worldId: 'world', id: 1 } },
      select: { gold: true },
    });
    expect(f.groups).toHaveBeenCalledWith({
      by: ['nationId'],
      where: { worldId: 'world', nationId: { in: [2, 1] }, OR: [{ kind: null }, { kind: 'CITY' }] },
      _count: { _all: true },
    });
  });
  it('L3 ACTIVE의 비용은 실제 차감액이며 추정과 응답 단추는 없다', async () => {
    const f = fixture(),
      proposed = proposal();
    const applied = applyTreatyInput(
      proposed.state,
      { generalId: 2, kind: 'treaty.respond', payload: { treatyId: '10', accept: true } },
      { tick: 1501, sequence: 11 },
    );
    if (!applied.ok || applied.result.outcome !== 'ACCEPTED') throw new Error('수락 fixture 실패');
    f.treaties
      .mockResolvedValueOnce([
        {
          ...stored(),
          ...applied.state.treaties![0]!,
          clauses: json(applied.state.treaties![0]!.clauses),
          costFrom: applied.result.cost.from,
          costTo: applied.result.cost.to,
        },
      ])
      .mockResolvedValueOnce([]);
    const result = await listTreaties(f.db, identity);
    expect(result.items[0]).toMatchObject({
      status: 'ACTIVE',
      cost: applied.result.cost,
      estimate: null,
      canAccept: null,
      canReject: null,
      respondBy: null,
      startAt: toGameDate(191, 1501),
      endAt: toGameDate(191, 121501),
    });
    expect(f.groups).not.toHaveBeenCalled();
    expect(f.nationQuery).not.toHaveBeenCalled();
  });
  it('L4 권한 없는 장수는 처리 중·기한·관계·국고 이유를 받지 않는다', async () => {
    const f = fixture();
    f.actor.officerLevel = 1;
    f.w.status = 'PAUSED';
    f.w.clockTick = 61500;
    f.diplomacies.mockResolvedValue([
      { worldId: 'world', nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 120000 },
    ]);
    incoming(f);
    f.events.mockResolvedValueOnce([]).mockResolvedValueOnce([
      pending({
        kind: 'treaty.respond',
        payload: { treatyId: '10', accept: true },
        idempotencyKey: `treaty.respond:${requestId}`,
      }),
    ]);
    const result = await listTreaties(f.db, identity);
    expect(result.canPropose).toMatchObject({ ok: false, code: 'NO_PERMISSION' });
    expect(result.items[0]).toMatchObject({
      canAccept: { ok: false, code: 'NO_PERMISSION' },
      canReject: { ok: false, code: 'NO_PERMISSION' },
      estimate: { mine: 100, theirs: 100 },
    });
    expect(f.nationQuery).not.toHaveBeenCalled();
  });
  it('L5 WORLD_CLOSED가 처리 중보다 먼저고 이름이 사라진 상대는 BAD_TARGET이다', async () => {
    const f = fixture();
    f.w.status = 'PAUSED';
    incoming(f);
    f.events.mockResolvedValueOnce([]).mockResolvedValueOnce([
      pending({
        kind: 'treaty.respond',
        payload: { treatyId: '10', accept: true },
        idempotencyKey: `treaty.respond:${requestId}`,
      }),
    ]);
    const closed = await listTreaties(f.db, identity);
    expect(closed.canPropose).toMatchObject({ code: 'WORLD_CLOSED' });
    expect(closed.items[0]?.canAccept).toMatchObject({ code: 'WORLD_CLOSED' });
    f.w.status = 'RUNNING';
    f.nations.mockResolvedValue([nation(1)]);
    incoming(f);
    const missing = await listTreaties(f.db, identity);
    expect(missing.items[0]).toMatchObject({
      from: null,
      fromNationId: 2,
      estimate: null,
      canAccept: { code: 'BAD_TARGET' },
      canReject: { code: 'BAD_TARGET' },
    });
    expect(f.nationQuery).not.toHaveBeenCalled();
  });
  it('L6 같은 국가의 pending은 보이되 남의 requestId와 내부 식별자는 숨긴다', async () => {
    const f = fixture();
    incoming(f);
    f.generals.mockResolvedValue([f.actor, general({ id: 2, userId: bob, name: '다른 직책자' })]);
    f.events.mockResolvedValueOnce([]).mockResolvedValueOnce([
      pending({
        kind: 'treaty.respond',
        payload: { treatyId: '10', accept: true },
        idempotencyKey: `treaty.respond:${requestId}`,
      }),
      pending({ id: 2n, userId: bob, generalId: 2, idempotencyKey: `treaty.propose:${foreignRequestId}` }),
    ]);
    const result = await listTreaties(f.db, identity);
    expect(result.pending).toEqual([
      {
        requestId,
        kind: 'treaty.respond',
        treatyId: '10',
        toNation: null,
        accept: true,
        requestedBy: { name: f.actor.name },
      },
      {
        requestId: null,
        kind: 'treaty.propose',
        treatyId: null,
        toNation: { id: 2, name: nation(2).name, color: nation(2).color },
        accept: null,
        requestedBy: { name: '다른 직책자' },
      },
    ]);
    expect(result.items[0]).toMatchObject({ canAccept: { code: 'IN_PROGRESS' }, canReject: { code: 'IN_PROGRESS' } });
    expect(f.events).toHaveBeenLastCalledWith({
      where: {
        worldId: 'world',
        status: 'PENDING',
        kind: { in: ['treaty.propose', 'treaty.respond'] },
        generalId: { in: [1, 2] },
      },
      orderBy: { id: 'asc' },
    });
    expect(f.generals).toHaveBeenCalledWith({
      where: { worldId: 'world', nationId: 1 },
      select: { id: true, name: true, userId: true },
    });
    expect(f.nationQuery).not.toHaveBeenCalled();
    assertNoPrivate(result);
  });
  it('L7 본인 recent만 최신 5건으로 조회하고 무소속이어도 보존한다', async () => {
    const f = fixture();
    f.actor.nationId = null;
    const rejected = completed({
      id: 2n,
      kind: 'treaty.respond',
      idempotencyKey: `treaty.respond:${requestId}`,
      sequence: 11,
      payload: { treatyId: '10', accept: true },
      status: 'REJECTED',
      result: { tick: 1501, code: 'TREATY_RELATION', message: '본인에게만 보이는 거절' },
    });
    f.events.mockResolvedValue([rejected, completed()]);
    const result = await listTreaties(f.db, identity);
    expect(f.actorQuery).toHaveBeenCalledWith({ where: { worldId_userId: { worldId: 'world', userId: alice } } });
    expect(f.events).toHaveBeenCalledExactlyOnceWith({
      where: {
        worldId: 'world',
        userId: alice,
        kind: { in: ['treaty.propose', 'treaty.respond'] },
        status: { in: ['APPLIED', 'REJECTED'] },
      },
      orderBy: { sequence: 'desc' },
      take: 5,
    });
    expect(result).toMatchObject({
      canPropose: { code: 'NO_PERMISSION' },
      items: [],
      targets: [],
      pending: [],
      nextCursor: null,
    });
    expect(result.myRecent).toEqual([
      {
        requestId,
        kind: 'treaty.respond',
        treatyId: '10',
        result: 'REJECTED',
        outcome: null,
        reason: '본인에게만 보이는 거절',
      },
      { requestId, kind: 'treaty.propose', treatyId: '10', result: 'APPLIED', outcome: 'PROPOSED', reason: null },
    ]);
    expect(f.nations).not.toHaveBeenCalled();
    assertNoPrivate(result);
  });
  it('L8 응답 안내는 공개 helper와 같고 상대 국고는 조회하지 않는다', async () => {
    const f = fixture();
    incoming(f);
    f.nationQuery.mockResolvedValue(nation(1, { gold: 99 }));
    const poor = await listTreaties(f.db, identity);
    expect(poor.items[0]).toMatchObject({ canAccept: { code: 'INSUFFICIENT_GOLD' }, canReject: { ok: true } });
    incoming(f);
    f.w.clockTick = 61500;
    const expired = await listTreaties(f.db, identity);
    expect(expired.items[0]).toMatchObject({ canAccept: { code: 'EXPIRED' }, canReject: { code: 'EXPIRED' } });
    incoming(f);
    f.w.clockTick = 1501;
    f.diplomacies.mockResolvedValue([
      { worldId: 'world', nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 90000 },
    ]);
    const relation = await listTreaties(f.db, identity);
    expect(relation.items[0]).toMatchObject({ canAccept: { code: 'TREATY_RELATION' }, canReject: { ok: true } });
    for (const [args] of f.nationQuery.mock.calls)
      expect(args).toEqual({ where: { worldId_id: { worldId: 'world', id: 1 } }, select: { gold: true } });
    assertNoPrivate(poor);
    assertNoPrivate(expired);
    assertNoPrivate(relation);
  });
  it('L9 잘못된 cursor·월드·legacy·장수·저장 기록은 조회를 멈춘다', async () => {
    const f = fixture();
    for (const cursor of ['-1', '01', '2147483648'])
      await expect(listTreaties(f.db, { ...identity, cursor })).rejects.toHaveProperty('code', 'BAD_REQUEST');
    expect(f.worlds).not.toHaveBeenCalled();
    f.worlds.mockResolvedValueOnce(null);
    await expect(listTreaties(f.db, identity)).rejects.toHaveProperty('code', 'NOT_FOUND');
    f.worlds.mockResolvedValueOnce(world({ treatyFormat: null, replayOrigin: null }));
    await expect(listTreaties(f.db, identity)).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
    f.actorQuery.mockResolvedValueOnce(null);
    await expect(listTreaties(f.db, identity)).rejects.toHaveProperty('code', 'NOT_FOUND');
    f.events.mockResolvedValueOnce([completed({ userId: bob })]);
    await expect(listTreaties(f.db, identity)).rejects.toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
    f.events.mockResolvedValueOnce([]).mockResolvedValueOnce([pending({ generalId: 999 })]);
    await expect(listTreaties(f.db, identity)).rejects.toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
    for (const event of [
      pending({ sequence: 1 }),
      pending({ result: { private: '파손 표지' } }),
      pending({ idempotencyKey: 'treaty.propose:bad' }),
      pending({ payload: { toNationId: 2, clauses: [], userId: bob } }),
    ]) {
      f.events.mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
      await expect(listTreaties(f.db, identity)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: '조약 조회 결과를 확인하지 못했습니다.',
      });
    }
    f.treaties.mockResolvedValueOnce([stored({ fromNationId: 3, toNationId: 4 })]).mockResolvedValueOnce([]);
    await expect(listTreaties(f.db, identity)).rejects.toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
  });
  it('L10 국고가 달라도 상대의 목록 본문은 같고 빈 도시 집계는 비용 0이다', async () => {
    const f = fixture();
    f.treaties.mockResolvedValueOnce([stored()]).mockResolvedValueOnce([]);
    const first = await listTreaties(f.db, identity);
    f.nations.mockResolvedValue([nation(1), nation(2, { gold: 0, rice: 23456, tech: 789, isNpc: true })]);
    f.treaties.mockResolvedValueOnce([stored()]).mockResolvedValueOnce([]);
    expect(JSON.stringify(await listTreaties(f.db, identity))).toBe(JSON.stringify(first));
    f.groups.mockResolvedValue([]);
    incoming(f);
    const empty = await listTreaties(f.db, identity);
    expect(empty.items[0]?.estimate).toEqual({ mine: 0, theirs: 0 });
  });
  it('L11 다른 세션 사용자는 현재 국가·장수와 본인 recent 조건으로 다시 조회한다', async () => {
    const f = fixture();
    f.actor.userId = bob;
    f.actor.id = 3;
    f.actor.nationId = 2;
    f.generals.mockResolvedValue([f.actor]);
    f.events
      .mockResolvedValueOnce([completed({ userId: bob, idempotencyKey: `treaty.propose:${foreignRequestId}` })])
      .mockResolvedValueOnce([]);
    f.treaties.mockResolvedValueOnce([]).mockResolvedValueOnce([stored()]);
    const result = await listTreaties(f.db, { ...identity, userId: bob });
    expect(f.actorQuery).toHaveBeenCalledWith({ where: { worldId_userId: { worldId: 'world', userId: bob } } });
    expect(f.treaties).toHaveBeenNthCalledWith(1, {
      where: { worldId: 'world', fromNationId: 2 },
      orderBy: { id: 'desc' },
      take: 31,
    });
    expect(f.treaties).toHaveBeenNthCalledWith(2, {
      where: { worldId: 'world', toNationId: 2 },
      orderBy: { id: 'desc' },
      take: 31,
    });
    expect(f.events).toHaveBeenNthCalledWith(1, {
      where: {
        worldId: 'world',
        userId: bob,
        kind: { in: ['treaty.propose', 'treaty.respond'] },
        status: { in: ['APPLIED', 'REJECTED'] },
      },
      orderBy: { sequence: 'desc' },
      take: 5,
    });
    expect(f.events).toHaveBeenLastCalledWith({
      where: {
        worldId: 'world',
        status: 'PENDING',
        kind: { in: ['treaty.propose', 'treaty.respond'] },
        generalId: { in: [3] },
      },
      orderBy: { id: 'asc' },
    });
    expect(result.targets.map((t) => t.nation.id)).toEqual([1]);
    expect(result.myRecent[0]?.requestId).toBe(foreignRequestId);
    expect(JSON.stringify(result)).not.toContain(alice);
    assertNoPrivate(result);
  });
  it('V1 quote를 공개 비용과 단일 문제로 투영하고 쓰기·중첩 tx는 없다', async () => {
    const f = fixture();
    f.nationQuery.mockResolvedValue(nation(2));
    f.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const result = await quoteTreaty(f.db, {
      ...identity,
      payload: {
        toNationId: 2,
        clauses: [
          { kind: 'note', text: '\u1100\u1161' },
          { kind: 'nonAggression', months: 12 },
        ],
      },
    });
    expect(result).toEqual({
      cost: { mine: calculateTreatyFee(2, 12), theirs: calculateTreatyFee(1, 12) },
      problem: null,
    });
    expect(f.nationQuery).toHaveBeenCalledExactlyOnceWith({
      where: { worldId_id: { worldId: 'world', id: 2 } },
      select: { id: true },
    });
    expect(f.diplomacy).toHaveBeenCalledWith({
      where: { worldId_nationA_nationB: { worldId: 'world', nationA: 1, nationB: 2 } },
      select: { state: true },
    });
    expect(f.count).toHaveBeenNthCalledWith(1, {
      where: { worldId: 'world', nationId: 1, OR: [{ kind: null }, { kind: 'CITY' }] },
    });
    expect(f.count).toHaveBeenNthCalledWith(2, {
      where: { worldId: 'world', nationId: 2, OR: [{ kind: null }, { kind: 'CITY' }] },
    });
    expect(f.nested).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    assertNoPrivate(result);
  });
  it('V2 권한이 없으면 조항 판정과 상대 조회를 하지 않는다', async () => {
    const f = fixture();
    f.actor.officerLevel = 1;
    await expect(
      quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [{ kind: 'trade', months: 12 }] } }),
    ).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(f.nationQuery).not.toHaveBeenCalled();
    expect(f.diplomacy).not.toHaveBeenCalled();
    expect(f.count).not.toHaveBeenCalled();
    f.actor.nationId = null;
    await expect(quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [] } })).rejects.toHaveProperty(
      'code',
      'FORBIDDEN',
    );
  });
  it('V3 잘못된 구조는 고정 BAD_REQUEST이고 종료 월드는 상대 조회 전에 막는다', async () => {
    const f = fixture();
    await expect(
      quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [], generalId: 999 } }),
    ).rejects.toHaveProperty('code', 'BAD_REQUEST');
    expect(f.actorQuery).not.toHaveBeenCalled();
    f.w.status = 'ENDED';
    await expect(quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [] } })).rejects.toHaveProperty(
      'code',
      'PRECONDITION_FAILED',
    );
    expect(f.actorQuery).not.toHaveBeenCalled();
    expect(f.nationQuery).not.toHaveBeenCalled();
  });
  it('V4 자기 국가·Int 범위 밖·없는 상대는 BAD_TARGET이며 DB Int 오류가 없다', async () => {
    const f = fixture();
    for (const toNationId of [1, 2147483648])
      expect(
        await quoteTreaty(f.db, { ...identity, payload: { toNationId, clauses: [{ kind: 'note', text: '기록' }] } }),
      ).toMatchObject({ cost: null, problem: { code: 'BAD_TARGET' } });
    expect(f.nationQuery).not.toHaveBeenCalled();
    f.nationQuery.mockResolvedValue(null);
    expect(
      await quoteTreaty(f.db, { ...identity, payload: { toNationId: 999, clauses: [{ kind: 'note', text: '기록' }] } }),
    ).toMatchObject({ cost: null, problem: { code: 'BAD_TARGET' } });
    expect(f.count).not.toHaveBeenCalled();
    expect(f.diplomacy).not.toHaveBeenCalled();
  });
  it('V5 도메인이 상대보다 먼저고 관계 문제에도 공개 비용은 남는다', async () => {
    const f = fixture();
    expect(await quoteTreaty(f.db, { ...identity, payload: { toNationId: 1, clauses: [] } })).toMatchObject({
      cost: null,
      problem: { code: 'BAD_INPUT' },
    });
    f.nationQuery.mockResolvedValue(nation(2));
    expect(
      await quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [{ kind: 'trade', months: 12 }] } }),
    ).toMatchObject({ cost: null, problem: { code: 'CLAUSE_NOT_CONNECTED' } });
    expect(
      await quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [{ kind: 'peace' }] } }),
    ).toMatchObject({ cost: { mine: 0, theirs: 0 }, problem: { code: 'TREATY_RELATION' } });
  });
  it('V6 helper의 범위 오류만 고정 내부 오류로 바꾸고 DB 오류는 덮지 않는다', async () => {
    const f = fixture();
    f.nationQuery.mockResolvedValue(nation(2));
    f.count.mockResolvedValue(Number.MAX_SAFE_INTEGER);
    await expect(
      quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [{ kind: 'nonAggression', months: 120 }] } }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: '조약 조회 결과를 확인하지 못했습니다.' });
    const databaseError = new Error('단위 DB 오류');
    f.nationQuery.mockRejectedValueOnce(databaseError);
    await expect(
      quoteTreaty(f.db, { ...identity, payload: { toNationId: 2, clauses: [{ kind: 'note', text: '기록' }] } }),
    ).rejects.toBe(databaseError);
  });
});
