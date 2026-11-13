import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { simulateBattle } from '../battle/simulate';
import { recruitCost } from '../commands/statScores';
import { COMBAT_SPECIALTY_FEATURE, combatSpecialty } from './combatSpecialty';

it('discounts only the matching recruitment arm in enabled worlds', () => {
  const world = commandWorld();
  const general = { ...world.generals[1]!, special: 'che_보병' };
  expect(recruitCost(world, general, 100, 10, false, 1)).toBe(1000);
  world.ruleFeatures = [COMBAT_SPECIALTY_FEATURE];
  expect(recruitCost(world, general, 100, 10, false, 1)).toBe(900);
  expect(recruitCost(world, general, 100, 10, false, 2)).toBe(1000);
});

it('applies the damage multiplier for the correct battlefield role', () => {
  const force = { crew: 9000, crewType: 1100, train: 100, atmos: 100 };
  const input = {
    attacker: force,
    defender: force,
    attackerTech: 0,
    defenderTech: 0,
    unitSet: testUnits,
    recordPhases: true,
  };
  const specialty = combatSpecialty({ ruleFeatures: [COMBAT_SPECIALTY_FEATURE] }, 'che_보병');
  const fight = (modifiers: Partial<typeof input & Parameters<typeof simulateBattle>[0]>) =>
    simulateBattle({ ...input, ...modifiers }, rngFor('combat-specialty')).phases![0]!;
  const normal = fight({});
  expect(fight({ attackerSpecialty: specialty }).attackerLoss).toBeCloseTo(normal.attackerLoss * 0.9, -1);
  expect(fight({ defenderSpecialty: specialty }).defenderLoss).toBeCloseTo(normal.defenderLoss * 0.8, -1);
});
