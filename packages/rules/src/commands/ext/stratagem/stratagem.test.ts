import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../../../test/commandFixture';
import { commandCases } from '../../contracts';
import { TICKS_PER_MONTH } from '../../../clock/constants';
import type { WorldState } from '../../../model/world';
import { applyEffects, type Effect } from '../../effects';
import { createCommandResolver, createCommandResolverWithCommands } from '../../resolve';
import type { CommandResult, Failure } from '../../types';
import {
  effectiveStat,
  plunderYearCoefficient,
  stratagemDefenders,
  stratagemDistance,
  stratagemProbability,
} from './base';
import { stratagemCommands } from './index';

const enabled = { general: stratagemCommands.map((def) => def.key), nation: [] };
const resolver = createCommandResolverWithCommands(enabled, stratagemCommands);
const actor = { generalId: 1 };
const args = { cityKey: 2 };
function world() {
  const state = commandWorld();
  for (const general of Object.values(state.generals)) if (general.id !== 1) general.cityKey = 3;
  Object.assign(state.cities[2]!, {
    agriculture: 900,
    commerce: 800,
    defence: 700,
    wall: 600,
    security: 500,
    level: 4,
  });
  return state;
}
function run(key: string, state = world(), rng: Rng = createRng('stratagem-success'), tick = 0): CommandResult {
  const result = resolver.run(state, { ...actor, tick }, key, args, rng);
  if ('code' in result) throw new Error(result.message);
  return result;
}
function growth(experience: number, dedication: number): Effect[] {
  return [
    { kind: 'general', id: 1, field: 'gold', op: 'add', value: -100 },
    { kind: 'general', id: 1, field: 'rice', op: 'add', value: -100 },
    { kind: 'general', id: 1, field: 'experience', op: 'add', value: experience },
    { kind: 'general', id: 1, field: 'dedication', op: 'add', value: dedication },
  ];
}
function script(values: number[]) {
  const calls: string[] = [];
  const take = () => {
    const value = values.shift();
    if (value === undefined) throw new Error('예정한 난수를 모두 썼습니다.');
    return value;
  };
  const rng: Rng = {
    next() {
      calls.push('next');
      return take();
    },
    int(min, max) {
      calls.push(`int(${min},${max})`);
      const value = take();
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
      return value;
    },
    pick() {
      throw new Error('pick을 쓰면 안 됩니다.');
    },
  };
  return { rng, calls, remaining: values };
}

const goldens = [
  {
    key: 'fire_attack',
    name: '화계',
    fields: ['agriculture', 'commerce'],
    values: [497, 687],
    amounts: '농업 497, 상업 687 감소',
  },
  {
    key: 'sabotage',
    name: '파괴',
    fields: ['defence', 'wall'],
    values: [497, 600],
    amounts: '수비 497, 성벽 600 감소',
  },
  {
    key: 'incite',
    name: '선동',
    fields: ['security', 'trust'],
    values: [497, 13.726781917270273],
    amounts: '치안 497, 민심 13.7 감소',
  },
] as const;

describe('stratagem success seed goldens', () => {
  for (const golden of goldens)
    it(golden.key, () => {
      expect(run(golden.key)).toEqual({
        effects: [
          ...growth(269, 179),
          ...golden.fields.map((field, i) => ({ kind: 'city', id: 2, field, op: 'add', value: -golden.values[i]! })),
        ],
        logs: [{ kind: 'success', text: `${golden.name} 성공: 도시2 ${golden.amounts}, 장수 0명 부상` }],
        reports: [],
        history: [
          { nationId: 2, text: `도시2: ${golden.name}${golden.key === 'incite' ? '으로' : '로'} ${golden.amounts}` },
        ],
      });
    });
  it('plunder', () => {
    expect(run('plunder')).toEqual({
      effects: [
        ...growth(269, 179),
        { kind: 'nation', id: 2, field: 'gold', op: 'add', value: -447 },
        { kind: 'nation', id: 2, field: 'rice', op: 'add', value: -653 },
        { kind: 'nation', id: 1, field: 'gold', op: 'add', value: 313 },
        { kind: 'nation', id: 1, field: 'rice', op: 'add', value: 457 },
        { kind: 'general', id: 1, field: 'gold', op: 'add', value: 134 },
        { kind: 'general', id: 1, field: 'rice', op: 'add', value: 196 },
      ],
      logs: [{ kind: 'success', text: '탈취 성공: 도시2 금 447, 쌀 653 획득' }],
      history: [{ nationId: 2, text: '도시2: 금 447, 쌀 653 도난' }],
    });
  });
});

