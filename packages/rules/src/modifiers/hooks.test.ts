import { createRng, rngFor } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { simulateBattle, type BattleInput } from '../battle/simulate';
import { attack, createAttackWithProviders } from '../commands/attack';
import { applyEffects } from '../commands/effects';
import { DOMESTIC_SPECS, makeInvestment, makeInvestmentWithProviders } from '../commands/domestic/investment';
import type { DeepReadonly } from '../model/world';
import { cloneWorld } from '../model/clone';
import type { Modifier, ModifierContext, ModifierProvider } from './index';

function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function countedRng(seed: string, fixed?: number) {
  const source = createRng(seed);
  let calls = 0;
  return {
    source,
    calls: () => calls,
    rng: {
      ...source,
      next: () => {
        calls++;
        return fixed ?? source.next();
      },
    },
  };
}
const farm = DOMESTIC_SPECS.find((spec) => spec.key === 'farm')!;
const add = (source: string, value: number): Modifier => ({ source, op: 'add', value });
const mul = (source: string, value: number): Modifier => ({ source, op: 'mul', value });

describe('T4-18 내정 삽입', () => {
  it.each([
    ['H1 빈 목록', [], 28, 20],
    ['H2 배수', [mul('test:a', 1.5)], 42, 29],
    ['H3 하한', [add('test:a', -100)], 0, 0],
    ['H4 덧셈 뒤 곱셈', [mul('test:b', 1.5), add('test:a', 2)], 45, 31],
  ] as const)('%s는 전선·치명 뒤 점수에 적용돼 도시·경험·공헌을 함께 바꾼다', (_, modifiers, points, experience) => {
    const view = freeze(commandWorld());
    const before = structuredClone(view);
    const rng = countedRng('fixed', 0.5);
    const contexts: ModifierContext[] = [];
    const provider: ModifierProvider = (received, id, context) => {
      expect(received).toBe(view);
      expect(id).toBe(1);
      expect(rng.calls()).toBe(2);
      contexts.push(context);
      return modifiers;
    };
    const result = makeInvestmentWithProviders(farm, [provider]).execute(view, { generalId: 1 }, {}, rng.rng);
    expect(result.effects).toEqual([
      { kind: 'city', id: 1, field: 'agriculture', op: 'add', value: points },
      { kind: 'general', id: 1, field: 'gold', op: 'add', value: -100 },
      { kind: 'general', id: 1, field: 'experience', op: 'add', value: experience },
      { kind: 'general', id: 1, field: 'dedication', op: 'add', value: points },
    ]);
    expect(contexts).toEqual([{ stage: 'domestic.score', commandKey: 'farm' }]);
    expect(rng.calls()).toBe(2);
    expect(view).toEqual(before);
  });

  it.each(['t4-18-investment-2', 't4-18-investment-24'])('H5 치명 시드 %s의 RNG 소비와 다음값은 같다', (seed) => {
    const view = freeze(commandWorld());
    const a = countedRng(seed);
    const b = countedRng(seed);
    const original = makeInvestment(farm).execute(view, { generalId: 1 }, {}, a.rng);
    const modified = makeInvestmentWithProviders(farm, [() => [mul('test:a', 1.5)]]).execute(
      view,
      { generalId: 1 },
      {},
      b.rng,
    );
    expect(modified).not.toEqual(original);
    expect(a.calls()).toBe(3);
    expect(b.calls()).toBe(3);
    expect(a.source.next()).toBe(b.source.next());
  });

  it('민심은 소수를 보존하고 도시·기술 상한과 반올림은 기존 효과 적용에서 처리한다', () => {
    const view = freeze(commandWorld());
    const goodwill = DOMESTIC_SPECS.find((spec) => spec.key === 'goodwill')!;
    const result = makeInvestmentWithProviders(goodwill, [() => [add('test:a', 0.1)]]).execute(
      view,
      { generalId: 1 },
      {},
      countedRng('fixed', 0.5).rng,
    );
    expect(result.effects[0]).toEqual({ kind: 'city', id: 1, field: 'trust', op: 'add', value: 4.010000000000001 });
    for (const spec of [farm, DOMESTIC_SPECS.find((value) => value.key === 'research')!]) {
      const value = makeInvestmentWithProviders(spec, [() => [mul('test:a', 1e6)]]).execute(
        view,
        { generalId: 1 },
        {},
        countedRng('fixed', 0.5).rng,
      );
      const state = applyEffects(cloneWorld(view), value.effects);
      expect(spec.key === 'farm' ? state.cities[1]!.agriculture : state.nations[1]!.tech).toBe(
        spec.key === 'farm' ? 1000 : 12000,
      );
    }
  });

  it('V5 빈 제공자는 투자 8종·일반과 두 치명 구간의 결과와 RNG를 보존한다', () => {
    const view = freeze(commandWorld());
    const before = structuredClone(view);
    let providerCalls = 0;
    const provider: ModifierProvider = () => {
      providerCalls++;
      return [];
    };
    for (const spec of DOMESTIC_SPECS) {
      for (const seed of ['t4-18-investment-0', 't4-18-investment-2', 't4-18-investment-24']) {
        const a = countedRng(seed);
        const b = countedRng(seed);
        const original = makeInvestment(spec).execute(view, { generalId: 1 }, {}, a.rng);
        const injected = makeInvestmentWithProviders(spec, [provider]).execute(view, { generalId: 1 }, {}, b.rng);
        expect(injected).toEqual(original);
        expect(a.calls()).toBe(b.calls());
        expect(a.source.next()).toBe(b.source.next());
      }
    }
    expect(providerCalls).toBe(24);
    expect(view).toEqual(before);
  });
});

