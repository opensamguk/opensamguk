import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  parsePreset,
  resolverForPreset,
  runGeneralTurn,
  toWorldState,
  type CommandResult,
  type Failure,
  type WorldInit,
  type WorldPreset,
  type WorldState,
} from '../packages/rules/src/index';
import { STRATAGEM } from '../packages/rules/src/commands/ext/stratagem/base';

const keys = ['sabotage', 'incite', 'plunder'] as const;
const cases = ['success', 'badTargetOwnCity', 'probabilityMiss'] as const;
type Key = (typeof keys)[number];
type Transfer = {
  total: number;
  nationShare: number;
  actorReceived: number;
  sourceStock: number;
  clamped: boolean;
  conserved: boolean;
};
type FixedCase = {
  seed: string;
  initial: WorldInit;
  command: { commandKey: Key; args: { cityKey: number }; explicit: true };
  options: { policy: 'none' };
  expected: {
    commandKey: Key;
    result: CommandResult | Failure;
    afterRuleTurnState: WorldState;
    costs: { gold: number; rice: number };
    defenders: Array<{ generalId: number; before: unknown; after: unknown }>;
    trust?: {
      before: number;
      after: number;
      damageEffect: number;
      displayDamage: string;
      storedEqualsBeforeMinusDamage: boolean;
    };
    nationTransfer?: { gold: Transfer; rice: Transfer };
    semanticPersistenceProjectionOnly: { BattleLog: unknown[]; GeneralLog: { text: string } };
  };
};
const fixed = JSON.parse(
  readFileSync(new URL('../apps/engine/test/fixtures/ext-n2-179bea4.json', import.meta.url), 'utf8'),
) as {
  source: string;
  search: { actor: { generalId: number; tick: number }; maxSeedsPerCommand: number };
  preset: WorldPreset;
  commands: Record<
    Key,
    {
      bounds?: { minimumGoldBeforeClamp: number; maximumRiceBeforeClamp: number };
      cases: Record<(typeof cases)[number], FixedCase>;
    }
  >;
};
function success(key: Key) {
  const value = fixed.commands[key].cases.success;
  if ('code' in value.expected.result) throw new Error('성공 고정물이 실패입니다.');
  return { value, result: value.expected.result };
}

it('N2 고정물은 source179·정렬 목록·승인 상수와 제품 preset의 끈 목록을 보존한다', () => {
  expect(fixed.source).toBe('179bea45d478fac1648802e6a9dc8e70686467b3');
  expect(parsePreset(fixed.preset)).toEqual(fixed.preset);
  expect(fixed.preset.commands).toEqual({ general: ['incite', 'plunder', 'sabotage'], nation: [] });
  expect(fixed.search.actor).toEqual({ generalId: 1, tick: 100 });
  expect(fixed.search.maxSeedsPerCommand).toBe(10000);
  expect(STRATAGEM).toEqual({
    COST_GOLD: 100,
    COST_RICE: 100,
    BASE_PROBABILITY: 0.35,
    STAT_COEFFICIENT: 300,
    MAX_STAT: 255,
    MAX_PROBABILITY: 0.5,
    INJURY_PROBABILITY: 0.3,
    INJURY_MAX: 80,
    DAMAGE_MIN: 100,
    DAMAGE_MAX: 800,
  });
  const directory = new URL('../resources/preset/', import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith('.json'));
  expect(files.sort()).toEqual(['beginner.json', 'empty.json', 'hardcore.json', 'regular.json', 'speed.json']);
  for (const file of files) expect(JSON.parse(readFileSync(new URL(file, directory), 'utf8')).commands).toBeNull();
});

for (const key of keys)
  for (const name of cases)
    it(`N2 ${key} ${name}의 고정 결과를 정상 턴 resolver와 RNG로 재현한다`, () => {
      const value = fixed.commands[key].cases[name];
      expect(value.seed).toMatch(new RegExp(`^t417-n2-${key}-\\d{5}$`));
      expect(Number(value.seed.slice(-5))).toBeLessThan(10000);
      expect(value.command).toEqual({
        commandKey: key,
        args: { cityKey: name === 'badTargetOwnCity' ? 1 : 2 },
        explicit: true,
      });
      expect(value.options).toEqual({ policy: 'none' });
      const before = toWorldState(structuredClone(value.initial));
      const snapshot = structuredClone(before);
      const turn = runGeneralTurn(
        before,
        { ...fixed.search.actor, unitSet: value.initial.unitSet },
        value.command,
        value.seed,
        value.options,
        resolverForPreset(fixed.preset),
      );
      expect(before).toEqual(snapshot);
      expect(turn.commandKey).toBe(key);
      expect(turn.nation).toBeUndefined();
      expect(turn.result).toEqual(value.expected.result);
      expect(turn.state).toEqual(value.expected.afterRuleTurnState);
      expect(Object.hasOwn(turn.state, 'ext')).toBe(false);
      if (name === 'badTargetOwnCity') {
        expect(turn.result).toMatchObject({ code: 'BAD_TARGET' });
        expect(value.expected.costs).toEqual({ gold: 0, rice: 0 });
        expect(turn.state).toEqual(snapshot);
      } else {
        expect(value.expected.costs).toEqual({ gold: 100, rice: 100 });
        if (name === 'probabilityMiss') {
          if ('code' in turn.result) throw new Error('확률 실패가 검사 실패로 바뀌었습니다.');
          expect(turn.result.effects).toHaveLength(4);
          expect(turn.result).not.toHaveProperty('reports');
          expect(turn.result).not.toHaveProperty('history');
        }
      }
    });