describe.each(stratagemCommands)('$key shared contract', (def) => {
  it('probability failure seed golden consumes three draws and pays both costs', () => {
    const real = createRng('seed-1');
    const calls: string[] = [];
    const rng: Rng = {
      ...real,
      next() {
        calls.push('next');
        return real.next();
      },
      int(min, max) {
        calls.push(`int(${min},${max})`);
        return real.int(min, max);
      },
    };
    expect(run(def.key, world(), rng)).toEqual({
      effects: growth(53, 40),
      logs: [{ kind: 'success', text: `${def.name} 실패: 도시2` }],
    });
    expect(calls).toEqual(['next', 'int(1,100)', 'int(1,70)']);
    expect(real.next()).toBe(0.9833635643590242);
  });
  it('same seed gives identical results without changing input and uses only field effects', () => {
    const state = world();
    const before = structuredClone(state);
    const first = run(def.key, state);
    expect(run(def.key, state)).toEqual(first);
    expect(run(def.key, state, createRng('seed-1'))).not.toEqual(first);
    expect(state).toEqual(before);
    expect(first.effects.every((e) => e.kind !== 'world')).toBe(true);
    const next = applyEffects(state, first.effects);
    expect(next.generals[1]!.rice).toBe(def.key === 'plunder' ? 100096 : 99900);
    expect(state).toEqual(before);
  });
  it('checks exact cost boundary without preparation turns', () => {
    const state = world();
    Object.assign(state.generals[1]!, { gold: 100, rice: 100 });
    expect(resolver.precheck(state, actor, def.key, args)).toBeNull();
    const next = applyEffects(state, run(def.key, state, createRng('seed-1')).effects);
    expect(next.generals[1]).toMatchObject({ gold: 0, rice: 0 });
    state.generals[1]!.gold = 99;
    expect(resolver.precheck(state, actor, def.key, args)).toMatchObject({ code: 'NO_GOLD' });
    state.generals[1]!.gold = 100;
    state.generals[1]!.rice = 99;
    expect(resolver.precheck(state, actor, def.key, args)).toMatchObject({ code: 'NO_RICE' });
  });
  const failures: [string, (s: WorldState) => void, Failure][] = [
    [
      'actor',
      (s) => {
        delete s.generals[1];
      },
      { code: 'NO_ACTOR', message: '장수가 없습니다.' },
    ],
    [
      'unaffiliated',
      (s) => {
        s.generals[1]!.nationId = null;
      },
      { code: 'NOT_NATION', message: '국가에 소속되어야 합니다.' },
    ],
    [
      'missing nation',
      (s) => {
        delete s.nations[1];
      },
      { code: 'NOT_NATION', message: '국가에 소속되어야 합니다.' },
    ],
    [
      'own city',
      (s) => {
        s.cities[1]!.nationId = 2;
      },
      { code: 'NOT_OWN_CITY', message: '자기 국가 도시에서만 가능합니다.' },
    ],
    [
      'missing origin',
      (s) => {
        delete s.cities[1];
      },
      { code: 'NOT_OWN_CITY', message: '자기 국가 도시에서만 가능합니다.' },
    ],
    [
      'supply',
      (s) => {
        s.cities[1]!.supplied = false;
      },
      { code: 'NO_SUPPLY', message: '보급이 끊긴 도시입니다.' },
    ],
    [
      'missing target',
      (s) => {
        delete s.cities[2];
      },
      { code: 'BAD_TARGET', message: '없는 도시입니다.' },
    ],
    [
      'own target',
      (s) => {
        s.cities[2]!.nationId = 1;
      },
      { code: 'BAD_TARGET', message: '자기 국가 도시에는 계략을 쓸 수 없습니다.' },
    ],
    [
      'unowned target',
      (s) => {
        s.cities[2]!.nationId = null;
      },
      { code: 'BAD_TARGET', message: '공백지에는 계략을 쓸 수 없습니다.' },
    ],
    [
      'non aggression before cost',
      (s) => {
        s.diplomacies[0]!.state = 'NON_AGGRESSION';
        s.generals[1]!.gold = 0;
        s.generals[1]!.rice = 0;
      },
      { code: 'BAD_TARGET', message: '불가침 중인 국가입니다.' },
    ],
    [
      'gold before rice',
      (s) => {
        s.generals[1]!.gold = 0;
        s.generals[1]!.rice = 0;
      },
      { code: 'NO_GOLD', message: '금이 부족합니다.' },
    ],
    [
      'rice',
      (s) => {
        s.generals[1]!.rice = 0;
      },
      { code: 'NO_RICE', message: '쌀이 부족합니다.' },
    ],
  ];
  for (const [name, prepare, expected] of failures)
    it(`rejects ${name} without draws or mutation`, () => {
      const state = world();
      prepare(state);
      const before = structuredClone(state);
      const controlled = script([]);
      expect(def.check(state, actor, args)).toEqual(expected);
      expect(def.precheck(state, actor, args)).toEqual(expected);
      expect(resolver.run(state, actor, def.key, args, controlled.rng)).toEqual(expected);
      expect(() => def.execute(state, actor, args, controlled.rng)).toThrow(expected.message);
      expect(controlled.calls).toEqual([]);
      expect(state).toEqual(before);
    });
  for (const raw of [{}, { cityKey: 0 }, { cityKey: -1 }, { cityKey: 1.2 }, { cityKey: 2, extra: 1 }])
    it(`rejects args ${JSON.stringify(raw)}`, () => {
      expect(resolver.run(world(), actor, def.key, raw, script([]).rng)).toMatchObject({ code: 'BAD_ARGS' });
    });
  it('rejects wrong target; disabled definitions stay separate from production', () => {
    expect(resolver.run(world(), { ...actor, target: 'nation' }, def.key, args, script([]).rng)).toMatchObject({
      code: 'BAD_ARGS',
    });
    expect(
      createCommandResolverWithCommands(null, stratagemCommands).run(world(), actor, def.key, args, script([]).rng),
    ).toMatchObject({ code: 'COMMAND_DISABLED' });
    expect(() => createCommandResolver(enabled)).toThrow('확장 명령 설정을 확인하세요');
  });
  it('production resolver does not register definition', () => {
    expect(createCommandResolver(null).run(world(), actor, def.key, args, script([]).rng)).toMatchObject({
      code: 'UNKNOWN_COMMAND',
    });
    expect(createCommandResolver(null).list('general').length + createCommandResolver(null).list('nation').length).toBe(
      37,
    );
  });
  for (const stateName of ['WAR', 'DECLARED', 'PEACE'] as const)
    it(`allows ${stateName}`, () => {
      const state = world();
      if (stateName === 'PEACE') state.diplomacies = [];
      else state.diplomacies[0]!.state = stateName;
      expect(def.precheck(state, actor, args)).toBeNull();
    });
});

