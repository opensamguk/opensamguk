import { describe, expect, it } from 'vitest';
import { CITY_RESOURCE_MAX, emptyCityResourcesState } from '../cityResources/state';
import { cloneWorld } from '../model/clone';
import { deepFreeze } from '../personnel/testFixture';
import { assertGovernanceConserved } from './ledger';
import { settleGovernanceMonthly } from './monthly';
import { governanceFixture, vassal } from './testFixture';

function fixture() {
  const world = governanceFixture();
  for (const general of Object.values(world.generals)) general.userId = `person-${general.id}`;
  world.cityResources = emptyCityResourcesState(world);
  for (const city of Object.values(world.cityResources.cities)) {
    city.gold = 1000;
    city.rice = 1000;
  }
  world.governance!.throne = { emperorGeneralId: 1, emperorNationId: 1, sinceTick: 0 };
  world.governance!.vassals = [vassal(1, 3, 2), vassal(2, 2, 1)];
  world.governance!.nextVassalId = 3;
  return world;
}
describe('AC-P2-31 황실 단계 안의 공납·봉록 보존', () => {
  it('단계 시작 잔액에서 공납을 계산해 같은 달 받은 금의 재과세를 막는다', () => {
    const world = fixture();
    world.governance!.court.chancellor = { generalId: 3, appointedTick: 0 };
    const before = deepFreeze(world),
      result = settleGovernanceMonthly(before, 10_000);
    expect(result.state.cityResources!.cities['1']!.gold).toBe(950);
    expect(result.state.cityResources!.cities['2']!.gold).toBe(1000);
    expect(result.state.cityResources!.cities['3']!.gold).toBe(950);
    expect(result.state.generals[3]!.gold).toBe(before.generals[3]!.gold + 100);
    expect(result.movements).toHaveLength(6);
    expect(result.payments.filter((payment) => payment.kind === 'TRIBUTE').map((payment) => payment.want)).toEqual([
      50, 50,
    ]);
    expect(result.state.nations).toEqual(before.nations);
    expect(result.state.generals[3]!.rice).toBe(before.generals[3]!.rice);
    expect(result.state.governance!.legitimacy).toMatchObject({ '1': 3, '3': 1 });
    expect(settleGovernanceMonthly(before, 10_000)).toEqual(result);
    expect(() => settleGovernanceMonthly(result.state, 10_000)).toThrow('중복');
    expect(() => settleGovernanceMonthly(before, 20_000)).toThrow('건너');
  });
  it('공납 수신 상한에서 실제 이체만 자르고 남은 돈을 보존한다', () => {
    const world = fixture();
    world.cityResources!.cities['1']!.gold = CITY_RESOURCE_MAX - 3;
    const result = settleGovernanceMonthly(world, 10_000);
    expect(result.payments.find((payment) => payment.refId === 2)).toMatchObject({
      want: 50,
      paid: 3,
      status: 'TRUNCATED',
    });
    expect(result.state.cityResources!.cities['1']!.gold).toBe(CITY_RESOURCE_MAX);
    expect(result.state.cityResources!.cities['2']!.gold).toBe(1047);
    expect(result.movements.filter((row) => row.refId === 2).map((row) => row.delta)).toEqual([-3, 3]);
  });
  it.each(['SEAT_SHORT', 'HOLDER_FULL'] as const)('%s이면 봉록은 일부 지급 없이 전액 건너뛴다', (reason) => {
    const world = fixture();
    world.governance!.vassals = [];
    world.governance!.court.minister = { generalId: 1, appointedTick: 0 };
    world.generals[11] = { ...world.generals[1]!, id: 11, officerLevel: 0 };
    world.governance!.court.minister.generalId = 11;
    if (reason === 'SEAT_SHORT') world.cityResources!.cities['1']!.gold = 99;
    else world.generals[11]!.gold = CITY_RESOURCE_MAX - 99;
    const result = settleGovernanceMonthly(world, 10_000);
    expect(result.payments).toEqual([
      { kind: 'STIPEND', refId: 3, resource: 'gold', want: 100, paid: 0, status: 'SKIPPED', reason },
    ]);
    expect(result.movements).toEqual([]);
    expect(result.state.generals[11]!.gold).toBe(world.generals[11]!.gold);
    expect(result.state.cityResources).toEqual(world.cityResources);
  });
  it('AC-P2-31 지급 불가 직위를 건너뛰고 남은 금을 직위 순서대로 지급한다', () => {
    const world = fixture();
    const seat = world.cityResources!.cities['1']!;
    seat.gold = 100;
    world.governance!.vassals = [];
    for (const id of [11, 12, 13]) world.generals[id] = { ...world.generals[1]!, id, officerLevel: 0, gold: 0 };
    world.generals[11]!.gold = CITY_RESOURCE_MAX - 99;
    world.governance!.court = {
      minister: { generalId: 13, appointedTick: 0 },
      grandMarshal: { generalId: 12, appointedTick: 0 },
      chancellor: { generalId: 11, appointedTick: 0 },
    };

    const result = settleGovernanceMonthly(deepFreeze(world), 10_000);
    expect(result.payments).toMatchObject([
      { refId: 1, paid: 0, status: 'SKIPPED', reason: 'HOLDER_FULL' },
      { refId: 2, paid: 100, status: 'PAID', reason: 'TRANSFER' },
      { refId: 3, paid: 0, status: 'SKIPPED', reason: 'SEAT_SHORT' },
    ]);
    expect(result.movements).toMatchObject([
      { refId: 2, holder: 'city', holderId: 1, delta: -100 },
      { refId: 2, holder: 'general', holderId: 12, delta: 100 },
    ]);
    expect(result.state.cityResources!.cities['1']!.gold).toBe(0);
    expect(result.state.generals[11]!.gold).toBe(CITY_RESOURCE_MAX - 99);
    expect(result.state.generals[12]!.gold).toBe(100);
    expect(result.state.generals[13]!.gold).toBe(0);
  });
  it('이탈은 다음 월 시작에 적용하고 남은 하위 관계와 재산을 지킨다', () => {
    const world = fixture();
    world.governance!.pendingRenounce = [2];
    world.governance!.legitimacy['2'] = 15;
    const result = settleGovernanceMonthly(world, 10_000);
    expect(result.state.governance!.vassals.map((row) => row.id)).toEqual([1]);
    expect(result.state.governance!.pendingRenounce).toEqual([]);
    expect(result.state.governance!.legitimacy['2']).toBe(4);
    expect(result.state.cityResources!.cities['1']!.gold).toBe(1000);
  });
  it('면제 마지막 월을 포함하고 금·쌀은 정해진 달에만 이체한다', () => {
    const world = fixture();
    world.governance!.vassals[1]!.remitUntilTick = 10_000;
    const first = settleGovernanceMonthly(world, 10_000);
    expect(first.payments.find((payment) => payment.refId === 2)).toMatchObject({ paid: 0, reason: 'REMITTED' });
    const second = settleGovernanceMonthly(first.state, 20_000);
    expect(second.payments).toEqual([]);
    const third = settleGovernanceMonthly(second.state, 30_000);
    const fourth = settleGovernanceMonthly(third.state, 40_000);
    expect(fourth.movements.map((row) => row.resource)).toEqual(['rice', 'rice', 'rice', 'rice']);
    expect(fourth.state.cityResources!.cities['1']!.rice).toBe(1050);
  });
  it('원장은 이체 쌍·보유처별 증감과 허용 범위 밖 변경을 검사한다', () => {
    const world = fixture(),
      result = settleGovernanceMonthly(world, 10_000);
    expect(() => assertGovernanceConserved(world, result.state, result.movements)).not.toThrow();
    expect(() => assertGovernanceConserved(world, result.state, result.movements.slice(1))).toThrow();
    const misdirected = result.movements.map((row, index) => (index === 1 ? { ...row, holderId: 4 } : row));
    expect(() => assertGovernanceConserved(world, result.state, misdirected)).toThrow();
    const forged = cloneWorld(result.state);
    forged.generals[1]!.rice++;
    expect(() => assertGovernanceConserved(world, forged, result.movements)).toThrow('밖');
    const parties = result.movements.map((row, index) => (index === 1 ? { ...row, fromNationId: 4 } : row));
    expect(() => assertGovernanceConserved(world, result.state, parties)).toThrow();
  });
});
