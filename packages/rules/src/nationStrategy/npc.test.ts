import { expect, it } from 'vitest';
import { createRng } from '@opensamguk/shared';
import { commandWorld } from '../../test/commandFixture';
import { chooseNationTurn } from '../npc';
import { resolverForRuleFeatures } from '../ruleCommands';
import { initialNationStrategy } from './state';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['nation-strategy-v1', 'personnel'];
  world.nationStrategy = initialNationStrategy();
  Object.assign(world.nations[1]!, { isNpc: true, gold: 0 });
  for (const city of Object.values(world.cities))
    if (city.nationId === 1) Object.assign(city, { defence: city.defenceMax, wall: city.wallMax });
  return world;
}
const choose = (world: ReturnType<typeof fixture>) =>
  chooseNationTurn(world, world.generals[1]!, createRng('strategy-npc'), {
    tick: 0,
    resolver: resolverForRuleFeatures(world),
  });

it('NPC는 부족한 거점을 보강하고 강한 교전국을 늦추며 우세하면 선포를 앞당긴다', () => {
  const defend = fixture();
  defend.cities[1]!.defence = 0;
  expect(choose(defend).chosen?.key).toBe('nation_mobilize');
  const delay = fixture();
  delay.generals[1]!.crew = 0;
  delay.generals[2]!.crew = 10000;
  expect(choose(delay).chosen?.key).toBe('nation_rivalry');
  const raid = fixture();
  Object.assign(raid.diplomacies[0]!, { state: 'DECLARED', untilTick: 10000 });
  expect(choose(raid).chosen?.key).toBe('nation_raid');
});

it('기능이나 대기가 막히면 NPC 후보에 전략을 넣지 않는다', () => {
  const world = fixture();
  world.cities[1]!.defence = 0;
  world.nationStrategy!.nations[1] = { strategicUntil: 9, commands: {} };
  expect(choose(world).candidates.some((row) => row.key === 'nation_mobilize')).toBe(false);
  delete world.nationStrategy;
  world.ruleFeatures = ['personnel'];
  expect(
    choose(world).candidates.some(
      (row) => row.key.startsWith('nation_mob') || row.key === 'nation_raid' || row.key === 'nation_rivalry',
    ),
  ).toBe(false);
});
