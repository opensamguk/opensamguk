import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { deepFreeze } from '../personnel/testFixture';
import { recruitCost, drillGain } from '../commands/statScores';
import { BALANCE } from '../balance';
import { emptyCampaignState } from './state';
import { applyCampaignPreparation } from './preparation';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats'];
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, cityKey: 1 });
  Object.assign(world.generals[1]!, { userId: 'owner', nationId: 1, gold: 1_000_000, rice: 1234, leadership: 1 });
  Object.assign(world.generals[2]!, { userId: null, nationId: 1, officerLevel: 1, leadership: 80, charm: 90 });
  world.campaign = emptyCampaignState(world, 'preparation-seed', 'sourced-fixture');
  world.campaign.links = [{ masterId: 1, personId: 2, relation: 'LIEUTENANT' }];
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 2, troops: 1000, crewType: 1100, train: 60, atmos: 80 }];
  world.campaign.nextUnitId = 2;
  return world;
}
const actor = { generalId: 1, tick: 0, unitSet: testUnits };
function applied<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return outcome as Extract<T, { ok: true }>;
}
describe('AC-INT-09 부곡 병력 정본의 기존 준비 명령', () => {
  it.each(['recruit', 'conscript'] as const)(
    '%s는 기존 비용·인구·훈련 희석을 한 번 적용하고 General 병력을 만들지 않는다',
    (key) => {
      const world = fixture(),
        before = structuredClone(world),
        owner = world.generals[1]!;
      const result = applied(
        applyCampaignPreparation(deepFreeze(world), actor, key, { amount: 1000, crewType: 1100, unitId: 1 }),
      );
      expect(result.state.campaign!.units[0]).toMatchObject({ troops: 2000, train: 30, atmos: 40 });
      expect(result.state.generals[1]!.gold).toBe(
        owner.gold -
          recruitCost(
            world,
            owner,
            1000,
            testUnits.crewTypes.find((unit) => unit.id === 1100)!.cost,
            key === 'conscript',
          ),
      );
      expect(result.state.cities[1]!.population).toBe(world.cities[1]!.population - 1000);
      expect(result.state.cities[1]!.trust).toBe(
        world.cities[1]!.trust - (key === 'conscript' ? BALANCE.CONSCRIPT_TRUST_LOSS : 0),
      );
      expect(result.state.generals[1]!.rice).toBe(1234);
      expect(Object.values(result.state.generals).every((general) => general.crew === 0)).toBe(true);
      expect(world).toEqual(before);
    },
  );
  it('요청 밖의 같은 지휘관 부곡도 합산해 통솔 상한 분할을 거부한다', () => {
    const world = fixture();
    world.campaign!.units.push({
      id: 2,
      ownerId: 1,
      commanderId: 2,
      troops: 6000,
      crewType: 1100,
      train: 50,
      atmos: 50,
    });
    world.campaign!.nextUnitId = 3;
    expect(
      applyCampaignPreparation(deepFreeze(world), actor, 'recruit', { amount: 1001, crewType: 1100, unitId: 1 }),
    ).toMatchObject({ ok: false, code: 'AT_MAX' });
  });
  it.each(['train', 'morale'] as const)(
    '%s는 실제 부장의 산식과 소유자 비용만 쓰고 다른 부곡을 바꾸지 않는다',
    (key) => {
      const world = fixture(),
        before = structuredClone(world.campaign!.units);
      world.campaign!.units.push({
        id: 2,
        ownerId: 1,
        commanderId: 1,
        troops: 100,
        crewType: 1100,
        train: 40,
        atmos: 30,
      });
      world.campaign!.nextUnitId = 3;
      const other = structuredClone(world.campaign!.units[1]);
      const result = applied(applyCampaignPreparation(deepFreeze(world), actor, key, { unitId: 1 }));
      const field = key === 'train' ? 'train' : 'atmos';
      expect(result.state.campaign!.units[0]![field]).toBe(
        before[0]![field] + drillGain(world, world.generals[2]!, key === 'morale'),
      );
      expect(result.state.campaign!.units[1]).toEqual(other);
      expect(result.state.generals[1]!.gold).toBe(world.generals[1]!.gold - BALANCE.DRILL_COST);
      expect(result.state.generals[2]).toEqual(world.generals[2]);
    },
  );
  it('소집해제는 선택 부곡 병력만 기존 인구 상한 안에서 돌려주며 군량을 복제하지 않는다', () => {
    const world = fixture();
    const result = applied(applyCampaignPreparation(deepFreeze(world), actor, 'dismiss', { unitId: 1 }));
    expect(result.state.campaign!.units[0]).toMatchObject({ troops: 0, train: 0, atmos: 0 });
    expect(result.state.cities[1]!.population).toBe(
      Math.min(world.cities[1]!.populationMax, world.cities[1]!.population + 1000),
    );
    expect(result.state.generals).toEqual(world.generals);
  });
  it('초기 NPC/사람 모병은 자기 지휘 첫 부곡을 만들되 능력치·군량을 복사하지 않는다', () => {
    const world = fixture();
    world.campaign!.units = [];
    const result = applied(
      applyCampaignPreparation(deepFreeze(world), actor, 'recruit', { amount: 100, crewType: 1100 }),
    );
    expect(result.state.campaign!.units).toEqual([
      { id: 2, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 0, atmos: 0 },
    ]);
    expect(result.state.generals[1]).toMatchObject({ crew: 0, rice: 1234, leadership: 1 });
  });
  it('다른 소유 부곡·다른 거점·중복 General 병력·자원 부족을 거부한다', () => {
    const world = fixture();
    expect(applyCampaignPreparation(world, actor, 'train', { unitId: 999 })).toMatchObject({
      ok: false,
      code: 'BAD_TARGET',
    });
    world.generals[1]!.gold = 0;
    expect(applyCampaignPreparation(world, actor, 'train', { unitId: 1 })).toMatchObject({
      ok: false,
      code: 'NO_GOLD',
    });
    world.generals[2]!.cityKey = 2;
    expect(applyCampaignPreparation(world, actor, 'train', { unitId: 1 })).toMatchObject({
      ok: false,
      code: 'BAD_STATE',
    });
    world.generals[1]!.crew = 100;
    expect(() => applyCampaignPreparation(world, actor, 'train', { unitId: 1 })).toThrow('중복');
  });
});
