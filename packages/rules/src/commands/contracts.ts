import { expect } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import type { WorldState } from '../model/world';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from './effects';
import { commandRegistry, runCommand } from './registry';
import type { CommandResult, Failure } from './types';

type Case = {
  args: unknown;
  actor?: number;
  prepare?(s: WorldState): void;
  reject(s: WorldState): void;
  code: Failure['code'];
  verify(after: WorldState, before: WorldState, result: CommandResult): void;
};
const domestic: Record<string, string> = {
  farm: 'agriculture',
  commerce: 'commerce',
  security: 'security',
  settle: 'population',
  goodwill: 'trust',
  defence: 'defence',
  wall: 'wall',
  research: 'tech',
};
export const commandCases: Record<string, Case> = {};
for (const [key, field] of Object.entries(domestic))
  commandCases[key] = {
    args: {},
    reject: (s) => {
      s.generals[1]!.gold = 0;
    },
    code: 'NO_GOLD',
    verify(after, before) {
      const get = (s: WorldState) =>
        field === 'tech' ? s.nations[1]!.tech : (s.cities[1] as unknown as Record<string, number>)[field]!;
      expect(get(after)).toBeGreaterThan(get(before));
      expect(after.generals[1]!.gold).toBe(
        before.generals[1]!.gold - (['settle', 'goodwill'].includes(key) ? 200 : 100),
      );
      if (key === 'goodwill') expect(String(after.cities[1]!.trust)).toContain('.');
    },
  };