it('effective stats clamp, cross round and ignore injury', () => {
  expect(effectiveStat({ leadership: 100, strength: 80, intel: 70 }, 'intel')).toBe(90);
  expect(effectiveStat({ leadership: 100, strength: 80, intel: 70 }, 'strength')).toBe(98);
  expect(effectiveStat({ leadership: 100.9, strength: 80, intel: 70 }, 'leadership')).toBe(100);
  expect(effectiveStat({ leadership: -1, strength: 900, intel: 900 }, 'strength')).toBe(255);
  expect(effectiveStat({ leadership: -1, strength: 900, intel: 900 }, 'leadership')).toBe(0);
  const state = world();
  const before = stratagemProbability(state, actor, 2, 'intel');
  state.generals[1]!.injury = 100;
  expect(stratagemProbability(state, actor, 2, 'intel')).toBe(before);
});

it('nine hand-calculated probability cells clamp after dividing by distance', () => {
  for (const [stat, numerator] of [
    ['intel', 0.5],
    ['strength', 0.5266666666666666],
    ['leadership', 0.5333333333333333],
  ] as const) {
    for (const [connections, distance] of [
      [[2], 1],
      [[3], 2],
      [[], 99],
    ] as const) {
      const state = world();
      state.cities[1]!.connections = [...connections];
      state.cities[3]!.connections = [1, 2];
      expect(stratagemProbability(state, actor, 2, stat)).toBeCloseTo(Math.min(0.5, numerator / distance), 10);
    }
  }
});

