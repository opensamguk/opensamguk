import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import {
  applyTreatyInput,
  quoteTreatyProposal,
  settleMonthlyTreaties,
  treatyOptions,
  validateTreatyState,
} from './treaty';
import { hasTreatyPassage } from './treatyClauses';
import type { TreatyClause } from './treatyTypes';
import type { WorldState } from '../model/world';

function world() {
  const state = commandWorld();
  state.ruleFeatures = ['treaty', 'treaty-break', 'treaty-expanded', 'treaty-trade'];
  state.nations[2]!.isNpc = false;
  state.diplomacies = [];
  return state;
}

function propose(state: WorldState, clauses: TreatyClause[]) {
  return applyTreatyInput(
    state,
    { kind: 'treaty.propose', generalId: 1, payload: { toNationId: 2, clauses } },
    {
      tick: 10000,
      sequence: 10,
    },
  );
}

function accept(state: WorldState, generalId = 2) {
  return applyTreatyInput(
    state,
    { kind: 'treaty.respond', generalId, payload: { treatyId: '10', accept: true } },
    {
      tick: 12000,
      sequence: 11,
    },
  );
}

function accepted(state: WorldState, clauses: TreatyClause[]) {
  const proposal = propose(state, clauses);
  if (!proposal.ok) throw new Error(proposal.result.message);
  const result = accept(proposal.state);
  if (!result.ok) throw new Error(result.result.message);
  return result;
}

