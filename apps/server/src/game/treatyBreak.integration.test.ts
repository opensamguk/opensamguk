import type { Prisma } from '@opensamguk/db';
import { applyTreatyInput, toWorldState } from '@opensamguk/rules';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFixture } from '../../test/readFixture';
import { listTrust } from './treatyReads';
import { readTreatyRequest, submitTreatyRequest } from './treatyRequests';

const identity = {
  worldId: 'world',
  userId: 'session-user',
  sessionId: 'session-hash',
  requestId: '10000000-0000-4000-8000-000000000001',
  at: new Date(1000),
};
type World = Prisma.WorldGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
type Treaty = Prisma.TreatyGetPayload<Record<string, never>>;
let active: Treaty;

beforeAll(async () => {
  const state = toWorldState(await readFixture());
  state.generals[1]!.nationId = 1;
  state.generals[1]!.officerLevel = 12;
  state.nations[2]!.isNpc = true;
  state.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  const result = applyTreatyInput(
    state,
    {
      kind: 'treaty.propose',
      generalId: 1,
      payload: { toNationId: 2, clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 3 }] },
    },
    { tick: 100, sequence: 10 },
  );
  if (!result.ok || result.result.outcome !== 'ACCEPTED') throw new Error('수락 fixture 실패');
  active = {
    ...result.state.treaties![0]!,
    worldId: 'world',
    clauses: JSON.parse(JSON.stringify(result.state.treaties![0]!.clauses)),
    costFrom: result.result.cost.from,
    costTo: result.result.cost.to,
    closedSequence: null,
  };
});

function fixture() {
  const world = {
    id: 'world',
    status: 'RUNNING',
    startYear: 191,
    clockTick: 200,
    monthlyTick: 0,
    actionSequence: 30,
    treatyFormat: null,
    policyFromSequence: null,
    personnelFormat: null,
    replayFormat: 3,
    ruleFeatures: ['treaty', 'treaty-break'],
    replayOrigin: null,
  } as World;
  const actor = { id: 1, userId: identity.userId, nationId: 1 as number | null, officerLevel: 12 };
  const trustEntries: Array<{ nationId: number; brokenTreaties: number; lastBrokenTick: number }> = [];
  const nations = [
    { id: 1, name: '국가1', color: '#ff0000', gold: 1000 },
    { id: 2, name: '국가2', color: '#0000ff', gold: 2000 },
  ];
  const removed: Array<{ nationId: number; name: string; color: string }> = [];
  const existing: Event[] = [],
    pending: Event[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    session: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: identity.sessionId })) },
    world: { findUnique: vi.fn(async () => world) },
    general: { findUnique: vi.fn(async () => actor) },
    nation: { findMany: vi.fn(async () => nations) },
    removedNation: { findMany: vi.fn(async () => removed) },
    nationTrust: { findMany: vi.fn(async () => trustEntries) },
    treaty: { findUnique: vi.fn(async (): Promise<Treaty | null> => structuredClone(active)) },
    inputEvent: {
      findMany: vi.fn(async (args: { where: { idempotencyKey?: unknown } }) =>
        args.where.idempotencyKey ? existing : pending,
      ),
      create: vi.fn(async () => ({})),
    },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const submit = (payload: unknown = { treatyId: '10' }) =>
    submitTreatyRequest(client, {
      ...identity,
      kind: 'treaty.break',
      payload,
    });
  const trust = () => listTrust(client, { worldId: 'world', userId: identity.userId });
  return { world, actor, tx, client, trustEntries, nations, removed, existing, pending, submit, trust };
}

function event(patch: Partial<Event> = {}): Event {
  return {
    id: 1n,
    worldId: 'world',
    userId: identity.userId,
    generalId: 1,
    kind: 'treaty.break',
    idempotencyKey: `treaty.break:${identity.requestId}`,
    payload: { treatyId: '10' },
    status: 'PENDING',
    sequence: null,
    result: null,
    createdAt: new Date(0),
    tick: null,
    stepTick: null,
    ...patch,
  };
}

