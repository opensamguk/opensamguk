import type { Prisma } from '@opensamguk/db';
import { applyTreatyInput, toWorldState } from '@opensamguk/rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { loadReplayState } from './monthly';
import { processTreatyQueuedInput, treatyBreakMessageId } from './treatyInput';

vi.mock('./monthly', () => ({ loadReplayState: vi.fn() }));
vi.mock('./lease', () => ({ databaseNow: vi.fn(async () => new Date('2026-10-24T00:00:00Z')) }));

async function fixture() {
  const state = toWorldState(await monthlyFixture());
  state.nations[1]!.name = '국가1';
  state.nations[2]!.name = '국가2';
  state.nations[2]!.color = '#0000ff';
  state.nations[2]!.isNpc = true;
  state.generals[1]!.nationId = 1;
  state.generals[1]!.officerLevel = 12;
  state.generals[1]!.userId = 'actor';
  state.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  const accepted = applyTreatyInput(
    state,
    {
      kind: 'treaty.propose',
      generalId: 1,
      payload: { toNationId: 2, clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 3 }] },
    },
    { tick: 100, sequence: 10 },
  );
  if (!accepted.ok || accepted.result.outcome !== 'ACCEPTED') throw new Error('수락한 조약을 만들지 못했습니다.');
  const world = {
    id: 'world',
    status: 'RUNNING',
    startYear: 191,
    monthlyTick: 0,
    actionSequence: 19,
    treatyFormat: null,
  } as Prisma.WorldGetPayload<Record<string, never>>;
  const event = {
    id: 1n,
    worldId: world.id,
    kind: 'treaty.break',
    userId: 'actor',
    generalId: 1,
    payload: { treatyId: '10' },
    idempotencyKey: 'treaty.break:request',
    status: 'PENDING',
    createdAt: new Date('2026-10-24T00:00:00Z'),
    stepTick: null,
    tick: null,
    sequence: null,
    result: null,
  } as Prisma.InputEventGetPayload<Record<string, never>>;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    world: { update: vi.fn() },
    inputEvent: { updateMany: vi.fn() },
    user: { findUnique: vi.fn(async () => ({ status: 'ACTIVE' })) },
    general: { findUnique: vi.fn(async () => ({ userId: 'actor' })) },
    treaty: {
      findUniqueOrThrow: vi.fn(async () => ({
        ...accepted.state.treaties![0]!,
        worldId: world.id,
        costFrom: accepted.result.outcome === 'ACCEPTED' ? accepted.result.cost.from : 0,
        costTo: accepted.result.outcome === 'ACCEPTED' ? accepted.result.cost.to : 0,
        closedSequence: null,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    diplomacy: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    nationTrust: {
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: { createMany: vi.fn(async () => ({ count: 1 })) },
  };
  vi.mocked(loadReplayState).mockResolvedValue({ state: accepted.state, turns: {}, revisions: {}, monthlyTick: 0 });
  const process = (context = { tick: 200, sequence: 20, treatyBreakEnabled: true }) =>
    processTreatyQueuedInput(tx as unknown as Prisma.TransactionClient, world, event, context);
  return { state: accepted.state, world, event, tx, process };
}

beforeEach(() => vi.clearAllMocks());

describe('T2-07 / AC-M2-06 형식3 조약 handler 단위 경계', () => {
  it('중앙이 준 순서로 업무만 저장하고 InputEvent와 순서를 다시 쓰지 않는다', async () => {
    const f = await fixture();
    const emit = vi.fn();
    const result = await processTreatyQueuedInput(f.tx as unknown as Prisma.TransactionClient, f.world, f.event, {
      tick: 200,
      sequence: 20,
      treatyBreakEnabled: true,
      emit,
    });
    expect(result).toEqual({
      status: 'APPLIED',
      generalId: 1,
      result: { outcome: 'BROKEN', tick: 200, treatyId: '10', brokenByNationId: 1 },
    });
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
    expect(f.tx.world.update).not.toHaveBeenCalled();
    expect(f.event.status).toBe('PENDING');
    expect(f.tx.treaty.updateMany).toHaveBeenCalledWith({
      where: { worldId: 'world', id: 10, status: 'ACTIVE', closedSequence: null },
      data: { status: 'BROKEN', closedSequence: 20 },
    });
    expect(f.tx.nationTrust.create).toHaveBeenCalledWith({
      data: { worldId: 'world', nationId: 1, brokenTreaties: 1, lastBrokenTick: 200 },
    });
    expect(f.tx.message.createMany).toHaveBeenCalledOnce();
    const data = (f.tx.message.createMany.mock.calls[0] as unknown as [{ data: unknown[] }])[0].data;
    expect(data).toEqual([
      {
        id: treatyBreakMessageId('world', 20, 2),
        worldId: 'world',
        scope: 'NATION',
        senderId: null,
        senderNationId: null,
        recipientId: null,
        recipientNationId: 2,
        fromParty: { generalId: null, name: '조약 기록', nation: null },
        toParty: { generalId: null, name: '국가2', nation: { id: 2, name: '국가2', color: '#0000ff' } },
        body: '국가1 국가가 조약을 파기했습니다. 지금까지 파기 1회입니다.',
        sentAt: new Date('2026-10-24T00:00:00Z'),
        year: 191,
        month: 1,
      },
    ]);
    expect(emit.mock.calls.map(([signal]) => signal)).toEqual([
      { kind: 'message.new', scope: 'NATION', target: { nationId: 2 } },
      { kind: 'treaty.new', target: { nationIds: [1, 2] } },
    ]);
  });

  it('중앙 파기 선택이 없는 handler 호출은 업무를 쓰기 전에 거부한다', async () => {
    const f = await fixture();
    await expect(f.process({ tick: 200, sequence: 20, treatyBreakEnabled: false })).rejects.toThrow();
    expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
  });

  it('제재된 계정은 거절 결과만 돌려주고 업무와 입력을 쓰지 않는다', async () => {
    const f = await fixture();
    f.tx.user.findUnique.mockResolvedValue({ status: 'SANCTIONED' });
    expect(await f.process()).toMatchObject({ status: 'REJECTED', result: { code: 'ACTOR_INACTIVE' } });
    expect(f.tx.treaty.updateMany).not.toHaveBeenCalled();
    expect(f.tx.nationTrust.create).not.toHaveBeenCalled();
    expect(f.tx.message.createMany).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
  });

  it('신의 조건 갱신 실패는 throw하고 신호를 내지 않는다', async () => {
    const f = await fixture();
    f.state.nationTrust = [{ nationId: 1, brokenTreaties: 2, lastBrokenTick: 150 }];
    f.tx.nationTrust.updateMany.mockResolvedValue({ count: 0 });
    const emit = vi.fn();
    await expect(
      processTreatyQueuedInput(f.tx as unknown as Prisma.TransactionClient, f.world, f.event, {
        tick: 200,
        sequence: 20,
        treatyBreakEnabled: true,
        emit,
      }),
    ).rejects.toThrow('신의 기록이 변경');
    expect(emit).not.toHaveBeenCalled();
    expect(f.tx.message.createMany).not.toHaveBeenCalled();
  });

  it('메시지 저장 실패를 숨기지 않고 입력 완료와 신호 전송을 남기지 않는다', async () => {
    const f = await fixture();
    f.tx.message.createMany.mockRejectedValue(new Error('message storage failure'));
    const emit = vi.fn();
    await expect(
      processTreatyQueuedInput(f.tx as unknown as Prisma.TransactionClient, f.world, f.event, {
        tick: 200,
        sequence: 20,
        treatyBreakEnabled: true,
        emit,
      }),
    ).rejects.toThrow('message storage failure');
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('알림 ID는 같은 입력에서 같고 수신 국가마다 다른 UUID8이다', () => {
    const id = treatyBreakMessageId('world', 20, 2);
    expect(treatyBreakMessageId('world', 20, 2)).toBe(id);
    expect(treatyBreakMessageId('world', 20, 3)).not.toBe(id);
    expect(treatyBreakMessageId('world', 21, 2)).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