const battleInput = freeze<BattleInput>({
  attacker: { crew: 10000, crewType: 1100, train: 100, atmos: 100 },
  defender: { crew: 10000, crewType: 1100, train: 100, atmos: 100 },
  attackerTech: 0,
  defenderTech: 0,
  unitSet: structuredClone(testUnits),
});

describe('T4-18 전투 삽입', () => {
  it('H6 주는 피해 뒤에 받는 피해를 적용하고 반올림·최소 피해는 마지막이다', () => {
    const rng = countedRng('battle-hooks');
    const input = freeze({
      ...battleInput,
      attackerModifiers: { dealt: [add('test:a', 1000)] },
      defenderModifiers: { taken: [mul('test:a', 0)] },
    });
    const before = structuredClone(input);
    const result = simulateBattle(input, rng.rng);
    expect(result.defender.crew).toBe(9990);
    expect(rng.calls()).toBe(20);
    expect(input).toEqual(before);
  });

  it('H7 주는 피해와 상대의 받는 피해는 같은 위치에 걸린다', () => {
    for (const [dealt, taken] of [
      [{ attackerModifiers: { dealt: [mul('test:a', 0.5)] } }, { defenderModifiers: { taken: [mul('test:a', 0.5)] } }],
      [{ defenderModifiers: { dealt: [mul('test:a', 0.5)] } }, { attackerModifiers: { taken: [mul('test:a', 0.5)] } }],
    ]) {
      const a = countedRng('battle-hooks');
      const b = countedRng('battle-hooks');
      expect(simulateBattle({ ...battleInput, ...dealt }, a.rng)).toEqual(
        simulateBattle({ ...battleInput, ...taken }, b.rng),
      );
      expect(a.calls()).toBe(20);
      expect(b.calls()).toBe(20);
      expect(a.source.next()).toBe(b.source.next());
    }
  });

  it('H8 항등 수정자는 T4-33 골든과 RNG 위치를 그대로 낸다', () => {
    const source = rngFor('t4-33-pure', '열 페이즈');
    let calls = 0;
    const result = simulateBattle(
      {
        ...battleInput,
        attackerModifiers: { dealt: [mul('test:a', 1)], taken: [mul('test:a', 1)] },
        defenderModifiers: { dealt: [mul('test:b', 1)], taken: [mul('test:b', 1)] },
      },
      {
        ...source,
        next: () => {
          calls++;
          return source.next();
        },
      },
    );
    expect(result).toEqual({
      attacker: { crew: 5434, crewType: 1100, train: 100, atmos: 50 },
      defender: { crew: 5677, crewType: 1100, train: 100, atmos: 50 },
    });
    expect(calls).toBe(20);
    expect(source.next()).toBe(0.3014609052333981);
  });

  it('피해 상한은 상대 병력이고 빈 전투는 수정자를 적용하거나 RNG를 쓰지 않는다', () => {
    const rng = countedRng('upper');
    expect(
      simulateBattle({ ...battleInput, attackerModifiers: { dealt: [add('test:a', 1e9)] } }, rng.rng).defender.crew,
    ).toBe(0);
    expect(rng.calls()).toBe(2);
    const empty = countedRng('empty');
    const result = simulateBattle(
      {
        ...battleInput,
        attacker: { ...battleInput.attacker, crew: 0 },
        attackerModifiers: { dealt: [mul('test:a', -1)] },
      },
      empty.rng,
    );
    expect(result.attacker.crew).toBe(0);
    expect(empty.calls()).toBe(0);
  });
});