it('distance BFS finds shortest routes up to five across every ownership and rejects cycles', () => {
  const state = world();
  for (let id = 1; id <= 7; id++)
    state.cities[id] = { ...state.cities[2]!, cityKey: id, nationId: id % 2 ? null : 2, connections: [id - 1, id + 1] };
  for (const [to, distance] of [
    [2, 1],
    [3, 2],
    [6, 5],
    [7, 99],
    [100, 99],
  ])
    expect(stratagemDistance(state, 1, to!)).toBe(distance);
  state.cities[1]!.connections = [];
  expect(stratagemDistance(state, 1, 2)).toBe(99);
});

it('zero and exact half probabilities both consume the first next and strict less than decides', () => {
  const state = world();
  Object.assign(state.generals[2]!, { cityKey: 2, leadership: 255, strength: 255, intel: 255 });
  Object.assign(state.generals[1]!, { intel: 0, strength: 0 });
  state.cities[2]!.security = 1000;
  expect(stratagemProbability(state, actor, 2, 'intel')).toBe(0);
  const zero = script([0, 1, 1]);
  expect(run('fire_attack', state, zero.rng).effects).toEqual(growth(1, 1));
  expect(zero.calls).toEqual(['next', 'int(1,100)', 'int(1,70)']);
  const halfState = world();
  halfState.cities[2]!.security = 0;
  expect(stratagemProbability(halfState, actor, 2, 'intel')).toBe(0.5);
  const half = script([0.5, 100, 70]);
  expect(run('fire_attack', halfState, half.rng).effects).toEqual(growth(100, 70));
  expect(half.calls).toEqual(zero.calls);
});

it('injuries process only active target nation defenders in id order and preserve 80 plus', () => {
  const state = world();
  for (const [id, injury] of [
    [9, 79],
    [5, 85],
    [7, 20],
  ])
    state.generals[id!] = {
      ...state.generals[2]!,
      id: id!,
      cityKey: 2,
      injury: injury!,
      crew: 101,
      atmos: 71,
      train: 81,
    };
  state.generals[2]!.cityKey = 2;
  state.generals[2]!.activeFromYear = state.startYear + 1;
  state.generals[3]!.cityKey = 2;
  state.generals[3]!.nationId = 1;
  expect(stratagemDefenders(state, 2, state.startYear).map((g) => g.id)).toEqual([5, 7, 9]);
  const controlled = script([0, 0.1, 16, 0.3, 0.299, 16, 800, 100, 201, 141]);
  const result = run('fire_attack', state, controlled.rng);
  expect(controlled.calls).toEqual([
    'next',
    'next',
    'int(1,16)',
    'next',
    'next',
    'int(1,16)',
    'int(100,800)',
    'int(100,800)',
    'int(201,300)',
    'int(141,210)',
  ]);
  expect(controlled.remaining).toEqual([]);
  expect(result.effects).toEqual([
    ...growth(201, 141),
    { kind: 'general', id: 5, field: 'crew', op: 'set', value: 99 },
    { kind: 'general', id: 5, field: 'atmos', op: 'set', value: 70 },
    { kind: 'general', id: 5, field: 'train', op: 'set', value: 79 },
    { kind: 'general', id: 9, field: 'injury', op: 'set', value: 80 },
    { kind: 'general', id: 9, field: 'crew', op: 'set', value: 99 },
    { kind: 'general', id: 9, field: 'atmos', op: 'set', value: 70 },
    { kind: 'general', id: 9, field: 'train', op: 'set', value: 79 },
    { kind: 'city', id: 2, field: 'agriculture', op: 'add', value: -800 },
    { kind: 'city', id: 2, field: 'commerce', op: 'add', value: -100 },
  ]);
  expect(result.reports).toEqual([5, 9].map((generalId) => ({ generalId, text: '도시2: 계략으로 다쳤습니다.' })));
  expect(result.logs[0]!.text).toBe('화계 성공: 도시2 농업 800, 상업 100 감소, 장수 2명 부상');
  const after = applyEffects(state, result.effects);
  expect(after.generals[5]!.injury).toBe(85);
  expect(after.generals[9]!.injury).toBe(80);
  expect(stratagemDefenders(state, 2, state.startYear + 1).map((g) => g.id)).toEqual([2, 5, 7, 9]);
});

