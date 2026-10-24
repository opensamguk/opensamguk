import { describe, expect, it, vi } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld } from '../../test/commandFixture';
import { applyEffects } from './effects';
import { findTradeRoutes, trade } from './trade';

function fixture() {
  const state = commandWorld();
  state.diplomacies = [];
  state.treaties = [
    {
      id: 10,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'trade', months: 2 }],
      status: 'ACTIVE',
      proposedTick: 100,
      respondByTick: 60100,
      startTick: 15000,
      endTick: 35000,
    },
  ];
  return state;
}
const actor = { generalId: 1, tick: 20000 };
const args = { cityKey: 2 };
describe('T2-07 / AC-M2-14 교역', () => {
  it('국고 수익과 내 도시 성장, 장수 보상만 바꾸고 seeded RNG 한 번을 공유한다', () => {
    const before = fixture();
    before.cities[1]!.commerce = 701;
    before.cities[2]!.commerce = 1000;
    const original = structuredClone(before);
    const rng = rngFor('trade');
    const expected = ((701 + 1000) / 2) * 0.05 * (0.9 + 0.2 * rngFor('trade').next());
    const draw = vi.spyOn(rng, 'next');
    const result = trade.execute(before, actor, args, rng);
    expect(draw).toHaveBeenCalledTimes(1);
    const after = applyEffects(before, result.effects);
    expect(after.nations[1]!.gold).toBe(before.nations[1]!.gold + Math.round(expected));
    expect(after.nations[1]!.rice).toBe(before.nations[1]!.rice + Math.round(expected));
    expect(after.nations[2]).toEqual(before.nations[2]);
    expect(after.cities[1]!.commerce).toBe(708);
    expect(after.cities[1]!.agriculture).toBe(101);
    expect(after.cities[2]).toEqual(before.cities[2]);
    expect(after.generals[1]).toEqual({
      ...before.generals[1],
      experience: before.generals[1]!.experience + 10,
      dedication: before.generals[1]!.dedication + 15,
    });
    expect(before).toEqual(original);
  });
  it.each([0, 49])('현재값 %i에 최소 성장이나 최소 수익을 더하지 않는다', (value) => {
    const state = fixture();
    state.cities[1]!.commerce = state.cities[2]!.commerce = value;
    state.cities[1]!.agriculture = value;
    const after = applyEffects(state, trade.execute(state, actor, args, rngFor('zero')).effects);
    expect(after.cities[1]!.commerce).toBe(value);
    expect(after.cities[1]!.agriculture).toBe(value);
    if (value === 0) expect(after.nations[1]).toEqual(state.nations[1]);
  });
  it('최대치에 맞추며 두 내정치가 모두 최대여도 보상한다', () => {
    const state = fixture();
    state.cities[1]!.commerce = 999;
    state.cities[1]!.agriculture = state.cities[1]!.agricultureMax;
    let after = applyEffects(state, trade.execute(state, actor, args, rngFor('max')).effects);
    expect(after.cities[1]!.commerce).toBe(1000);
    expect(trade.check(after, actor, args)).toBeNull();
    after = applyEffects(after, trade.execute(after, actor, args, rngFor('max')).effects);
    expect(after.generals[1]!.experience).toBe(state.generals[1]!.experience + 20);
  });
  it.each([34999, 35000, 39999])('조항 끝을 다음 월간까지 판독한다 tick=%i', (tick) => {
    expect(trade.check(fixture(), { ...actor, tick }, args)).toBeNull();
  });
  it.each([40000, 50000])('조항을 닫은 월간 뒤에는 실패한다 tick=%i', (tick) => {
    expect(trade.check(fixture(), { ...actor, tick }, args)?.code).toBe('BAD_STATE');
  });
  it.each(['missing', 'proposed', 'noClause', 'war'] as const)('%s 상태는 실패하고 RNG를 쓰지 않는다', (mode) => {
    const state = fixture();
    if (mode === 'missing') delete state.treaties;
    if (mode === 'proposed') state.treaties![0]!.status = 'PROPOSED';
    if (mode === 'noClause') state.treaties![0]!.clauses = [{ kind: 'note', text: '약속' }];
    if (mode === 'war') state.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
    const rng = rngFor('failure'),
      draw = vi.spyOn(rng, 'next');
    expect(trade.check(state, actor, args)?.code).toBe('BAD_STATE');
    expect(() => trade.execute(state, actor, args, rng)).toThrow();
    expect(draw).not.toHaveBeenCalled();
  });
  it('연결·국가·자기 도시와 실행 시각을 검사한다', () => {
    const state = fixture();
    expect(trade.check(state, actor, { cityKey: 4 })?.code).toBe('BAD_TARGET');
    state.cities[1]!.connections = [];
    expect(trade.check(state, actor, args)?.code).toBe('NOT_ADJACENT');
    state.cities[1]!.nationId = 2;
    expect(trade.check(state, actor, args)?.code).toBe('NOT_OWN_CITY');
    state.generals[1]!.nationId = null;
    expect(trade.check(state, actor, args)?.code).toBe('NOT_NATION');
    expect(trade.check(fixture(), { generalId: 1 }, args)?.code).toBe('BAD_STATE');
    expect(trade.check(fixture(), { generalId: 999, tick: 20000 }, args)?.code).toBe('NO_ACTOR');
  });
  it('상대 국가 소멸과 조항 만료를 실행 때 다시 검사한다', () => {
    const state = fixture();
    expect(findTradeRoutes(state, 1, 1, 20000)).toEqual([{ cityKey: 2, treatyId: '10', endTick: 35000 }]);
    delete state.nations[2];
    expect(trade.check(state, actor, args)?.code).toBe('BAD_STATE');
  });
  it('같은 상대의 여러 유효 조약은 ID가 작은 것을 고른다', () => {
    const state = fixture();
    state.treaties!.unshift({ ...state.treaties![0]!, id: 20 });
    expect(findTradeRoutes(state, 1, 1, 20000)[0]!.treatyId).toBe('10');
  });
  it('잘못된 입력과 예상 밖 필드를 받지 않는다', () => {
    for (const value of [{ cityKey: 0 }, { cityKey: '2' }, { cityKey: 2, nationId: 1 }, {}])
      expect(trade.args.safeParse(value).success).toBe(false);
  });
});
