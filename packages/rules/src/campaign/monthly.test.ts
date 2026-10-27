import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld } from '../../test/commandFixture';
import { BALANCE } from '../balance';
import { buildYearbook, runMonthly, settleSupply } from '../monthly';
import { deepFreeze } from '../personnel/testFixture';
import { emptyCampaignState } from './state';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['campaign-v1', 'five-stats'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  Object.assign(world.generals[4]!, { nationId: 1, cityKey: 4, officerLevel: 1 });
  world.campaign = emptyCampaignState(world, 'monthly-seed', 'sourced-fixture');
  world.campaign.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
  world.campaign.units = [
    { id: 1, ownerId: 1, commanderId: 1, troops: 1000, crewType: 1100, train: 80, atmos: 80 },
    { id: 2, ownerId: 1, commanderId: 4, troops: 2000, crewType: 1100, train: 80, atmos: 80 },
  ];
  world.campaign.nextUnitId = 3;
  return world;
}
describe('AC-INT-09 기존 월 정산의 부곡 연결', () => {
  it('단절 보급의 훈련·사기 손실은 실제 지휘관 거점의 부곡에 한 번만 적용한다', () => {
    const world = fixture(),
      before = structuredClone(world);
    const next = settleSupply(deepFreeze(world));
    expect(next.campaign!.units[0]).toEqual(world.campaign!.units[0]);
    expect(next.campaign!.units[1]!.train).toBe(80 - BALANCE.UNSUPPLIED_TRAIN_LOSS);
    expect(next.campaign!.units[1]!.atmos).toBe(80 - BALANCE.UNSUPPLIED_ATMOS_LOSS);
    expect(next.campaign!.revision).toBe(1);
    expect(next.generals[1]!.train).toBe(world.generals[1]!.train);
    expect(next.generals[4]!.train).toBe(world.generals[4]!.train);
    expect(world).toEqual(before);
  });
  it('국력은 소유 부곡 병력을 한 번 합산하며 미등장 지휘관은 제외한다', () => {
    const world = fixture();
    const baseline = structuredClone(world);
    delete baseline.campaign;
    delete baseline.ruleFeatures;
    expect(buildYearbook(world, 191).nations[0]!.power - buildYearbook(baseline, 191).nations[0]!.power).toBe(3000);
    world.generals[4]!.activeFromYear = 200;
    expect(buildYearbook(world, 191).nations[0]!.power - buildYearbook(baseline, 191).nations[0]!.power).toBe(1000);
  });
  it('월급·세입과 기존 군량은 보존하고 새 월 유지비나 휴대 군량을 만들지 않는다', () => {
    const world = fixture();
    const legacy = structuredClone(world);
    delete legacy.ruleFeatures;
    delete legacy.campaign;
    const source = () => rngFor('monthly-seed', 'monthly', 191, 1);
    const next = runMonthly(deepFreeze(world), 10000, source()).state;
    const original = runMonthly(deepFreeze(legacy), 10000, source()).state;
    expect(next.nations).toEqual(original.nations);
    for (const general of Object.values(next.generals)) {
      expect(general.rice).toBe(original.generals[general.id]!.rice);
      expect(general.gold).toBe(original.generals[general.id]!.gold);
      expect(general.crew).toBe(0);
    }
    expect(next.campaign!.units.every((unit) => !Object.hasOwn(unit, 'rice'))).toBe(true);
  });
});
