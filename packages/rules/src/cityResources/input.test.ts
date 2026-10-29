import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld } from '../../test/commandFixture';
import { emptyCampaignState } from '../campaign/state';
import { TICKS_PER_MONTH } from '../clock/constants';
import { deepFreeze } from '../personnel/testFixture';
import { runMonthly, settleIncome } from '../monthly';
import { applyCityResourceIncome } from '../cityResourceIncome';
import { applyCityResourceInput, replayCityResourceInput } from './input';
import { emptyCityResourcesState } from './state';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'city-resources-v1'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  Object.assign(world.generals[1]!, { userId: 'city-owner', officerLevel: 12, cityKey: 1, nationId: 1 });
  world.campaign = emptyCampaignState(world, 'city-input', 'source-fixture');
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 0, crewType: 1100, train: 0, atmos: 0 }];
  world.campaign.nextUnitId = 2;
  world.cityResources = emptyCityResourcesState(world);
  world.cityResources.cities['1']!.garrison = [{ crewType: 1100, troops: 1000, train: 40, atmos: 60 }];
  return world;
}
const payload = { cityKey: 1, unitId: 1, crewType: 1100, amount: 500 };
const context = { tick: 100, userId: 'city-owner', userActive: true, armyTypes: [1100] };

describe('AC-INT-18B 도시 배속 입력·재생과 월 세수 연결', () => {
  it('활성 자기 장수의 입력만 적용하고 동일 기록을 재생한다', () => {
    const world = fixture(),
      before = structuredClone(world);
    const result = applyCityResourceInput(deepFreeze(world), payload, 1, context);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const record = {
      sequence: 1,
      tick: 100,
      generalId: 1,
      kind: 'city.resources',
      status: 'APPLIED' as const,
      payload,
      result: result.result,
    };
    expect(replayCityResourceInput(deepFreeze(world), record, [1100])).toEqual(result.state);
    expect(world).toEqual(before);
    expect(result.state.generals).toEqual(world.generals);
  });
  it.each(['other-user', 'inactive', 'future-actor', 'future-owner', 'bad-args', 'bad-type'] as const)(
    '%s 입력은 원장을 바꾸지 않는다',
    (kind) => {
      const world = fixture(),
        ctx = { ...context },
        args = { ...payload };
      if (kind === 'other-user') ctx.userId = 'other';
      if (kind === 'inactive') ctx.userActive = false;
      if (kind === 'future-actor') world.generals[1]!.activeFromYear = 192;
      if (kind === 'future-owner') {
        world.generals[4]!.nationId = 1;
        world.generals[4]!.cityKey = 1;
        world.generals[4]!.activeFromYear = 192;
        world.campaign!.units[0]!.ownerId = 4;
        world.campaign!.units[0]!.commanderId = 4;
      }
      if (kind === 'bad-args') args.amount = 0;
      if (kind === 'bad-type') args.crewType = 1200;
      const before = structuredClone(world);
      expect(applyCityResourceInput(deepFreeze(world), args, 1, ctx).ok).toBe(false);
      expect(world).toEqual(before);
    },
  );
  it('기록의 수량·시각·revision 변조를 거부하며 거절 기록은 상태를 유지한다', () => {
    const world = fixture(),
      result = applyCityResourceInput(world, payload, 1, context);
    if (!result.ok) throw new Error(result.message);
    const record = {
      sequence: 1,
      tick: 100,
      generalId: 1,
      kind: 'city.resources',
      status: 'APPLIED' as const,
      payload,
      result: result.result,
    };
    for (const key of ['amount', 'tick', 'revision'] as const) {
      const forged = structuredClone(record);
      forged.result[key]++;
      expect(() => replayCityResourceInput(world, forged, [1100])).toThrow();
    }
    expect(
      replayCityResourceInput(
        world,
        { ...record, status: 'REJECTED', result: { code: 'NO_CREW', message: '부족' } },
        [1100],
      ),
    ).toBe(world);
  });
  it.each([1, 4, 7, 10])('%s월은 인구 정산 전에 기존 급여 뒤의 도시 세수를 적립한다', (month) => {
    const world = fixture(),
      date = { year: 191, month };
    const expected = applyCityResourceIncome(world, settleIncome(world, date), date);
    const result = runMonthly(deepFreeze(world), month * TICKS_PER_MONTH, rngFor('city-month', month));
    expect(result.state.cityResources).toEqual(expected.cityResources);
    expect(result.state.generals[1]!.gold).toBe(expected.generals[1]!.gold);
    expect(result.state.generals[1]!.rice).toBe(expected.generals[1]!.rice);
    expect(result.state.nations[1]!.gold).toBe(world.nations[1]!.gold);
    expect(result.state.nations[1]!.rice).toBe(world.nations[1]!.rice);
  });
});