Object.assign(commandCases, {
  rest: {
    args: {},
    reject: (s: WorldState) => {
      delete s.generals[1];
    },
    code: 'NO_ACTOR',
    verify: (a: WorldState) => expect(a.generals[1]!.injury).toBe(19),
  },
  recruit: {
    args: { amount: 100, crewType: 1100 },
    prepare: (s: WorldState) => {
      s.generals[1]!.crew = 0;
    },
    reject: (s: WorldState) => {
      s.cities[1]!.population = 0;
    },
    code: 'NO_POPULATION',
    verify: (a: WorldState) => {
      expect(a.generals[1]).toMatchObject({ crew: 100, gold: 99100, crewType: 1100, train: 0, atmos: 0 });
      expect(a.cities[1]!.population).toBe(19900);
    },
  },
  conscript: {
    args: { amount: 100, crewType: 1100 },
    prepare: (s: WorldState) => {
      s.generals[1]!.crew = 0;
    },
    reject: (s: WorldState) => {
      s.generals[1]!.gold = 0;
    },
    code: 'NO_GOLD',
    verify: (a: WorldState) => {
      expect(a.generals[1]).toMatchObject({ crew: 100, gold: 99550 });
      expect(a.cities[1]!.trust).toBe(75);
    },
  },
  train: {
    args: {},
    prepare: (s: WorldState) => {
      s.generals[1]!.train = 20;
    },
    reject: (s: WorldState) => {
      s.generals[1]!.crew = 0;
    },
    code: 'NO_CREW',
    verify: (a: WorldState) => expect(a.generals[1]).toMatchObject({ train: 30, gold: 99900 }),
  },
  morale: {
    args: {},
    prepare: (s: WorldState) => {
      s.generals[1]!.atmos = 20;
    },
    reject: (s: WorldState) => {
      s.generals[1]!.crew = 0;
    },
    code: 'NO_CREW',
    verify: (a: WorldState) => expect(a.generals[1]).toMatchObject({ atmos: 30, gold: 99900 }),
  },
  attack: {
    args: { cityKey: 2 },
    reject: (s: WorldState) => {
      s.diplomacies = [];
    },
    code: 'NOT_WAR',
    verify: (a: WorldState, _b: WorldState, r: CommandResult) => {
      expect(a.cities[2]).toMatchObject({ nationId: 1, wall: 0, defence: 0, security: 50, trust: 60 });
      expect(a.nations[2]).toBeUndefined();
      expect(a.generals[2]).toMatchObject({ nationId: null, officerLevel: 0 });
      expect(r.reports?.map((e) => e.generalId)).toEqual([2, 3]);
      expect(r.logs[0]!.text).toContain('성벽');
    },
  },
  move: {
    args: { cityKey: 2 },
    prepare: (s: WorldState) => {
      s.cities[2]!.nationId = 1;
    },
    reject: (s: WorldState) => {
      s.cities[1]!.connections = [];
    },
    code: 'NOT_ADJACENT',
    verify: (a: WorldState) => expect(a.generals[1]!.cityKey).toBe(2),
  },
  return: {
    args: {},
    prepare: (s: WorldState) => {
      s.generals[1]!.cityKey = 4;
    },
    reject: (s: WorldState) => {
      s.generals[1]!.nationId = null;
    },
    code: 'NOT_NATION',
    verify: (a: WorldState) => expect(a.generals[1]!.cityKey).toBe(1),
  },
  dismiss: {
    args: {},
    reject: (s: WorldState) => {
      s.generals[1]!.crew = 0;
    },
    code: 'NO_CREW',
    verify: (a: WorldState) => {
      expect(a.generals[1]).toMatchObject({ crew: 0, train: 0, atmos: 0 });
      expect(a.cities[1]!.population).toBe(30000);
    },
  },
  join: {
    actor: 4,
    args: { nationId: 1 },
    reject: (s: WorldState) => {
      s.generals[4]!.nationId = 2;
    },
    code: 'BAD_STATE',
    verify: (a: WorldState) => expect(a.generals[4]).toMatchObject({ nationId: 1, cityKey: 1, officerLevel: 1 }),
  },
  join_random: {
    actor: 4,
    args: {},
    reject: (s: WorldState) => {
      s.generals[4]!.nationId = 2;
    },
    code: 'BAD_STATE',
    verify: (a: WorldState) => {
      const g = a.generals[4]!;
      expect([1, 2]).toContain(g.nationId);
      expect(g.cityKey).toBe(a.nations[g.nationId!]!.capitalCityKey);
    },
  },
  found: {
    actor: 4,
    args: { name: '새나라', color: '#123456' },
    reject: (s: WorldState) => {
      s.cities[3]!.nationId = 2;
    },
    code: 'NOT_OWN_CITY',
    verify: (a: WorldState) => {
      expect(a.nations[3]).toMatchObject({ name: '새나라', capitalCityKey: 3 });
      expect(a.generals[4]).toMatchObject({ nationId: 3, officerLevel: 12, gold: 99000 });
      expect(a.cities[3]).toMatchObject({ nationId: 3, supplied: true });
    },
  },
  uprising: {
    actor: 4,
    args: { name: '의군', color: '#123456' },
    reject: (s: WorldState) => {
      s.generals[4]!.crew = 0;
    },
    code: 'NO_CREW',
    verify: (a: WorldState) => {
      expect(a.nations[3]).toMatchObject({ name: '의군', capitalCityKey: 3 });
      expect(a.generals[4]!.nationId).toBe(3);
    },
  },
  resign: {
    actor: 3,
    args: {},
    reject: (s: WorldState) => {
      s.generals[3]!.officerLevel = 12;
    },
    code: 'BAD_STATE',
    verify: (a: WorldState) => expect(a.generals[3]).toMatchObject({ nationId: null, officerLevel: 0 }),
  },
  invite: {
    args: { generalId: 4 },
    reject: (s: WorldState) => {
      s.generals[4]!.nationId = 2;
    },
    code: 'BAD_TARGET',
    verify: (a: WorldState) => expect(a.commandMeta?.offers[4]).toBe(1),
  },
  accept_invite: {
    actor: 4,
    args: {},
    prepare: (s: WorldState) => {
      s.commandMeta = { nextNationId: 3, offers: { 4: 1 } };
    },
    reject: (s: WorldState) => {
      s.commandMeta!.offers = {};
    },
    code: 'NO_OFFER',
    verify: (a: WorldState) => {
      expect(a.generals[4]).toMatchObject({ nationId: 1, cityKey: 1 });
      expect(a.commandMeta?.offers[4]).toBeUndefined();
    },
  },
  heal: {
    args: {},
    reject: (s: WorldState) => {
      s.generals[1]!.gold = 0;
    },
    code: 'NO_GOLD',
    verify: (a: WorldState) => expect(a.generals[1]).toMatchObject({ injury: 10, gold: 99900 }),
  },
  trade_rice: {
    args: { buy: true, amount: 100 },
    reject: (s: WorldState) => {
      s.generals[1]!.gold = 0;
    },
    code: 'NO_GOLD',
    verify: (a: WorldState) => expect(a.generals[1]).toMatchObject({ gold: 99900, rice: 100100 }),
  },
  donate: {
    args: { resource: 'rice', amount: 100 },
    reject: (s: WorldState) => {
      s.generals[1]!.rice = 0;
    },
    code: 'NO_RICE',
    verify: (a: WorldState) => {
      expect(a.generals[1]).toMatchObject({ rice: 99900, dedication: 100 });
      expect(a.nations[1]!.rice).toBe(100100);
    },
  },
  nation_rest: {
    args: {},
    reject: (s: WorldState) => {
      s.generals[1]!.officerLevel = 1;
    },
    code: 'NOT_RULER',
    verify: (a: WorldState, b: WorldState) => expect(a).toEqual(b),
  },
  nation_reward: {
    args: { generalId: 1, resource: 'gold', amount: 100 },
    reject: (s: WorldState) => {
      s.nations[1]!.gold = 0;
    },
    code: 'NO_GOLD',
    verify: (a: WorldState) => {
      expect(a.generals[1]!.gold).toBe(100100);
      expect(a.nations[1]!.gold).toBe(99900);
    },
  },
  nation_seize: {
    args: { generalId: 1, resource: 'gold', amount: 100 },
    reject: (s: WorldState) => {
      s.generals[1]!.gold = 0;
    },
    code: 'NO_GOLD',
    verify: (a: WorldState) => {
      expect(a.generals[1]!.gold).toBe(99900);
      expect(a.nations[1]!.gold).toBe(100100);
    },
  },
  nation_assign: {
    args: { generalId: 1, cityKey: 4 },
    reject: (s: WorldState) => {
      s.cities[4]!.nationId = 2;
    },
    code: 'BAD_TARGET',
    verify: (a: WorldState) => expect(a.generals[1]!.cityKey).toBe(4),
  },
  nation_capital: {
    args: { cityKey: 4 },
    reject: (s: WorldState) => {
      s.cities[4]!.nationId = 2;
    },
    code: 'NOT_OWN_CITY',
    verify: (a: WorldState) => {
      expect(a.nations[1]!.capitalCityKey).toBe(4);
      expect(a.cities[4]!.supplied).toBe(true);
      expect(a.cities[1]!.supplied).toBe(false);
    },
  },
  nation_declare: {
    args: { nationId: 2 },
    prepare: (s: WorldState) => {
      s.diplomacies = [];
    },
    reject: (s: WorldState) => {
      s.diplomacies = [{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 10000 }];
    },
    code: 'BAD_STATE',
    verify: (a: WorldState) =>
      expect(a.diplomacies).toEqual([{ nationA: 1, nationB: 2, state: 'DECLARED', untilTick: 10100 }]),
  },
  nation_peace: {
    args: { nationId: 2 },
    reject: (s: WorldState) => {
      s.diplomacies = [];
    },
    code: 'NOT_WAR',
    verify: (a: WorldState, _b: WorldState, r: CommandResult) => {
      expect(a.diplomacies).toEqual([]);
      expect(r.history?.[0]?.text).toContain('수락');
    },
  },
  nation_pact: {
    args: { nationId: 2 },
    prepare: (s: WorldState) => {
      s.diplomacies = [];
    },
    reject: (s: WorldState) => {
      s.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
    },
    code: 'BAD_STATE',
    verify: (a: WorldState) =>
      expect(a.diplomacies).toEqual([{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 120100 }]),
  },
  nation_break_pact: {
    args: { nationId: 2 },
    prepare: (s: WorldState) => {
      s.diplomacies = [{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 10000 }];
    },
    reject: (s: WorldState) => {
      s.diplomacies = [];
    },
    code: 'BAD_STATE',
    verify: (a: WorldState, b: WorldState, r: CommandResult) => {
      expect(a).toEqual(b);
      expect(r.history?.[0]?.text).toContain('거절');
    },
  },
  nation_aid: {
    args: { nationId: 2, resource: 'rice', amount: 100 },
    prepare: (s: WorldState) => {
      s.diplomacies = [];
    },
    reject: (s: WorldState) => {
      s.nations[1]!.rice = 0;
    },
    code: 'NO_RICE',
    verify: (a: WorldState) => {
      expect(a.nations[1]!.rice).toBe(99900);
      expect(a.nations[2]!.rice).toBe(100100);
    },
  },
} satisfies Record<string, Case>);

export function verifySuccess(key: string) {
  const test = commandCases[key]!;
  const state = commandWorld();
  test.prepare?.(state);
  const before = structuredClone(state);
  const result = runCommand(
    state,
    { generalId: test.actor ?? 1, target: commandRegistry.get(key)!.target, tick: 100, unitSet: testUnits },
    key,
    test.args,
    rngFor('contract', key),
  );
  expect(result).not.toHaveProperty('code');
  if ('code' in result) throw new Error(result.message);
  expect(state).toEqual(before);
  test.verify(applyEffects(state, result.effects), before, result);
  expect(result.logs.length).toBeGreaterThan(0);
}
export function verifyFailure(key: string) {
  const test = commandCases[key]!;
  const state = commandWorld();
  test.prepare?.(state);
  test.reject(state);
  const before = structuredClone(state);
  const result = runCommand(
    state,
    { generalId: test.actor ?? 1, target: commandRegistry.get(key)!.target, tick: 100, unitSet: testUnits },
    key,
    test.args,
    rngFor('contract', key),
  );
  expect(result).toMatchObject({ code: test.code });
  expect(result).not.toHaveProperty('effects');
  expect(state).toEqual(before);
}
