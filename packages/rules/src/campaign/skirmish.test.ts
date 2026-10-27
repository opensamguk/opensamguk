import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { deepFreeze } from '../personnel/testFixture';
import { simulateBattle } from '../battle/simulate';
import { fiveStatsBattleModifiers } from '../general/fiveStatsBattle';
import { emptyCampaignState } from './state';
import { fightCampaignUnits, fightCampaignWall } from './skirmish';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats'];
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, rice: 5000 });
  Object.assign(world.generals[1]!, { nationId: 1, cityKey: 1, userId: 'owner', leadership: 0, strength: 0 });
  Object.assign(world.generals[2]!, {
    nationId: 1,
    cityKey: 1,
    userId: null,
    officerLevel: 1,
    leadership: 80,
    strength: 90,
  });
  Object.assign(world.generals[3]!, { nationId: 2, cityKey: 2, leadership: 70, strength: 60 });
  world.campaign = emptyCampaignState(world, 'battle-seed', 'sourced-fixture');
  world.campaign.links = [{ masterId: 1, personId: 2, relation: 'LIEUTENANT' }];
  world.campaign.units = [
    { id: 1, ownerId: 1, commanderId: 2, troops: 1000, crewType: 1100, train: 80, atmos: 80 },
    { id: 2, ownerId: 3, commanderId: 3, troops: 1000, crewType: 1100, train: 80, atmos: 80 },
  ];
  world.campaign.nextUnitId = 3;
  return world;
}
const rng = () => rngFor('battle-test', 'skirmish', 1);
describe('AC-INT-09 부곡별 실제 교전·군량', () => {
  it('동일 시드로 같은 피해를 재현하며 소유자 쌀만 한 번 차감하고 장수 병력을 만들지 않는다', () => {
    const world = fixture(),
      before = structuredClone(world);
    const first = fightCampaignUnits(deepFreeze(world), 1, 2, testUnits, rng());
    expect(fightCampaignUnits(world, 1, 2, testUnits, rng())).toEqual(first);
    expect(first.state.generals[1]!.rice).toBe(4990);
    expect(first.state.generals[2]!.rice).toBe(5000);
    expect(first.state.generals[3]!.rice).toBe(4990);
    expect(first.state.campaign!.units[0]!.troops).toBe(first.attacker.crew);
    expect(first.state.campaign!.units[1]!.troops).toBe(first.defender.crew);
    expect(Object.values(first.state.generals).every((general) => general.crew === 0)).toBe(true);
    expect(world).toEqual(before);
  });
  it('소유자 능력치를 중첩하지 않고 실제 부장의 능력치 변경만 전투에 반영한다', () => {
    const world = fixture(),
      strongerOwner = structuredClone(world),
      weakerCommander = structuredClone(world);
    Object.assign(strongerOwner.generals[1]!, { leadership: 100, strength: 100 });
    weakerCommander.generals[2]!.strength = 0;
    const base = fightCampaignUnits(deepFreeze(world), 1, 2, testUnits, rng());
    const other = fightCampaignUnits(deepFreeze(strongerOwner), 1, 2, testUnits, rng());
    expect([other.attacker, other.defender]).toEqual([base.attacker, base.defender]);
    const weak = fightCampaignUnits(deepFreeze(weakerCommander), 1, 2, testUnits, rng());
    expect([weak.attacker, weak.defender]).not.toEqual([base.attacker, base.defender]);
  });
  it('여러 부곡이 같은 소유자 군량을 복사해 쓰지 않으며 두 번째 부족분은 실제 부곡 사기에 적용한다', () => {
    const world = fixture();
    world.generals[1]!.rice = 15;
    world.campaign!.units.push({ ...world.campaign!.units[0]!, id: 3 }, { ...world.campaign!.units[1]!, id: 4 });
    world.campaign!.nextUnitId = 5;
    const first = fightCampaignUnits(deepFreeze(world), 1, 2, testUnits, rng());
    expect(first.state.generals[1]!.rice).toBe(5);
    const next = fightCampaignUnits(deepFreeze(first.state), 3, 4, testUnits, rng());
    expect(next.state.generals[1]!.rice).toBe(0);
    expect(next.state.campaign!.units.find((unit) => unit.id === 3)!.atmos).toBeLessThanOrEqual(50);
    expect(next.state.campaign!.units.find((unit) => unit.id === 1)).toEqual(
      first.state.campaign!.units.find((unit) => unit.id === 1),
    );
    expect(next.state.generals[1]!.atmos).toBe(world.generals[1]!.atmos);
  });
  it('성벽은 실제 도시 값과 기존 병종을 쓰며 가짜 장수 보정이나 군량을 받지 않는다', () => {
    const world = fixture(),
      city = world.cities[2]!;
    city.nationId = null;
    city.wall = 1000;
    const expected = simulateBattle(
      {
        attacker: { crew: 1000, crewType: 1100, train: 80, atmos: 80 },
        defender: { crew: 1000, crewType: 1000, train: 100, atmos: 100 },
        attackerTech: world.nations[1]!.tech,
        defenderTech: 0,
        defence: city.defence,
        unitSet: testUnits,
        attackerModifiers: fiveStatsBattleModifiers({
          leadership: 80,
          strength: 90,
          intel: world.generals[2]!.intel,
          politics: 60,
          charm: 55,
        }),
      },
      rng(),
    );
    const result = fightCampaignWall(deepFreeze(world), 1, 2, testUnits, rng());
    expect([result.attacker, result.defender]).toEqual([expected.attacker, expected.defender]);
    expect(result.state.cities[2]!.wall).toBe(expected.defender.crew);
    expect(result.state.generals[1]!.rice).toBe(4990);
    expect(result.state.generals[3]).toEqual(world.generals[3]);
  });
  it('이중 배치·빈 부대·General 중복 병력·같은 국가 교전은 거부한다', () => {
    const world = fixture();
    expect(() => fightCampaignUnits(world, 1, 1, testUnits, rng())).toThrow('같은 부곡');
    expect(() => fightCampaignUnits(world, 999, 2, testUnits, rng())).toThrow('부곡 병력');
    const friendly = structuredClone(world);
    friendly.generals[3]!.nationId = 1;
    expect(() => fightCampaignUnits(friendly, 1, 2, testUnits, rng())).toThrow('다른 국가');
    world.generals[1]!.crew = 100;
    expect(() => fightCampaignUnits(world, 1, 2, testUnits, rng())).toThrow('중복');
  });
});
