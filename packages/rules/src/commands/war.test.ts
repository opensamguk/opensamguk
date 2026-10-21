import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from './effects';
import { commands, runCommand } from './registry';
import { runGeneralTurn } from './turn';
import { runMonthly, settleSupply } from '../monthly/index';
import type { WorldState } from '../model/world';
import { commandCases } from './contracts';

const execute = (
  state: WorldState,
  id: number,
  key: string,
  args: unknown,
  target: 'general' | 'nation' = 'general',
) => {
  const result = runCommand(
    state,
    { generalId: id, target, tick: 100, unitSet: testUnits },
    key,
    args,
    rngFor('war', 100, id),
  );
  if ('code' in result) throw new Error(`${result.code}: ${result.message}`);
  return { result, state: applyEffects(state, result.effects) };
};
describe('AC-M1-15 전투 시나리오', () => {
  it('수비2명·성벽 순서, 마지막 도시 멸망·재야·국가 예턴 삭제와 같은 시드 결과', () => {
    const initial = commandWorld();
    initial.nationTurns = { 2: Array.from({ length: 30 }, () => ({ commandKey: 'nation_rest', args: {} })) };
    const a = execute(initial, 1, 'attack', { cityKey: 2 });
    expect(a).toEqual(execute(initial, 1, 'attack', { cityKey: 2 }));
    expect(a.result.reports?.map((r) => r.generalId)).toEqual([2, 3]);
    const text = a.result.logs[0]!.text;
    expect(text.indexOf('장수2')).toBeLessThan(text.indexOf('장수3'));
    expect(text.indexOf('장수3')).toBeLessThan(text.indexOf('성벽'));
    expect(a.state.nations[2]).toBeUndefined();
    expect(a.state.nationTurns).toBeUndefined();
    expect(a.state.diplomacies).toEqual([]);
    expect(a.result.history?.some((h) => h.text.includes('멸망'))).toBe(true);
    expect(initial.nations[2]).toBeDefined();
  });
  it('동률 수비는 ID 순, 수비 실패·페이즈 제한은 성벽과 도시 소유권을 보존한다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 100;
    state.generals[2]!.crew = 10000;
    state.generals[3]!.crew = 10000;
    const next = execute(state, 1, 'attack', { cityKey: 2 });
    expect(next.result.reports?.map((r) => r.generalId)).toEqual([2]);
    expect(next.state.cities[2]).toEqual(state.cities[2]);
    expect(next.state.generals[1]!.cityKey).toBe(1);
    expect(next.result.logs[0]!.text).toContain('점령 실패');
  });
  it('훈련·사기 미달과 미등장 수비를 제외하고 군량0이면 사기가 급감한다', () => {
    const state = commandWorld();
    state.generals[2]!.train = 0;
    state.generals[3]!.activeFromYear = 200;
    state.generals[1]!.rice = 0;
    state.generals[1]!.atmos = 20;
    const next = execute(state, 1, 'attack', { cityKey: 2 });
    expect(next.result.reports).toEqual([]);
    expect(next.state.generals[1]!.atmos).toBe(0);
    expect(next.state.cities[2]!.nationId).toBe(2);
  });
  it('병종 상성·기술은 같은 시드에서도 피해를 바꾼다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 2000;
    state.generals[2]!.crew = 2000;
    state.generals[3]!.train = 0;
    const base = execute(state, 1, 'attack', { cityKey: 2 });
    state.generals[1]!.crewType = 1300;
    state.nations[1]!.tech = 12000;
    const stronger = execute(state, 1, 'attack', { cityKey: 2 });
    expect(stronger.state.generals[2]!.crew).toBeLessThan(base.state.generals[2]!.crew);
  });
});
describe('AC-M1-16 점령과 보급', () => {
  it('회랑 점령 직후 단절 표시, 월간 손해, 재점령 직후 회복과 다음 달 손해 중단', () => {
    const state = commandWorld();
    for (const id of [1, 2, 3]) state.cities[id]!.nationId = 1;
    state.cities[4]!.nationId = 2;
    state.cities[2]!.connections.push(4);
    state.cities[4]!.connections.push(2);
    state.nations[2]!.capitalCityKey = 4;
    state.generals[2]!.cityKey = 4;
    state.generals[2]!.crew = 10000;
    state.generals[3]!.nationId = 1;
    state.generals[3]!.cityKey = 3;
    const supplied = settleSupply(state);
    expect(supplied.cities[3]!.supplied).toBe(true);
    const cut = execute(supplied, 2, 'attack', { cityKey: 2 }).state;
    expect(cut.cities[3]!.supplied).toBe(false);
    expect(cut.cities[3]!.agriculture).toBe(100);
    const damaged = runMonthly(cut, 10000, rngFor('month')).state;
    expect(damaged.cities[3]!.agriculture).toBe(90);
    expect(damaged.generals[3]!.train).toBe(90);
    const withdrawn = execute(damaged, 2, 'move', { cityKey: 4 }).state;
    const restored = execute(withdrawn, 1, 'attack', { cityKey: 2 }).state;
    expect(restored.cities[3]!.supplied).toBe(true);
    const nextMonth = runMonthly(restored, 20000, rngFor('month2')).state;
    expect(nextMonth.cities[3]!.agriculture).toBe(90);
    expect(nextMonth.generals[3]!.train).toBe(90);
  });
});
describe('명령 경계와 국가 예턴', () => {
  it('37종 잘못된 인자를 거부하고 국가 명령은 군주·대상을 따로 검사한다', () => {
    const state = commandWorld();
    for (const c of commands)
      expect(runCommand(state, { generalId: 1, target: c.target }, c.key, null, rngFor('bad'))).toMatchObject({
        code: 'BAD_ARGS',
      });
    for (const c of commands.filter((c) => c.target === 'nation')) {
      expect(runCommand(state, { generalId: 1 }, c.key, {}, rngFor('bad'))).toMatchObject({ code: 'BAD_ARGS' });
      expect(
        runCommand(state, { generalId: 3, target: 'nation' }, c.key, commandCases[c.key]!.args, rngFor('bad')),
      ).toMatchObject({ code: 'NOT_RULER' });
    }
  });
  it('국가 포상 후 장수 명령을 재검사하고 예턴은 한 칸만 당긴다', () => {
    const state = commandWorld();
    state.generals[1]!.gold = 0;
    state.nationTurns = {
      1: Array.from({ length: 30 }, (_, i) =>
        i === 0
          ? { commandKey: 'nation_reward', args: { generalId: 1, resource: 'gold', amount: 100 } }
          : { commandKey: 'nation_rest', args: {} },
      ),
    };
    const result = runGeneralTurn(
      state,
      { generalId: 1, tick: 100, unitSet: testUnits },
      { commandKey: 'farm', args: {} },
      'same',
    );
    expect(result.result).not.toHaveProperty('code');
    expect(result.state.generals[1]!.gold).toBe(0);
    expect(result.state.cities[1]!.agriculture).toBeGreaterThan(100);
    expect(result.state.nationTurns?.[1]).toHaveLength(30);
    expect(result.state.nationTurns?.[1]?.[0]?.commandKey).toBe('nation_rest');
  });
  it('국가 실패도 소비하고 비군주 턴은 국가 예턴을 소비하지 않는다', () => {
    const state = commandWorld();
    state.nationTurns = { 1: [{ commandKey: 'nation_reward', args: { generalId: 4, resource: 'gold', amount: 100 } }] };
    const failed = runGeneralTurn(state, { generalId: 1, tick: 100 }, { commandKey: 'rest', args: {} }, 'same');
    expect(failed.nation?.result).toMatchObject({ code: 'BAD_TARGET' });
    expect(failed.state.nationTurns?.[1]?.[0]?.commandKey).toBe('nation_rest');
    state.generals[1]!.officerLevel = 1;
    expect(
      runGeneralTurn(state, { generalId: 1, tick: 100 }, { commandKey: 'rest', args: {} }, 'same').state.nationTurns,
    ).toEqual(state.nationTurns);
  });
  it('사람 국가에는 제안만 남기고 자원·외교를 바꾸지 않는다', () => {
    const state = commandWorld();
    state.nations[2]!.isNpc = false;
    const result = execute(state, 1, 'nation_peace', { nationId: 2 }, 'nation');
    expect(result.state).toEqual(state);
    expect(result.result.history?.[0]?.text).toContain('응답 대기');
    state.diplomacies = [];
    const aid = execute(state, 1, 'nation_aid', { nationId: 2, resource: 'rice', amount: 100 }, 'nation');
    expect(aid.state).toEqual(state);
    expect(aid.result.history?.[0]?.text).toContain('원조 쌀 100: 응답 대기');
  });
});
