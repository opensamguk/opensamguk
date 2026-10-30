import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { BALANCE } from '../balance';
import { emptyCampaignState } from '../campaign/state';
import { fightCampaignCityGarrison } from '../campaign/skirmish';
import { campaignAttack } from '../campaign/attack';
import { simulateBattle } from '../battle/simulate';
import { fiveStatsBattleModifiers } from '../general/fiveStatsBattle';
import { applyEffects } from '../commands/effects';
import { deepFreeze } from '../personnel/testFixture';
import { disbandCityGarrison } from './ownership';
import { emptyCityResourcesState } from './state';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'city-resources-v1'];
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, rice: 10_000 });
  world.campaign = emptyCampaignState(world, 'city-defense', 'sourced-fixture');
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 1000, crewType: 1100, train: 80, atmos: 80 }];
  world.campaign.nextUnitId = 2;
  world.cityResources = emptyCityResourcesState(world);
  Object.assign(world.cityResources.cities['2']!, {
    gold: 123,
    rice: 1000,
    garrison: [{ crewType: 1100, troops: 1000, train: 0, atmos: 80 }],
  });
  world.cities[2]!.wall = 500;
  return world;
}
const rng = () => rngFor('city-defense', 1);
const actor = { generalId: 1, tick: 100, unitSet: testUnits };