it('future, other nation and other city defenders cannot change probability or RNG', () => {
  const state = world();
  const baseline = run('fire_attack', state);
  Object.assign(state.generals[2]!, { cityKey: 2, intel: 255, strength: 255, activeFromYear: state.startYear + 1 });
  Object.assign(state.generals[3]!, { cityKey: 2, nationId: 1 });
  expect(run('fire_attack', state)).toEqual(baseline);
});

it('clamps all damage fields and preserves fractional trust', () => {
  for (const { key, fields } of goldens) {
    const state = world();
    state.cities[2]![fields[0]] = 50;
    state.cities[2]![fields[1]] = key === 'incite' ? 3 : 40;
    const controlled = script(key === 'incite' ? [0, 800, 0.999, 300, 210] : [0, 800, 800, 300, 210]);
    const result = run(key, state, controlled.rng);
    expect(result.effects.slice(-2).map((effect) => effect.kind !== 'world' && effect.value)).toEqual([
      -50,
      key === 'incite' ? -3 : -40,
    ]);
    const after = applyEffects(state, result.effects);
    expect(after.cities[2]![fields[0]]).toBe(0);
    expect(after.cities[2]![fields[1]]).toBe(0);
  }
  const controlled = script([0, 100, 0.123, 201, 141]);
  const result = run('incite', world(), controlled.rng);
  expect(controlled.calls).toEqual(['next', 'int(100,800)', 'next', 'int(201,300)', 'int(141,210)']);
  expect(applyEffects(world(), result.effects).cities[2]!.trust).toBeCloseTo(76.278);
});

it('plunder year coefficients use execution tick and ignore negative elapsed years', () => {
  expect(plunderYearCoefficient(191, 190)).toBe(0.5);
  for (const [years, coefficient] of [
    [0, 0.5],
    [4, Math.SQRT2 / 2],
    [12, 1],
  ]) {
    expect(plunderYearCoefficient(191, 191 + years!)).toBe(coefficient);
    const state = world();
    const result = run('plunder', state, script([0, 800, 800, 201, 141]).rng, years! * 12 * TICKS_PER_MONTH);
    expect(result.effects[4]).toMatchObject({ value: -Math.round(800 * 4 * coefficient! * 0.45) });
  }
});

it('plunder never injures defenders or consumes their rolls', () => {
  const state = world();
  state.generals[2]!.cityKey = 2;
  const controlled = script([0, 100, 800, 201, 141]);
  const result = run('plunder', state, controlled.rng);
  expect(controlled.calls).toEqual(['next', 'int(100,800)', 'int(100,800)', 'int(201,300)', 'int(141,210)']);
  expect(result.reports).toBeUndefined();
});

for (const supplied of [true, false])
  for (const stock of [0, -100, 7, 100000])
    it(`plunder conserves stock supplied=${supplied} stock=${stock}, including half rounding`, () => {
      const state = world();
      state.cities[2]!.supplied = supplied;
      Object.assign(state.cities[2]!, { commerce: 0, agriculture: 0, level: 1 });
      Object.assign(state.nations[2]!, { gold: stock, rice: stock });
      // 100 * 1 * 0.5 * 0.25 = 12.5, first fix total at 13 before splitting.
      const result = run('plunder', state, script([0, 100, 100, 201, 141]).rng);
      const amount = Math.round(Math.min(12.5, Math.max(0, stock)));
      expect(result.effects.slice(4)).toEqual([
        { kind: 'nation', id: 2, field: 'gold', op: 'add', value: -amount },
        { kind: 'nation', id: 2, field: 'rice', op: 'add', value: -amount },
        { kind: 'nation', id: 1, field: 'gold', op: 'add', value: Math.round(amount * 0.7) },
        { kind: 'nation', id: 1, field: 'rice', op: 'add', value: Math.round(amount * 0.7) },
        { kind: 'general', id: 1, field: 'gold', op: 'add', value: amount - Math.round(amount * 0.7) },
        { kind: 'general', id: 1, field: 'rice', op: 'add', value: amount - Math.round(amount * 0.7) },
      ]);
      const after = applyEffects(state, result.effects);
      for (const resource of ['gold', 'rice'] as const) {
        const total = (s: WorldState) =>
          Math.max(0, s.nations[2]![resource]) + s.nations[1]![resource] + s.generals[1]![resource];
        expect(total(after)).toBe(total(state) - 100);
        expect(after.nations[2]![resource]).toBe(Math.max(0, stock) - amount);
      }
    });