describe('T2-07 / AC-M2-06 파기 접수 보조 단위', () => {
  it('세션 장수로 PENDING만 접수하고 kind 세 개의 nonce를 함께 찾는다', async () => {
    const f = fixture();
    expect(await f.submit()).toEqual({ created: true });
    expect(f.tx.inputEvent.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        worldId: 'world',
        userId: identity.userId,
        idempotencyKey: {
          in: [
            `treaty.propose:${identity.requestId}`,
            `treaty.respond:${identity.requestId}`,
            `treaty.break:${identity.requestId}`,
          ],
        },
      },
    });
    expect(f.tx.inputEvent.create).toHaveBeenCalledWith({
      data: {
        worldId: 'world',
        userId: identity.userId,
        generalId: 1,
        kind: 'treaty.break',
        idempotencyKey: `treaty.break:${identity.requestId}`,
        payload: { treatyId: '10' },
        status: 'PENDING',
        sequence: null,
      },
    });
  });

  it.each([1, 5, 10])('직책 %i는 조약 존재를 묻기 전에 거부한다', async (officerLevel) => {
    const f = fixture();
    f.actor.officerLevel = officerLevel;
    await expect(f.submit()).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(f.tx.treaty.findUnique).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });

  it('무효 세션은 월드와 조약 조회 전에 거부한다', async () => {
    const f = fixture();
    f.tx.session.findFirst.mockResolvedValue(null);
    await expect(f.submit()).rejects.toHaveProperty('code', 'UNAUTHORIZED');
    expect(f.tx.world.findUnique).not.toHaveBeenCalled();
    expect(f.tx.treaty.findUnique).not.toHaveBeenCalled();
  });

  it.each([12, '01', { treatyId: '10', nationId: 1 }])(
    '잘못된 payload는 입력으로 저장하지 않는다 (%j)',
    async (bad) => {
      const f = fixture();
      await expect(f.submit(typeof bad === 'object' ? bad : { treatyId: bad })).rejects.toHaveProperty(
        'code',
        'BAD_REQUEST',
      );
      expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
      expect(f.tx.treaty.findUnique).not.toHaveBeenCalled();
    },
  );

  it('종료·강등 뒤에도 정확한 같은 요청은 새 권한 조회 없이 돌려준다', async () => {
    const f = fixture();
    f.world.status = 'ENDED';
    f.actor.officerLevel = 1;
    f.existing.push(event());
    expect(await f.submit()).toEqual({ created: false });
    expect(f.tx.general.findUnique).not.toHaveBeenCalled();
    expect(f.tx.treaty.findUnique).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });

  it.each(['differentPayload', 'differentKind'])('같은 UUID의 다른 요청은 CONFLICT다 (%s)', async (change) => {
    const f = fixture();
    f.existing.push(
      event(
        change === 'differentPayload'
          ? { payload: { treatyId: '11' } }
          : {
              kind: 'treaty.respond',
              idempotencyKey: `treaty.respond:${identity.requestId}`,
              payload: { treatyId: '10', accept: true },
            },
      ),
    );
    await expect(f.submit()).rejects.toHaveProperty('code', 'CONFLICT');
    expect(f.tx.treaty.findUnique).not.toHaveBeenCalled();
  });

  it('다른 UUID라도 같은 장수의 같은 조약 PENDING이면 거부한다', async () => {
    const f = fixture();
    f.pending.push(event({ id: 2n, idempotencyKey: 'treaty.break:other' }));
    await expect(f.submit()).rejects.toHaveProperty('code', 'CONFLICT');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });

  it('없는 대상은 NOT_FOUND이고 API가 ACTIVE 여부를 대신 판정하지 않는다', async () => {
    const f = fixture();
    f.tx.treaty.findUnique.mockResolvedValue(null);
    await expect(f.submit()).rejects.toHaveProperty('code', 'NOT_FOUND');
    const g = fixture();
    g.tx.treaty.findUnique.mockResolvedValue({ ...active, status: 'BROKEN', closedSequence: 20 });
    expect(await g.submit()).toEqual({ created: true });
  });

  it('파기 기능을 끈 월드에서는 접수하지 않는다', async () => {
    const f = fixture();
    f.world.ruleFeatures = ['treaty'];
    await expect(f.submit()).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
    expect(f.tx.treaty.findUnique).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });

  it('소속을 바꿔도 자기 완료 결과는 찾되 현재 비당사국에는 상세를 주지 않는다', async () => {
    const f = fixture();
    f.actor.nationId = 3;
    f.existing.push(
      event({
        status: 'APPLIED',
        sequence: 20,
        result: { outcome: 'BROKEN', tick: 200, treatyId: '10', brokenByNationId: 1 },
      }),
    );
    f.tx.treaty.findUnique.mockResolvedValue({ ...active, status: 'BROKEN', closedSequence: 20 });
    expect(await readTreatyRequest(f.client, identity)).toMatchObject({
      status: 'applied',
      outcome: 'BROKEN',
      treatyId: '10',
      treaty: null,
    });
  });
});

