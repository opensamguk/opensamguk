import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { resolverForRuleFeatures } from '../ruleCommands';
import { GENERAL_PROFICIENCY_FEATURE, proficiencyGrade } from './proficiency';

it('gains proficiency from training and converts it only between distinct valid arms', () => {
  const state = commandWorld();
  state.ruleFeatures = [GENERAL_PROFICIENCY_FEATURE];
  const resolver = resolverForRuleFeatures(state)!;
  const actor = { generalId: 1, tick: 100, unitSet: testUnits };
  state.generals[1]!.train = 50;
  const training = resolver.run(state, actor, 'train', {}, rngFor('proficiency'));
  if ('code' in training) throw Error(training.message);
  const next = applyEffects(state, training.effects);
  expect(next.generals[1]!.proficiency?.[1]).toBe(next.generals[1]!.train - 50);
  next.generals[1]!.proficiency = { 1: 1000 };
  const args = { srcArmType: 1, destArmType: 2 };
  const invalid = resolver.run(next, actor, 'convert_proficiency', { ...args, destArmType: 1 }, rngFor('proficiency'));
  expect(invalid).toMatchObject({ code: 'BAD_ARGS' });
  const conversion = resolver.run(next, actor, 'convert_proficiency', args, rngFor('proficiency'));
  if ('code' in conversion) throw Error(conversion.message);
  expect(applyEffects(next, conversion.effects).generals[1]!.proficiency).toEqual({ 1: 600, 2: 360 });
  expect(proficiencyGrade(350)).toMatchObject({ grade: 'F', progress: 0 });
  expect(proficiencyGrade(1275975)).toMatchObject({ grade: 'EX+', overall: 100, nextGrade: null });
});
