import { expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { generalTurnCandidates, nationTurnCandidates } from './index';
import { NPC_DEFAULT_POLICY, NPC_NATION_POLICY_FEATURE } from './policy';

it('applies country-specific recruitment, drill, morale and reward targets when generating actual candidates', () => {
  const world = commandWorld();
  const nation = world.nations[1]!;
  const ruler = world.generals[1]!;
  Object.assign(ruler, { crew: 2500, train: 65, atmos: 75, gold: 9000 });
  const context = { unitSet: testUnits, tick: 100 };
  const keys = () => generalTurnCandidates(world, ruler, context).map(({ key }) => key);
  const reward = () => nationTurnCandidates(world, ruler, context).find(({ key }) => key === 'nation_reward');
  const before = keys();
  expect(before).not.toContain('recruit');
  expect(before).not.toContain('train');
  expect(before).not.toContain('morale');
  expect(reward()?.args.amount).toBe(1000);
  nation.npcSettings = {
    ...NPC_DEFAULT_POLICY,
    recruitTarget: 5000,
    trainingTarget: 90,
    moraleTarget: 90,
    rewardGoldTarget: 0,
  };
  expect(keys()).toEqual(before);
  world.ruleFeatures = [NPC_NATION_POLICY_FEATURE];
  expect(keys()).toEqual(expect.arrayContaining(['recruit', 'train', 'morale']));
  expect(reward()).toBeUndefined();
});

it('honors configured ordering, disabled actions, recruiting population and treasury limits', () => {
  const world = commandWorld();
  world.ruleFeatures = [NPC_NATION_POLICY_FEATURE];
  const nation = world.nations[1]!;
  const ruler = world.generals[1]!;
  Object.assign(ruler, { crew: 2500, train: 65, atmos: 75, gold: 9000 });
  const context = { unitSet: testUnits, tick: 100 };
  nation.npcSettings = {
    ...NPC_DEFAULT_POLICY,
    recruitTarget: 5000,
    trainingTarget: 90,
    minRecruitPopulation: 21000,
    reserveGold: 99750,
    minReward: 250,
    maxReward: 500,
    generalPriority: ['farm', 'train', 'recruit'],
    nationPriority: ['nation_reward'],
  };
  expect(generalTurnCandidates(world, ruler, context).map(({ key }) => key)).toEqual(['farm', 'train', 'rest']);
  expect(nationTurnCandidates(world, ruler, context)[0]).toMatchObject({ key: 'nation_reward', args: { amount: 250 } });
  world.cities[1]!.population = 22000;
  expect(generalTurnCandidates(world, ruler, context).map(({ key }) => key)).toContain('recruit');
  nation.npcSettings.minReward = 251;
  expect(nationTurnCandidates(world, ruler, context).map(({ key }) => key)).toEqual(['nation_rest']);
  nation.npcSettings.generalPriority = [];
  expect(generalTurnCandidates(world, ruler, context).map(({ key }) => key)).toEqual(['rest']);
});
