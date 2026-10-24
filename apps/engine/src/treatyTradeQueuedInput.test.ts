import type { Prisma } from '@opensamguk/db';
import { applyTreatyInput, toWorldState } from '@opensamguk/rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { loadReplayState } from './monthly';
import { processTreatyQueuedInput } from './treatyInput';
vi.mock('./monthly', () => ({ loadReplayState: vi.fn() }));

async function fixture(respond = false) {
  let state = toWorldState(await monthlyFixture());
  state.generals[1]!.nationId = 1;
  state.generals[1]!.officerLevel = 12;
  state.generals[1]!.userId = 'actor';
  state.generals[2] = { ...state.generals[1]!, id: 2, nationId: 2 };
  state.nations[2]!.isNpc = false;
  state.nations[1]!.gold = state.nations[2]!.gold = 100000;
  state.diplomacies = [];
  const payload = { toNationId: 2, clauses: [{ kind: 'trade' as const, months: 12 }] };
  if (respond) {
    const proposed = applyTreatyInput(
      state,
      { kind: 'treaty.propose', generalId: 1, payload },
      { tick: 100, sequence: 10, tradeEnabled: true },
    );
    if (!proposed.ok) throw Error('제안 fixture 실패');
    state = proposed.state;
  }
  const world = { id: 'world', status: 'RUNNING', monthlyTick: 0, actionSequence: 19 } as Prisma.WorldGetPayload<
    Record<string, never>
  >;
  const event = {
    id: 1n,
    worldId: 'world',
    kind: respond ? 'treaty.respond' : 'treaty.propose',
    userId: 'actor',
    generalId: respond ? 2 : 1,
    payload: respond ? { treatyId: '10', accept: true } : payload,
    idempotencyKey: respond ? 'treaty.respond:request' : 'treaty.propose:request',
    status: 'PENDING',
    sequence: null,
    result: null,
  } as unknown as Prisma.InputEventGetPayload<Record<string, never>>;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    world: { update: vi.fn() },
    inputEvent: { updateMany: vi.fn() },
    user: { findUnique: vi.fn(async () => ({ status: 'ACTIVE' })) },
    general: { findUnique: vi.fn(async () => ({ userId: 'actor' })) },
    treaty: { create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    nation: { updateMany: vi.fn(async () => ({ count: 1 })) },
    diplomacy: { deleteMany: vi.fn(), create: vi.fn() },
  };
  vi.mocked(loadReplayState).mockResolvedValue({ state, turns: {}, revisions: {}, monthlyTick: 0 });
  const process = (enabled = true) =>
    processTreatyQueuedInput(tx as unknown as Prisma.TransactionClient, world, event, {
      tick: 200,
      sequence: 20,
      treatyTradeEnabled: enabled,
    });
  return { state, world, event, tx, process };
}
beforeEach(() => vi.clearAllMocks());
describe('T2-07 / AC-M2-14 교역 조항 handler 단위 경계', () => {
  it('선택된 교역 제안만 저장하고 중앙 입력·순서를 쓰지 않는다', async () => {
    const f = await fixture();
    expect(await f.process()).toMatchObject({ status: 'APPLIED', result: { outcome: 'PROPOSED', treatyId: '20' } });
    expect(f.tx.treaty.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 20,
        clauses: [{ kind: 'trade', months: 12 }],
        status: 'PROPOSED',
        costFrom: null,
        costTo: null,
      }),
    });
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
    expect(f.tx.world.update).not.toHaveBeenCalled();
  });
  it('교역 수락은 양국 납부와 조약 끝만 저장하고 불가침을 만들지 않는다', async () => {
    const f = await fixture(true);
    expect(await f.process()).toMatchObject({
      status: 'APPLIED',
      result: { outcome: 'ACCEPTED', treatyId: '10', endTick: 120200 },
    });
    expect(f.tx.nation.updateMany).toHaveBeenCalledTimes(2);
    expect(f.tx.treaty.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE', startTick: 200, endTick: 120200 }) }),
    );
    expect(f.tx.diplomacy.create).not.toHaveBeenCalled();
    expect(f.tx.diplomacy.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.updateMany).not.toHaveBeenCalled();
  });
  it('선택이 없으면 미연결 조항으로 거절하고 조약을 쓰지 않는다', async () => {
    const f = await fixture();
    expect(await f.process(false)).toMatchObject({ status: 'REJECTED', result: { code: 'CLAUSE_NOT_CONNECTED' } });
    expect(f.tx.treaty.create).not.toHaveBeenCalled();
  });
});