describe('AC-M2-06 확장 조약', () => {
  it('원조 수락 뒤 지급국은 12개월 대기하며 당사국에 남은 대기를 검사한다', () => {
    const state = world();
    state.ruleFeatures!.push('ranked-aid-v1', 'diplomatic-cooldown-v1');
    state.nations[2]!.level = 1;
    const clause: TreatyClause = { kind: 'tribute', payerNationId: 2, gold: 900, rice: 10, months: 2 };
    const applied = accepted(state, [clause]);
    expect(applied.state.nations[2]!.diplomaticAidUntilMonth).toBe(13);
    expect(applied.state.nations[1]!.diplomaticAidUntilMonth).toBeUndefined();
    const retry = (tick: number) =>
      applyTreatyInput(
        applied.state,
        { kind: 'treaty.propose', generalId: 1, payload: { toNationId: 2, clauses: [clause] } },
        { tick, sequence: 12 },
      );
    expect(retry(129999)).toMatchObject({ ok: false, result: { code: 'DIPLOMATIC_COOLDOWN' } });
    expect(retry(130000)).toMatchObject({ ok: true });
  });
  it('INT-26 정기 원조는 새 월드의 지급국 작위 한도를 따른다', () => {
    const state = world();
    state.nations[2]!.level = 3;
    const clause: TreatyClause = { kind: 'tribute', payerNationId: 2, gold: 30_000, rice: 1, months: 2 };
    expect(propose(state, [clause])).toMatchObject({ ok: false, result: { code: 'BAD_INPUT' } });
    state.ruleFeatures!.push('ranked-aid-v1');
    expect(propose(state, [clause])).toMatchObject({ ok: true });
    const tooMuch = { ...clause, gold: 30_001 };
    expect(propose(state, [tooMuch])).toMatchObject({ ok: false, result: { code: 'BAD_INPUT' } });
    expect(
      quoteTreatyProposal(
        {
          fromNationId: 1,
          toNationId: 2,
          fromCityCount: 2,
          target: { cityCount: 1, relation: 'NONE' },
          clauses: [tooMuch],
          tributeLimits: new Map([[2, 30_000]]),
        },
        treatyOptions(state.ruleFeatures!),
      ),
    ).toMatchObject({ problem: { code: 'BAD_INPUT' } });
  });
  it('가장 긴 기간으로 납부하고 통행은 지정 도시와 자기 종료 시각까지만 허용한다', () => {
    const result = accepted(world(), [
      { kind: 'passage', cityKeys: [2], months: 1 },
      { kind: 'tribute', payerNationId: 1, gold: 900, rice: 10, months: 2 },
      { kind: 'trade', months: 3 },
    ]);
    expect(result.result).toMatchObject({ cost: { from: 50, to: 25 }, endTick: 42000 });
    expect(() => validateTreatyState(result.state.treaties![0], { tradeEnabled: true })).toThrow();
    expect(hasTreatyPassage(result.state, 1, 2, 21999)).toBe(true);
    expect(hasTreatyPassage(result.state, 1, 2, 22000)).toBe(false);
    expect(hasTreatyPassage(result.state, 2, 4, 20000)).toBe(false);
    result.state.generals[1]!.cityKey = 2;
    result.state.nations[1]!.gold = 800;
    const first = settleMonthlyTreaties(result.state, 20000).state;
    expect(first.nations[1]).toMatchObject({ gold: 800, rice: 99990 });
    expect(first.nations[2]).toMatchObject({ gold: 99975, rice: 100010 });
    expect(first.generals[1]!.cityKey).toBe(2);
    const second = settleMonthlyTreaties(first, 30000).state;
    expect(second.generals[1]!.cityKey).toBe(1);
    expect(second.generals[3]!.cityKey).toBe(2);
    expect(second.nations[2]!.rice).toBe(100020);
    const third = settleMonthlyTreaties(second, 40000).state;
    expect(third.nations[2]!.rice).toBe(100020);
    expect(third.treaties).toHaveLength(1);
    expect(settleMonthlyTreaties(third, 50000).state.treaties).toBeUndefined();
  });

  it('파기가 남은 통행을 종료하되 이양으로 옮긴 도시와 다른 조약을 보존한다', () => {
    const state = world();
    state.generals[1]!.cityKey = 2;
    state.generals[3]!.cityKey = 4;
    state.generals[4]!.cityKey = 4;
    const result = accepted(state, [
      { kind: 'passage', cityKeys: [2], months: 4 },
      { kind: 'cityTransfer', cityKey: 4, giverNationId: 1 },
    ]);
    expect(result.state.cities[4]!.nationId).toBe(2);
    expect(result.state.generals[3]!.cityKey).toBe(4);
    expect(result.state.generals[4]!.cityKey).toBe(4);
    const broken = applyTreatyInput(
      result.state,
      { kind: 'treaty.break', generalId: 1, payload: { treatyId: '10' } },
      {
        tick: 15000,
        sequence: 12,
      },
    );
    if (!broken.ok) throw new Error(broken.result.message);
    expect(broken.state.generals[1]!.cityKey).toBe(1);
    expect(broken.state.cities[4]!.nationId).toBe(2);
  });

  it('이양을 수락할 때 도시 소유와 권한을 다시 확인하고 원 소유국의 장수만 수도로 이동한다', () => {
    const state = world();
    state.generals[1]!.cityKey = 4;
    state.generals[3]!.cityKey = 4;
    const clause: TreatyClause = { kind: 'cityTransfer', cityKey: 4, giverNationId: 1 };
    expect(propose(state, [{ ...clause, cityKey: 1 }])).toMatchObject({ ok: false, result: { code: 'BAD_TARGET' } });
    const proposed = propose(state, [clause]);
    if (!proposed.ok) throw new Error(proposed.result.message);
    expect(accept(proposed.state, 3)).toMatchObject({ ok: false, result: { code: 'NO_PERMISSION' } });
    const changed = structuredClone(proposed.state);
    changed.cities[4]!.nationId = 2;
    expect(accept(changed)).toMatchObject({ ok: false, result: { code: 'BAD_TARGET' } });
    const result = accept(proposed.state);
    if (!result.ok) throw new Error(result.result.message);
    expect(result.state.generals[1]!.cityKey).toBe(1);
    expect(result.state.generals[3]!.cityKey).toBe(4);
    expect(result.state.cities[4]!.nationId).toBe(2);
  });

  it('기존 판의 미연결 조항을 유지하고 새 판에서 범위를 엄격히 검사한다', () => {
    const legacy = world();
    legacy.ruleFeatures = ['treaty', 'treaty-trade'];
    expect(propose(legacy, [{ kind: 'passage', cityKeys: [2], months: 1 }])).toMatchObject({
      ok: false,
      result: { code: 'CLAUSE_NOT_CONNECTED' },
    });
    expect(propose(world(), [{ kind: 'passage', cityKeys: [3], months: 1 }])).toMatchObject({
      ok: false,
      result: { code: 'BAD_TARGET' },
    });
    expect(propose(world(), [{ kind: 'tribute', payerNationId: 1, gold: 10001, rice: 0, months: 1 }])).toMatchObject({
      ok: false,
      result: { code: 'BAD_INPUT' },
    });
  });
});
