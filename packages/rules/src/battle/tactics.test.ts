import { expect, it } from 'vitest';
import type { Rng } from '@opensamguk/shared';
import { rollBattleTactics } from './tactics';
import { combatSpecialty, COMBAT_SPECIALTY_FEATURE } from '../general/combatSpecialty';

const world = { ruleFeatures: [COMBAT_SPECIALTY_FEATURE] };
const stats = { leadership: 80, strength: 100, intel: 100 };
const foot = { armType: 1, magicCoef: 0 };
const wizard = { armType: 4, magicCoef: 0.1 };
const wall = { armType: 0, magicCoef: 0 };
const rolls = (...values: number[]) =>
  ({
    next: () => {
      const value = values.shift();
      if (value === undefined) throw new Error('unexpected battle roll');
      return value;
    },
  }) as Rng;

it('gates new rolls and applies opposing heritage to the critical threshold', () => {
  expect(
    rollBattleTactics(undefined, foot, foot, undefined, undefined, undefined, undefined, false, rolls()).dealt,
  ).toBe(1);
  expect(
    rollBattleTactics(stats, foot, foot, undefined, undefined, { critical: 5 }, undefined, false, rolls(0.2, 0.5)),
  ).toMatchObject({ critical: true, dealt: 1.65 });
  expect(
    rollBattleTactics(
      stats,
      foot,
      foot,
      undefined,
      undefined,
      { critical: 5 },
      { opponentCritical: 5 },
      false,
      rolls(0.2),
    ),
  ).not.toHaveProperty('critical');
  expect(
    rollBattleTactics(
      stats,
      foot,
      foot,
      combatSpecialty(world, '필살'),
      undefined,
      undefined,
      undefined,
      false,
      rolls(0.3, 0),
    ),
  ).toMatchObject({ critical: true, ignoresEvasion: true });
});

it('selects a siege tactic and applies success or failure damage', () => {
  const fight = (success: number) =>
    rollBattleTactics(stats, wizard, wall, undefined, undefined, undefined, undefined, true, rolls(0.2, 0, success));
  expect(fight(0.5)).toMatchObject({ tactic: { name: '급습', success: true }, dealt: 1.2, opposing: 1 });
  expect(fight(0.9)).toMatchObject({ tactic: { name: '급습', success: false }, dealt: 1 / 1.1, opposing: 1.1 });
});
