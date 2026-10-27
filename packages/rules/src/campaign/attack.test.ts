import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { deepFreeze } from '../personnel/testFixture';
import { campaignAttack } from './attack';
import { emptyCampaignState } from './state';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  world.generals[1]!.userId = 'owner';
  world.campaign = emptyCampaignState(world, 'attack-fixture', 'sourced-fixture');
  world.campaign.units = [
    { id: 1, ownerId: 1, commanderId: 1, troops: 9000, crewType: 1100, train: 100, atmos: 100 },
    { id: 2, ownerId: 2, commanderId: 2, troops: 20, crewType: 1100, train: 100, atmos: 100 },
    { id: 3, ownerId: 3, commanderId: 3, troops: 10, crewType: 1100, train: 100, atmos: 100 },
  ];
  world.campaign.nextUnitId = 4;
  return world;
}
const actor = { generalId: 1, tick: 100, unitSet: testUnits };
function run(world = fixture()) {
  expect(campaignAttack.check(world, actor, { cityKey: 2 })).toBeNull();
  const result = campaignAttack.execute(deepFreeze(world), actor, { cityKey: 2 }, rngFor('campaign-attack', 1));
  return { result, state: applyEffects(world, result.effects) };
}
describe('AC-INT-09 부곡 출병·점령', () => {
  it('수비 둘과 성벽을 순서대로 교전하고 마지막 도시 멸망·전공·보고를 기록한다', () => {
    const world = fixture(),
      before = structuredClone(world);
    const { state, result } = run(world);
    expect(state.cities[2]!.nationId).toBe(1);
    expect(state.cities[2]!.wall).toBe(0);
    expect(state.generals[1]!.cityKey).toBe(2);
    expect(state.nations[2]).toBeUndefined();
    expect(state.generals[2]!.nationId).toBeNull();
    expect(state.generals[3]!.nationId).toBeNull();
    expect(result.reports?.map((row) => row.generalId)).toEqual([2, 3]);
    expect(result.battleAwards).toContainEqual({ generalId: 1, wins: 0, captures: 1 });
    expect(result.history?.some((row) => row.text.includes('멸망'))).toBe(true);
    expect(Object.values(state.generals).every((general) => general.crew === 0)).toBe(true);
    expect(world).toEqual(before);
    expect(run(before)).toEqual({ state, result });
  });
  it('부장 지휘로 관문을 점령해도 국가는 도시를 잃기 전까지 남고 사람 휘하는 이동하지 않는다', () => {
    const world = fixture();
    Object.assign(world.generals[4]!, { nationId: 1, cityKey: 1, officerLevel: 1 });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    world.campaign!.units[0]!.commanderId = 4;
    world.cities[2]!.kind = 'PASS';
    world.cities[3]!.nationId = 2;
    const { state } = run(world);
    expect(state.cities[2]!.nationId).toBe(1);
    expect(state.nations[2]!.capitalCityKey).toBe(3);
    expect(state.generals[4]!.cityKey).toBe(2);
    expect(state.generals[4]!.rice).toBe(world.generals[4]!.rice);
    expect(state.generals[1]!.rice).toBeLessThan(world.generals[1]!.rice);
  });
  it('같은 거점의 자기 부곡만 출병하며 남의 병력·떨어진 지휘관을 끌어오지 않는다', () => {
    const world = fixture();
    Object.assign(world.generals[4]!, { nationId: 1, cityKey: 4, officerLevel: 1 });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    world.campaign!.units[0]!.commanderId = 4;
    expect(campaignAttack.check(world, actor, { cityKey: 2 })?.code).toBe('NO_CREW');
    world.campaign!.units.push({ ...world.campaign!.units[0]!, id: 4, ownerId: 4, commanderId: 4, troops: 100 });
    world.campaign!.nextUnitId = 5;
    expect(campaignAttack.check(world, actor, { cityKey: 2 })?.code).toBe('NO_CREW');
  });
  it('전쟁·인접·보급·자국 목적지와 병종 오류는 RNG나 군량을 쓰기 전에 거부한다', () => {
    const world = fixture();
    world.diplomacies = [];
    expect(campaignAttack.check(world, actor, { cityKey: 2 })?.code).toBe('NOT_WAR');
    expect(campaignAttack.check(world, actor, { cityKey: 4 })?.code).toBe('BAD_TARGET');
    expect(campaignAttack.check(world, actor, { cityKey: 3 })?.code).toBe('NOT_ADJACENT');
    world.cities[1]!.supplied = false;
    expect(campaignAttack.check(world, actor, { cityKey: 2 })?.code).toBe('NO_SUPPLY');
    world.cities[1]!.supplied = true;
    world.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
    expect(campaignAttack.check(world, { ...actor, unitSet: undefined }, { cityKey: 2 })?.code).toBe('NO_UNIT_SET');
  });
  it('첫 부곡이 패하면 다음 부곡이 같은 수비를 교전하고 쌀을 공유한다', () => {
    const world = fixture();
    Object.assign(world.generals[4]!, { nationId: 1, cityKey: 1, officerLevel: 1 });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    world.campaign!.units[0]!.troops = 1;
    world.campaign!.units[1]!.troops = 100;
    world.campaign!.units.push({ ...world.campaign!.units[0]!, id: 4, commanderId: 4, troops: 9000 });
    world.campaign!.nextUnitId = 5;
    const { state, result } = run(world);
    expect(state.campaign!.units[0]!.troops).toBe(0);
    expect(result.reports?.filter((row) => row.generalId === 2)).toHaveLength(1);
    expect(result.reports?.find((row) => row.generalId === 2)!.text).toContain('부곡1');
    expect(result.reports?.find((row) => row.generalId === 2)!.text).toContain('부곡4');
    expect(new Set(result.reports?.map((row) => row.generalId)).size).toBe(result.reports!.length);
    expect(state.cities[2]!.nationId).toBe(1);
    expect(state.generals[1]!.rice).toBeLessThan(world.generals[1]!.rice - 90);
  });
  it('양쪽이 전멸하거나 공격 사기가 소진되면 빈 성도 점령하지 않는다', () => {
    const world = fixture();
    world.campaign!.units[0]!.troops = 1;
    world.campaign!.units[1]!.troops = 1;
    world.campaign!.units[2]!.troops = 0;
    world.cities[2]!.wall = 0;
    const { state } = run(world);
    expect(state.cities[2]!.nationId).toBe(2);
    expect(state.generals[1]!.cityKey).toBe(1);
    expect(state.nations[2]).toBeDefined();
  });
  it('성벽0·무수비 도시도 기존 출병의 점령 직전 군량을 한 번 차감한다', () => {
    const world = fixture();
    world.campaign!.units[1]!.troops = 0;
    world.campaign!.units[2]!.troops = 0;
    world.cities[2]!.wall = 0;
    const { state } = run(world);
    expect(state.cities[2]!.nationId).toBe(1);
    expect(state.generals[1]!.rice).toBe(world.generals[1]!.rice - 90);
    expect(state.campaign!.revision).toBe(1);
  });
});
