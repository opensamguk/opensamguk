import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { simulateBattle } from '../battle/simulate';
import { recruitCost } from '../commands/statScores';
import { runGeneralTurn } from '../commands/turn';
import { GENERAL_PERSONALITY_FEATURE, personalityEffects } from './personality';

it('applies recruitment and earned contribution modifiers without changing legacy worlds', () => {
  const world = commandWorld();
  const general = world.generals[1]!;
  general.personality = 'che_안전';
  const normal = recruitCost(world, general, 100, 10, false);
  const forced = recruitCost(world, general, 100, 10, true);
  expect(personalityEffects(world, general.personality)).toBeUndefined();
  world.ruleFeatures = [GENERAL_PERSONALITY_FEATURE];
  expect(recruitCost(world, general, 100, 10, false)).toBe(normal * 0.8);
  expect(recruitCost(world, general, 100, 10, true)).toBe(forced * 0.8);
  general.personality = 'che_은둔';
  general.userId = 'player';
  const turn = runGeneralTurn(
    world,
    { generalId: 1, tick: 100, unitSet: testUnits },
    { commandKey: 'donate', args: { resource: 'gold', amount: 100 } },
    'personality',
  );
  expect(turn.state.generals[1]!.dedication - general.dedication).toBe(90);
  expect(turn.state.generals[1]!.gold - general.gold).toBe(-100);
});

it('uses battle training and morale bonuses without adding them to stored troops', () => {
  const world = commandWorld();
  world.ruleFeatures = [GENERAL_PERSONALITY_FEATURE];
  const force = { crew: 9000, crewType: 1100, train: 75, atmos: 75 };
  const input = {
    attacker: force,
    defender: force,
    attackerTech: 0,
    defenderTech: 0,
    unitSet: testUnits,
    recordPhases: true,
  };
  const normal = simulateBattle(input, rngFor('personality'));
  const aggressive = simulateBattle(
    {
      ...input,
      attackerReadiness: personalityEffects(world, 'che_정복'),
    },
    rngFor('personality'),
  );
  expect(aggressive.phases?.[0]?.defenderLoss).toBeGreaterThan(normal.phases?.[0]?.defenderLoss ?? 0);
  expect(aggressive.attacker.train).toBe(force.train);
  expect(aggressive.attacker.atmos).toBeLessThanOrEqual(force.atmos);
});
