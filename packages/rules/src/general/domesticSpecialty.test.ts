import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { DOMESTIC_SPECS, domesticInvestmentCost, makeInvestment } from '../commands/domestic/investment';
import { stratagemProbability } from '../commands/ext/stratagem/base';
import { applyEffects } from '../commands/effects';
import { DOMESTIC_SPECIALTY_FEATURE, domesticSpecialty } from './domesticSpecialty';

it('applies the actual specialty to cost and outcomes, while preserving off-world rules', () => {
  const world = commandWorld();
  const general = world.generals[1]!;
  general.special = 'che_경작';
  const spec = DOMESTIC_SPECS.find(({ key }) => key === 'farm')!;
  const farm = makeInvestment(spec);
  const baseline = domesticInvestmentCost(world, general, spec);
  const run = () => {
    const rolls = [0.5, 0.15, 0.5];
    return applyEffects(
      world,
      farm.execute(world, { generalId: 1 }, {}, {
        next: () => rolls.shift()!,
      } as Parameters<typeof farm.execute>[3]).effects,
    );
  };
  const legacy = run();
  world.ruleFeatures = [DOMESTIC_SPECIALTY_FEATURE];
  expect(domesticSpecialty(world, general.special)?.name).toBe('경작');
  expect(domesticInvestmentCost(world, general, spec)).toBe(baseline * 0.8);
  const specialized = run();
  expect(specialized.generals[1]!.gold).toBe(general.gold - baseline * 0.8);
  expect(specialized.cities[1]!.agriculture).toBeGreaterThan(legacy.cities[1]!.agriculture);
});

it('applies 귀모 only to stratagem success and honors the cap', () => {
  const world = commandWorld();
  const actor = { generalId: 1 };
  const base = stratagemProbability(world, actor, 2, 'intel');
  world.ruleFeatures = [DOMESTIC_SPECIALTY_FEATURE];
  world.generals[1]!.special = 'che_귀모';
  expect(stratagemProbability(world, actor, 2, 'intel')).toBeGreaterThan(base);
  expect(stratagemProbability(world, actor, 2, 'intel')).toBeLessThanOrEqual(1);
});