describe('T2-07 / AC-M2-06 공개 신의 표 보조 단위', () => {
  it.each([1, 3, null])('소속 %s인 장수도 같은 공개 표를 읽는다', async (nationId) => {
    const f = fixture();
    f.actor.nationId = nationId;
    expect(await f.trust()).toEqual({
      items: f.nations.map(({ id, name, color }) => ({
        nation: { id, name, color },
        brokenTreaties: 0,
        lastBrokenAt: null,
      })),
    });
    expect(f.tx.nation.findMany).toHaveBeenCalledOnce();
    expect(f.tx.removedNation.findMany).toHaveBeenCalledOnce();
    expect(f.tx.nationTrust.findMany).toHaveBeenCalledOnce();
  });

  it('과거 국가 이름을 보존하고 횟수·국가 번호로 정렬하며 비공개 칸은 빼고 준다', async () => {
    const f = fixture();
    f.trustEntries.push(
      { nationId: 1, brokenTreaties: 2, lastBrokenTick: 100 },
      { nationId: 3, brokenTreaties: 2, lastBrokenTick: 200 },
    );
    f.removed.push(
      { nationId: 3, name: '사라진 국가', color: '#00ff00' },
      { nationId: 4, name: '기록 없는 국가', color: '#ffffff' },
    );
    const result = await f.trust();
    expect(result.items.map((row) => row.nation.id)).toEqual([1, 3, 2]);
    expect(result.items[1]!.nation.name).toBe('사라진 국가');
    for (const row of result.items) {
      expect(Object.keys(row).sort()).toEqual(['brokenTreaties', 'lastBrokenAt', 'nation']);
      expect(Object.keys(row.nation).sort()).toEqual(['color', 'id', 'name']);
    }
    expect(result.items[0]!.lastBrokenAt).toEqual({ year: 191, month: 1 });
  });

  it('현재와 과거 어디에도 없는 신의 국가를 누락시키지 않고 내부 오류로 낸다', async () => {
    const f = fixture();
    f.trustEntries.push({ nationId: 99, brokenTreaties: 1, lastBrokenTick: 100 });
    await expect(f.trust()).rejects.toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
  });

  it('파손된 0회 신의와 기능 없는 월드를 거부한다', async () => {
    const f = fixture();
    f.trustEntries.push({ nationId: 1, brokenTreaties: 0, lastBrokenTick: 100 });
    await expect(f.trust()).rejects.toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
    const g = fixture();
    g.world.ruleFeatures = ['treaty'];
    await expect(g.trust()).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
    expect(g.tx.nationTrust.findMany).not.toHaveBeenCalled();
  });
});
