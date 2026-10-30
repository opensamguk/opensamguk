import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { createCommandResolver } from '../commands/resolve';
import { createCampaignCommandResolver } from '../campaign/commands';
import { emptyCampaignState } from '../campaign/state';
import { applyEffects } from '../commands/effects';
import { chooseGeneralTurn, chooseNationTurn } from '../npc';
import { deepFreeze } from '../personnel/testFixture';
import { createCityResourceCommandResolver } from './commands';
import { emptyCityResourcesState } from './state';
import { runGeneralTurn } from '../commands/turn';

const base = createCampaignCommandResolver(createCommandResolver(null));
const resolver = createCityResourceCommandResolver(base);
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'city-resources-v1'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  Object.assign(world.generals[1]!, {
    userId: null,
    officerLevel: 12,
    cityKey: 1,
    nationId: 1,
    gold: 100_000,
    rice: 100_000,
  });
  world.nations[1]!.isNpc = true;
  world.campaign = emptyCampaignState(world, 'npc-city', 'source-fixture');
  world.cityResources = emptyCityResourcesState(world);
  world.cityResources.cities['1']!.gold = 100_000;
  world.cityResources.cities['1']!.rice = 100_000;
  return world;
}
const actor = { generalId: 1, tick: 100, unitSet: testUnits };
const random = () => rngFor('npc-city', 1);

describe('AC-INT-18A/B 도시 명령 연결과 실제 NPC 의사결정', () => {
  it('도시 모병은 부곡을 만들지 않고 빈 부곡 편성도 병력을 만들지 않는다', () => {
    const world = fixture(),
      before = structuredClone(world);
    const recruited = resolver.run(deepFreeze(world), actor, 'recruit', { amount: 1000, crewType: 1100 }, random());
    if ('code' in recruited) throw new Error(recruited.message);
    const next = applyEffects(world, recruited.effects);
    expect(next.campaign!.units).toEqual([]);
    expect(next.cityResources!.cities['1']!.garrison[0]!.troops).toBe(1000);
    const formed = resolver.run(deepFreeze(next), actor, 'form_unit', { crewType: 1100 }, random());
    if ('code' in formed) throw new Error(formed.message);
    const final = applyEffects(next, formed.effects);
    expect(final.campaign!.units[0]).toMatchObject({ troops: 0, ownerId: 1, commanderId: 1 });
    expect(final.cityResources).toEqual(next.cityResources);
    expect(world).toEqual(before);
  });
  it('부곡 대상 훈련은 기존 개인 금을 쓰고 도시 대상 훈련만 도시 금을 쓴다', () => {
    const world = fixture();
    world.campaign!.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 0, atmos: 50 }];
    world.campaign!.nextUnitId = 2;
    world.cityResources!.cities['1']!.garrison = [{ crewType: 1100, troops: 100, train: 0, atmos: 50 }];
    for (const [args, personal] of [
      [{ unitId: 1 }, true],
      [{ target: 'city', crewType: 1100 }, false],
    ] as const) {
      const result = resolver.run(deepFreeze(world), actor, 'train', args, random());
      if ('code' in result) throw new Error(result.message);
      const next = applyEffects(world, result.effects);
      expect(next.generals[1]!.gold < world.generals[1]!.gold).toBe(personal);
      expect(next.cityResources!.cities['1']!.gold < world.cityResources!.cities['1']!.gold).toBe(!personal);
    }
  });
  it('휘하 NPC의 독립 군사 명령 차단을 도시 준비에도 보존한다', () => {
    const world = fixture();
    world.generals[4]!.nationId = 1;
    world.generals[4]!.cityKey = 1;
    world.campaign!.links = [{ masterId: 4, personId: 1, relation: 'STAFF' }];
    expect(resolver.precheck(world, actor, 'recruit', { amount: 1, crewType: 1100 })).toMatchObject({
      code: 'COMMAND_DISABLED',
    });
  });
  it('NPC는 같은 비용 함수로 모집→빈 부곡→도시 준비→국가 배속→출병까지 이어 간다', () => {
    let world = fixture();
    const chosen: string[] = [];
    const context = { tick: 100, unitSet: testUnits, resolver, convergence: false };
    const initialPopulation = world.cities[1]!.population,
      initialGold = world.cityResources!.cities['1']!.gold;
    let allocated = false;
    for (let step = 0; step < 40; step++) {
      const nation = chooseNationTurn(world, world.generals[1]!, random(), context).chosen;
      if (nation?.key === 'nation_city_allocate') {
        const result = resolver.run(
          deepFreeze(world),
          { ...actor, target: 'nation' },
          nation.key,
          nation.args,
          random(),
        );
        if ('code' in result) throw new Error(result.message);
        world = applyEffects(world, result.effects);
        chosen.push(nation.key);
        allocated = true;
      }
      const general = chooseGeneralTurn(world, world.generals[1]!, random(), context).chosen;
      if (!general) throw new Error('NPC 명령 없음');
      chosen.push(general.key);
      const result = resolver.run(deepFreeze(world), actor, general.key, general.args, random());
      if ('code' in result) throw new Error(result.message);
      world = applyEffects(world, result.effects);
      if (general.key === 'attack') break;
    }
    expect(chosen[0]).toBe('recruit');
    expect(chosen).toContain('form_unit');
    expect(chosen).toContain('morale');
    expect(chosen).toContain('train');
    expect(allocated).toBe(true);
    expect(chosen).toContain('attack');
    expect(world.cities[1]!.population).toBeLessThan(initialPopulation);
    expect(world.cityResources!.cities['1']!.gold).toBeLessThan(initialGold);
    expect(Object.values(world.generals).every((general) => general.crew === 0)).toBe(true);
  });
  it('NPC 국가 배속은 실제 직책 예약 한 칸을 쓰며 사람 예약을 바꾸지 않는다', () => {
    const world = fixture();
    world.campaign!.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 0, crewType: 1100, train: 0, atmos: 0 }];
    world.campaign!.nextUnitId = 2;
    world.cityResources!.cities['1']!.garrison = [{ crewType: 1100, troops: 2000, train: 60, atmos: 70 }];
    const result = runGeneralTurn(
      deepFreeze(world),
      actor,
      { commandKey: 'rest', args: {} },
      'npc-city',
      {},
      resolver,
      { offices: { 1: { 12: { revision: 0, tenure: 0 } } } },
    );
    expect(result.nation?.commandKey).toBe('nation_city_allocate');
    expect(result.nation?.result).not.toHaveProperty('code');
    expect(result.personnel!.offices[1]![12]!.revision).toBe(1);
    expect(world.campaign!.units[0]!.troops).toBe(0);
  });
  it('같은 빈 부곡을 중복 편성하거나 구판에 새 resolver를 강제 적용할 수 없다', () => {
    const world = fixture();
    const result = resolver.run(world, actor, 'form_unit', { crewType: 1100 }, random());
    if ('code' in result) throw new Error(result.message);
    const next = applyEffects(world, result.effects);
    expect(resolver.precheck(next, actor, 'form_unit', { crewType: 1100 })).toMatchObject({ code: 'BAD_STATE' });
    next.ruleFeatures = ['five-stats'];
    expect(resolver.precheck(next, actor, 'form_unit', { crewType: 1100 })).toMatchObject({ code: 'COMMAND_DISABLED' });
  });
});