it('N2 파괴 성공은 수비·성벽과 실제 부상 보고를 고정하고 miss는 수비 장수를 보존한다', () => {
  const { value, result } = success('sabotage');
  expect(result.reports!.length).toBeGreaterThanOrEqual(1);
  expect(result.effects.some((effect) => effect.kind === 'general' && effect.field === 'injury')).toBe(true);
  const before = toWorldState(value.initial),
    after = value.expected.afterRuleTurnState;
  for (const field of ['defence', 'wall'] as const) {
    const effect = result.effects.find((effect) => effect.kind === 'city' && effect.id === 2 && effect.field === field);
    expect(effect).toMatchObject({ op: 'add' });
    if (!effect || effect.kind !== 'city') throw new Error('도시 피해가 없습니다.');
    expect(after.cities[2]![field]).toBe(before.cities[2]![field] + effect.value);
  }
  for (const defender of fixed.commands.sabotage.cases.probabilityMiss.expected.defenders)
    expect(defender.after).toEqual(defender.before);
});

it('N2 선동은 민심 실수 저장값과 한 자리 표시를 따로 검증한다', () => {
  const { value, result } = success('incite');
  expect(result.reports!.length).toBeGreaterThanOrEqual(1);
  const trust = value.expected.trust!;
  expect(trust.storedEqualsBeforeMinusDamage).toBe(true);
  expect(trust.after).toBe(trust.before - trust.damageEffect);
  expect(Number.isInteger(trust.after)).toBe(false);
  expect(trust.displayDamage).toBe(trust.damageEffect.toFixed(1));
  expect(result.logs[0]!.text).toContain(`민심 ${trust.displayDamage} 감소`);
  expect(result.history![0]!.text).toContain(`민심 ${trust.displayDamage} 감소`);
});

it('N2 탈취는 부상 없이 재고 제한·반올림·국가 몫·장수 몫과 비용을 분리한다', () => {
  const { value, result } = success('plunder');
  expect(result).not.toHaveProperty('reports');
  expect(value.expected.semanticPersistenceProjectionOnly.BattleLog).toEqual([]);
  expect(result.effects.some((effect) => effect.kind === 'general' && effect.field === 'injury')).toBe(false);
  for (const defender of value.expected.defenders) expect(defender.after).toEqual(defender.before);
  const transfer = value.expected.nationTransfer!;
  expect(transfer.gold.clamped).toBe(true);
  expect(transfer.gold.sourceStock).toBeLessThan(fixed.commands.plunder.bounds!.minimumGoldBeforeClamp);
  expect(transfer.rice.clamped).toBe(false);
  expect(transfer.rice.sourceStock).toBeGreaterThan(fixed.commands.plunder.bounds!.maximumRiceBeforeClamp);
  const before = toWorldState(value.initial),
    after = value.expected.afterRuleTurnState;
  for (const field of ['gold', 'rice'] as const) {
    const item = transfer[field];
    expect(Number.isInteger(item.total)).toBe(true);
    expect(item.nationShare).toBe(Math.round(item.total * 0.7));
    expect(item.actorReceived).toBe(item.total - item.nationShare);
    expect(item.conserved).toBe(true);
    expect(before.nations[2]![field] - after.nations[2]![field]).toBe(item.total);
    expect(after.nations[1]![field] - before.nations[1]![field]).toBe(item.nationShare);
    expect(after.generals[1]![field] - before.generals[1]![field]).toBe(item.actorReceived - 100);
    const total = (state: WorldState) =>
      Object.values(state.nations).reduce((sum, nation) => sum + nation[field], 0) +
      Object.values(state.generals).reduce((sum, general) => sum + general[field], 0);
    expect(total(after)).toBe(total(before) - 100);
  }
  expect(result.effects.slice(4)).toHaveLength(6);
});