describe('AC-INT-18A 실제 도시 수비병·군량·점령', () => {
  it('훈련0 수비병도 실제 교전하며 가짜 인물 보정 없이 동일 시드를 재현한다', () => {
    const world = fixture(),
      before = structuredClone(world),
      general = world.generals[1]!;
    const expected = simulateBattle(
      {
        attacker: { crew: 1000, crewType: 1100, train: 80, atmos: 80 },
        defender: { crew: 1000, crewType: 1100, train: 0, atmos: 80 },
        attackerTech: world.nations[1]!.tech,
        defenderTech: world.nations[2]!.tech,
        defence: world.cities[2]!.defence,
        unitSet: testUnits,
        attackerModifiers: fiveStatsBattleModifiers({
          leadership: general.leadership,
          strength: general.strength,
          intel: general.intel,
          politics: 60,
          charm: 55,
        }),
      },
      rng(),
    );
    const first = fightCampaignCityGarrison(deepFreeze(world), 1, 2, 1100, testUnits, rng());
    expect(first.state.campaign!.units[0]).toMatchObject({
      troops: expected.attacker.crew,
      atmos: expected.attacker.atmos,
    });
    expect(first.state.cityResources!.cities['2']!.garrison[0]).toMatchObject({
      troops: expected.defender.crew,
      atmos: expected.defender.atmos,
    });
    expect(fightCampaignCityGarrison(world, 1, 2, 1100, testUnits, rng())).toEqual(first);
    expect(first.state.cityResources!.cities['2']!.rice).toBe(1000 - Math.ceil(1000 * BALANCE.BATTLE_RICE_PER_CREW));
    expect(first.state.generals[1]!.rice).toBe(10_000 - Math.ceil(1000 * BALANCE.BATTLE_RICE_PER_CREW));
    expect(first.state.generals[2]).toEqual(world.generals[2]);
    expect(first.state.cityResources!.cities['2']!.gold).toBe(123);
    expect(first.state.cities[2]!.wall).toBe(500);
    expect(world).toEqual(before);
  });
  it('도시 쌀 부족으로 사기0이면 패주·민간 복귀를 기록하고 공격 군량·RNG를 쓰지 않는다', () => {
    const world = fixture();
    world.cityResources!.cities['2']!.rice = 0;
    world.cityResources!.cities['2']!.garrison[0]!.atmos = 1;
    world.cities[2]!.population = world.cities[2]!.populationMax - 10;
    let calls = 0;
    const random = rng();
    const saved = random.next.bind(random);
    random.next = () => {
      calls++;
      return saved();
    };
    const result = fightCampaignCityGarrison(deepFreeze(world), 1, 2, 1100, testUnits, random);
    expect(result.state.cityResources!.cities['2']!.garrison).toEqual([]);
    expect(result.state.cities[2]!.population).toBe(world.cities[2]!.populationMax);
    expect(result.text).toContain('민간 복귀 10명');
    expect(result.text).toContain('상한 밖 990명');
    expect(result.state.generals[1]!.rice).toBe(world.generals[1]!.rice);
    expect(calls).toBe(0);
  });
  it('함락 잔여병 해산은 금·쌀·부곡을 보존하고 인구 상한을 넘기지 않는다', () => {
    const world = fixture();
    world.cities[2]!.population = world.cities[2]!.populationMax - 100;
    const before = structuredClone(world);
    const result = disbandCityGarrison(deepFreeze(world), 2);
    expect(result.troops).toBe(1000);
    expect(result.state.cityResources!.cities['2']).toEqual({ gold: 123, rice: 1000, garrison: [] });
    expect(result.state.cities[2]!.population).toBe(world.cities[2]!.populationMax);
    expect(result.text).toContain('상한 밖 900명');
    expect(result.state.campaign).toEqual(world.campaign);
    expect(result.state.generals).toEqual(world.generals);
    expect(result.state.nations).toEqual(world.nations);
    expect(world).toEqual(before);
  });
  it('살아 있는 도시 수비병이 남으면 성벽0이어도 점령하지 않는다', () => {
    const world = fixture();
    world.campaign!.units[0]!.troops = 1;
    world.cities[2]!.wall = 0;
    world.cityResources!.cities['2']!.garrison[0]!.troops = 100_000;
    const result = campaignAttack.execute(deepFreeze(world), actor, { cityKey: 2 }, rng());
    const state = applyEffects(world, result.effects);
    expect(state.cities[2]!.nationId).toBe(2);
    expect(state.cityResources!.cities['2']!.garrison[0]!.troops).toBeGreaterThan(0);
    expect(result.logs[0]!.text).toContain('점령 실패');
  });
  it('부곡 다음 도시 병종 다음 성벽을 교전하고 금·쌀을 같은 도시에 남긴다', () => {
    const world = fixture();
    world.campaign!.units[0]!.troops = 9000;
    world.campaign!.units.push({
      id: 2,
      ownerId: 2,
      commanderId: 2,
      troops: 1,
      crewType: 1100,
      train: 100,
      atmos: 100,
    });
    world.campaign!.nextUnitId = 3;
    world.cityResources!.cities['2']!.garrison[0]!.troops = 1;
    world.cities[2]!.wall = 1;
    const result = campaignAttack.execute(deepFreeze(world), actor, { cityKey: 2 }, rng());
    const state = applyEffects(world, result.effects),
      text = result.logs[0]!.text;
    expect(text.indexOf('대 ' + world.generals[2]!.name)).toBeLessThan(text.indexOf('대 도시 병종'));
    expect(text.indexOf('대 도시 병종')).toBeLessThan(text.indexOf('성벽 교전'));
    expect(state.cities[2]!.nationId).toBe(1);
    expect(state.cityResources!.cities['2']).toEqual({ gold: 123, rice: 999, garrison: [] });
    expect(state.generals[2]!.rice).toBe(9999);
    expect(state.nations[1]!.gold).toBe(world.nations[1]!.gold);
    expect(state.generals[1]!.gold).toBe(world.generals[1]!.gold);
  });
  it('기존 기능 판에서 도시 교전을 호출하거나 자국 도시를 공격하면 거부한다', () => {
    const world = fixture();
    world.ruleFeatures = ['five-stats'];
    expect(() => fightCampaignCityGarrison(world, 1, 2, 1100, testUnits, rng())).toThrow('규칙');
    world.ruleFeatures.push('city-resources-v1');
    world.cities[2]!.nationId = 1;
    expect(() => fightCampaignCityGarrison(world, 1, 2, 1100, testUnits, rng())).toThrow('서로 다른');
  });
  it('마지막 경제 도시 함락으로 중립화된 관문 병력도 해산해 다음 공격을 막지 않는다', () => {
    const world = fixture();
    world.campaign!.units[0]!.troops = 9000;
    world.cityResources!.cities['2']!.garrison = [];
    world.cities[2]!.wall = 0;
    Object.assign(world.cities[3]!, { kind: 'PASS', nationId: 2, wall: 0 });
    world.cities[2]!.connections.push(3);
    world.cityResources!.cities['3'] = {
      gold: 17,
      rice: 19,
      garrison: [{ crewType: 1100, troops: 20, train: 0, atmos: 80 }],
    };
    const captured = applyEffects(
      world,
      campaignAttack.execute(deepFreeze(world), actor, { cityKey: 2 }, rng()).effects,
    );
    expect(captured.cities[3]!.nationId).toBeNull();
    expect(captured.cityResources!.cities['3']).toEqual({ gold: 17, rice: 19, garrison: [] });
    expect(campaignAttack.check(captured, actor, { cityKey: 3 })).toBeNull();
    const next = applyEffects(
      captured,
      campaignAttack.execute(deepFreeze(captured), actor, { cityKey: 3 }, rng()).effects,
    );
    expect(next.cities[3]!.nationId).toBe(1);
    expect(next.cityResources!.cities['3']).toEqual({ gold: 17, rice: 19, garrison: [] });
  });
});
