import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { emptyCampaignState } from '../campaign/state';
import { fightCampaignUnits, fightCampaignWall, fightCampaignCityGarrison } from '../campaign/skirmish';
import { emptyCityResourcesState } from '../cityResources/state';
import { attack } from '../commands/attack';
import { applyEffects } from '../commands/effects';
import { deepFreeze } from '../personnel/testFixture';
import { simulateBattle, type BattleForce } from './simulate';

const paths = ['general', 'wall', 'campaign', 'campaignWall', 'garrison'] as const;
for (const enabled of [false, true]) {
  it.each(paths)(`AC-INT-22 %s는 기능 ${enabled}의 공통 계산식·효과·난수 순서를 쓴다`, (path) => {
    const world = commandWorld();
    world.ruleFeatures = ['five-stats', ...(enabled ? ['battle-affinity-v2'] : [])];
    for (const general of Object.values(world.generals))
      Object.assign(general, {
        crew: 0,
        leadership: 50,
        strength: 50,
        intel: 50,
        politics: 50,
        charm: 50,
        rice: 10000,
      });
    const unitSet = structuredClone(testUnits);
    if (enabled) {
      unitSet.coefMode = 'multiply';
      for (const row of unitSet.crewTypes) row.effects = row.armType === 1 ? ['guard5'] : ['firstVolley'];
    }
    const wall = path === 'wall' || path === 'campaignWall';
    const attacker: BattleForce = { crew: 1000, crewType: 1100, train: 80, atmos: 80 };
    const defender: BattleForce = {
      crew: 1000,
      crewType: wall ? 1000 : 1200,
      train: wall ? 100 : 80,
      atmos: wall ? 100 : 80,
    };
    world.cities[2]!.wall = 1000;
    const input = {
      attacker,
      defender,
      unitSet,
      attackerTech: 0,
      defenderTech: 0,
      ...(wall || path === 'garrison' ? { defence: world.cities[2]!.defence } : {}),
    };
    const random = () => rngFor('int22-adapter', Number(enabled), path);
    const reference = random(),
      actual = random();
    const expected = simulateBattle({ ...input, coefMode: enabled ? 'multiply' : 'divide' }, reference);
    expect(expected).not.toEqual(simulateBattle({ ...input, coefMode: enabled ? 'divide' : 'multiply' }, random()));
    if (path === 'general' || path === 'wall') {
      Object.assign(world.generals[1]!, attacker);
      if (!wall) Object.assign(world.generals[2]!, defender);
      const state = applyEffects(
        world,
        attack.execute(deepFreeze(world), { generalId: 1, tick: 100, unitSet }, { cityKey: 2 }, actual).effects,
      );
      expect(state.generals[1]).toMatchObject(expected.attacker);
      if (wall) expect(state.cities[2]!.wall).toBe(expected.defender.crew);
      else expect(state.generals[2]).toMatchObject(expected.defender);
    } else {
      world.campaign = emptyCampaignState(world, 'int22-battle', 'sourced-fixture');
      world.campaign.units = [
        {
          id: 1,
          ownerId: 1,
          commanderId: 1,
          troops: attacker.crew,
          crewType: attacker.crewType,
          train: attacker.train,
          atmos: attacker.atmos,
        },
      ];
      if (path === 'campaign')
        world.campaign.units.push({
          id: 2,
          ownerId: 2,
          commanderId: 2,
          troops: defender.crew,
          crewType: defender.crewType,
          train: defender.train,
          atmos: defender.atmos,
        });
      world.campaign.nextUnitId = world.campaign.units.length + 1;
      if (path === 'garrison') {
        world.ruleFeatures.push('city-resources-v1');
        world.cityResources = emptyCityResourcesState(world);
        Object.assign(world.cityResources.cities['2']!, {
          rice: 10000,
          garrison: [
            { crewType: defender.crewType, troops: defender.crew, train: defender.train, atmos: defender.atmos },
          ],
        });
        const result = fightCampaignCityGarrison(deepFreeze(world), 1, 2, defender.crewType, unitSet, actual);
        expect(result.state.campaign!.units[0]).toMatchObject({
          troops: expected.attacker.crew,
          atmos: expected.attacker.atmos,
        });
        expect(result.state.cityResources!.cities['2']!.garrison[0]).toMatchObject({
          troops: expected.defender.crew,
          atmos: expected.defender.atmos,
        });
      } else {
        const result = wall
          ? fightCampaignWall(deepFreeze(world), 1, 2, unitSet, actual)
          : fightCampaignUnits(deepFreeze(world), 1, 2, unitSet, actual);
        expect(result.attacker).toEqual(expected.attacker);
        expect(result.defender).toEqual(expected.defender);
      }
    }
    expect(actual.next()).toBe(reference.next());
  });
}