describe('T4-18 출병 전달', () => {
  const actor = { generalId: 1, tick: 100, unitSet: testUnits };
  it('H9 공격 수정자는 장수전과 성벽전에 전달되고 성벽 제공자는 부르지 않는다', () => {
    const state = commandWorld();
    state.generals[2]!.crew = 20000;
    state.generals[3]!.crew = 0;
    state.cities[2]!.wall = 50000;
    const view = freeze(state);
    const before = structuredClone(view);
    const rng = countedRng('attack-hooks');
    const seen: Array<[number, ModifierContext, number]> = [];
    const provider: ModifierProvider = (received, id, context) => {
      const unchanged = structuredClone(received);
      seen.push([id, context, rng.calls()]);
      expect(received.generals[1]!.rice).toBeLessThan(100000);
      const values = id === 1 && context.stage === 'battle.dealt' ? [add('test:a', 1e8)] : [];
      expect(received).toEqual(unchanged);
      return values;
    };
    const result = createAttackWithProviders([provider]).execute(view, actor, { cityKey: 2 }, rng.rng);
    const next = applyEffects(cloneWorld(view), result.effects);
    expect(next.cities[2]!.wall).toBe(0);
    expect(next.cities[2]!.nationId).toBe(1);
    expect(seen).toEqual([
      [1, { stage: 'battle.dealt', commandKey: 'attack' }, 0],
      [1, { stage: 'battle.taken', commandKey: 'attack' }, 0],
      [2, { stage: 'battle.dealt', commandKey: 'attack' }, 0],
      [2, { stage: 'battle.taken', commandKey: 'attack' }, 0],
      [1, { stage: 'battle.dealt', commandKey: 'attack' }, 2],
      [1, { stage: 'battle.taken', commandKey: 'attack' }, 2],
    ]);
    expect(rng.calls()).toBe(4);
    expect(view).toEqual(before);
    const unmodified = applyEffects(
      cloneWorld(view),
      attack.execute(view, actor, { cityKey: 2 }, createRng('attack-hooks')).effects,
    );
    expect(unmodified.cities[2]!.nationId).toBe(2);
  });

  it('V5·H10 빈 제공자 경로는 출병 결과·RNG·입력 상태를 보존한다', () => {
    const view = freeze(commandWorld());
    const before = structuredClone(view);
    const a = countedRng('empty-provider');
    const b = countedRng('empty-provider');
    let providerCalls = 0;
    const provider: ModifierProvider = () => {
      providerCalls++;
      return [];
    };
    expect(createAttackWithProviders([provider]).execute(view, actor, { cityKey: 2 }, b.rng)).toEqual(
      attack.execute(view, actor, { cityKey: 2 }, a.rng),
    );
    expect(providerCalls).toBe(10);
    expect(a.calls()).toBe(b.calls());
    expect(a.source.next()).toBe(b.source.next());
    expect(view).toEqual(before);
  });
});