for (const { key } of goldens)
  for (const injury of [79, 80, 100])
    it(`${key} injury boundary ${injury} keeps draws and reports`, () => {
      const state = world();
      Object.assign(state.generals[2]!, { cityKey: 2, injury });
      const controlled = script([0, 0, 16, 100, ...(key === 'incite' ? [0] : [100]), 201, 141]);
      const result = run(key, state, controlled.rng);
      expect(controlled.calls).toEqual([
        'next',
        'next',
        'int(1,16)',
        'int(100,800)',
        key === 'incite' ? 'next' : 'int(100,800)',
        'int(201,300)',
        'int(141,210)',
      ]);
      const after = applyEffects(state, result.effects);
      expect(after.generals[2]!.injury).toBe(injury === 79 ? 80 : injury);
      expect(after.generals[2]!.crew).toBe(20);
      expect(after.generals[2]!.train).toBe(98);
      expect(after.generals[2]!.atmos).toBe(98);
      expect(result.reports).toEqual([{ generalId: 2, text: '도시2: 계략으로 다쳤습니다.' }]);
    });

it('defence uses the maximum stat and count of active defenders', () => {
  const state = world();
  Object.assign(state.generals[2]!, { cityKey: 2, intel: 40, strength: 40 });
  Object.assign(state.generals[3]!, { cityKey: 2, intel: 20, strength: 20 });
  const expected = 0.35 + 90 / 300 - (50 / 300 + (Math.log2(3) - 1.25) * 0.04 + 0.1 + 0.1);
  expect(stratagemProbability(state, actor, 2, 'intel')).toBeCloseTo(expected, 12);
});

it('seeded plunder preserves gold and rice after applying fractional formulae', () => {
  const input = createRng('plunder-stocks');
  let successes = 0;
  for (let i = 0; i < 100; i++) {
    const state = world();
    Object.assign(state.cities[2]!, {
      commerce: input.int(0, 1000),
      agriculture: input.int(0, 1000),
      level: input.int(1, 8),
      supplied: i % 2 === 0,
    });
    Object.assign(state.nations[2]!, { gold: input.int(0, 10000), rice: input.int(0, 10000) });
    const result = run('plunder', state, createRng(`conserve-${i}`), input.int(0, 12) * 12 * TICKS_PER_MONTH);
    if (result.history) successes++;
    const after = applyEffects(state, result.effects);
    for (const resource of ['gold', 'rice'] as const) {
      const total = (s: WorldState) => s.nations[1]![resource] + s.nations[2]![resource] + s.generals[1]![resource];
      expect(total(after)).toBe(total(state) - 100);
      expect(after.nations[2]![resource]).toBeGreaterThanOrEqual(0);
      expect(after.nations[2]![resource]).toBeLessThanOrEqual(state.nations[2]![resource]);
    }
  }
  expect(successes).toBeGreaterThan(20);
});

for (const [key, test] of Object.entries(commandCases))
  it(`base command ${key} keeps result and RNG stream with stratagem definitions`, () => {
    const state = commandWorld();
    test.prepare?.(state);
    const baseline = createCommandResolver(null);
    const commandActor = {
      generalId: test.actor ?? 1,
      target: baseline.get(key)!.target,
      tick: 100,
      unitSet: testUnits,
    };
    const before = structuredClone(state);
    const first = createRng(`base-${key}`);
    const second = createRng(`base-${key}`);
    expect(resolver.run(state, commandActor, key, test.args, second)).toEqual(
      baseline.run(state, commandActor, key, test.args, first),
    );
    expect(second.next()).toBe(first.next());
    expect(state).toEqual(before);
  });
