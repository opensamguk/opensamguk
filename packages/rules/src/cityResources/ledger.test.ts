import { describe, expect, it } from 'vitest';
import type { CampaignUnitState } from '../campaign/state';
import { deepFreeze } from '../personnel/testFixture';
import { allocateCityGarrison, recruitCityGarrison } from './ledger';
import { CITY_RESOURCE_MAX, type CityResourceState } from './state';

const cityFixture = (): CityResourceState => ({
  gold: 200,
  rice: 300,
  garrison: [
    { crewType: 1100, troops: 10, train: 77, atmos: 59 },
    { crewType: 1200, troops: 5, train: 100, atmos: 100 },
  ],
});
const unitFixture = (): CampaignUnitState => ({
  id: 4,
  ownerId: 9,
  commanderId: 12,
  crewType: 1100,
  troops: 2,
  train: 0,
  atmos: 100,
});

describe('AC-INT-18A 도시 모집·배속 순수 원장', () => {
  it('새 병종은 훈련·사기 0으로 모집하며 지갑을 차감하지 않는다', () => {
    const city = cityFixture();
    const before = structuredClone(city);
    const result = recruitCityGarrison(deepFreeze(city), 1050, 8);
    expect(result).toEqual({
      gold: 200,
      rice: 300,
      garrison: [{ crewType: 1050, troops: 8, train: 0, atmos: 0 }, ...before.garrison],
    });
    expect(city).toEqual(before);
  });

  it('기존 병종에 신병을 합치면 수량을 보존하고 훈련·사기를 버림한다', () => {
    const city = cityFixture();
    const before = structuredClone(city);
    const result = recruitCityGarrison(deepFreeze(city), 1100, 3);
    expect(result.garrison).toEqual([
      { crewType: 1100, troops: 13, train: 59, atmos: 45 },
      { crewType: 1200, troops: 5, train: 100, atmos: 100 },
    ]);
    expect(result.gold).toBe(200);
    expect(result.rice).toBe(300);
    expect(city).toEqual(before);
  });

  it('부분 배속에서 양쪽 수량은 등량이고 도시 잔량의 훈련·사기는 그대로다', () => {
    const city = cityFixture();
    const unit = unitFixture();
    const before = structuredClone({ city, unit });
    const result = allocateCityGarrison(deepFreeze(city), deepFreeze(unit), 1100, 1);
    expect(result.city).toEqual({
      gold: 200,
      rice: 300,
      garrison: [
        { crewType: 1100, troops: 9, train: 77, atmos: 59 },
        { crewType: 1200, troops: 5, train: 100, atmos: 100 },
      ],
    });
    expect(result.unit).toEqual({ ...before.unit, troops: 3, train: 25, atmos: 86 });
    expect(result.city.garrison.reduce((total, row) => total + row.troops, 0) + result.unit.troops).toBe(17);
    expect({ city, unit }).toEqual(before);
  });

  it('전량 배속 뒤 0인원 행만 제거하고 다른 병종은 보존한다', () => {
    const result = allocateCityGarrison(cityFixture(), unitFixture(), 1100, 10);
    expect(result.city).toEqual({
      gold: 200,
      rice: 300,
      garrison: [{ crewType: 1200, troops: 5, train: 100, atmos: 100 }],
    });
    expect(result.unit).toEqual({ ...unitFixture(), troops: 12, train: 64, atmos: 65 });
  });

  it('빈 부곡에는 도시 훈련·사기를 그대로 전달하고 인물·번호는 유지한다', () => {
    const unit = { ...unitFixture(), troops: 0, train: 100, atmos: 0 };
    const result = allocateCityGarrison(cityFixture(), unit, 1100, 3);
    expect(result.unit).toEqual({ ...unit, troops: 3, train: 77, atmos: 59 });
  });

  it.each([0, -1, 0.5, CITY_RESOURCE_MAX + 1, Number.NaN])('모집·배속 수량 %s를 거부한다', (amount) => {
    const city = deepFreeze(cityFixture());
    const unit = deepFreeze(unitFixture());
    expect(() => recruitCityGarrison(city, 1100, amount)).toThrow();
    expect(() => allocateCityGarrison(city, unit, 1100, amount)).toThrow();
  });

  it.each([0, -1, 0.5, CITY_RESOURCE_MAX + 1])('병종 식별자 %s를 거부한다', (crewType) => {
    expect(() => recruitCityGarrison(cityFixture(), crewType, 1)).toThrow();
    expect(() => allocateCityGarrison(cityFixture(), unitFixture(), crewType, 1)).toThrow();
  });

  it('부족·없는 병종·다른 부곡 병종을 거부하며 입력을 바꾸지 않는다', () => {
    const city = cityFixture();
    const unit = unitFixture();
    const before = structuredClone({ city, unit });
    deepFreeze(city);
    deepFreeze(unit);
    expect(() => allocateCityGarrison(city, unit, 1100, 11)).toThrow('부족');
    expect(() => allocateCityGarrison(city, unit, 1300, 1)).toThrow('부족');
    expect(() => allocateCityGarrison(city, unit, 1200, 1)).toThrow('병종');
    expect(() => allocateCityGarrison(city, { ...unit, troops: 0 }, 1200, 1)).toThrow('병종');
    expect({ city, unit }).toEqual(before);
  });

  it('병종 중복·기존 잘못된 수치·부곡 초과 필드를 조용히 고치지 않는다', () => {
    const duplicate = cityFixture();
    duplicate.garrison.push({ ...duplicate.garrison[0]! });
    expect(() => recruitCityGarrison(duplicate, 1100, 1)).toThrow('중복');
    expect(() => allocateCityGarrison(duplicate, unitFixture(), 1100, 1)).toThrow('중복');
    expect(() => recruitCityGarrison({ ...cityFixture(), gold: -1 }, 1100, 1)).toThrow();
    expect(() => allocateCityGarrison(cityFixture(), { ...unitFixture(), train: 101 }, 1100, 1)).toThrow();
    const extraField = { ...unitFixture(), extra: 1 };
    expect(() => allocateCityGarrison(cityFixture(), extraField, 1100, 1)).toThrow();
  });

  it('도시 병종·도시 합계·부곡 각각의 Int32 초과를 거부한다', () => {
    const city: CityResourceState = {
      gold: 0,
      rice: 0,
      garrison: [{ crewType: 1100, troops: CITY_RESOURCE_MAX, train: 100, atmos: 100 }],
    };
    expect(() => recruitCityGarrison(city, 1100, 1)).toThrow('한도');
    expect(() => recruitCityGarrison(city, 1200, 1)).toThrow('도시 전체 병력');
    expect(() => allocateCityGarrison(cityFixture(), { ...unitFixture(), troops: CITY_RESOURCE_MAX }, 1100, 1)).toThrow(
      '한도',
    );
  });

  it('Int32 경계의 큰 가중치를 정확한 정수로 보존한다', () => {
    const city: CityResourceState = {
      gold: 0,
      rice: 0,
      garrison: [{ crewType: 1100, troops: 1, train: 0, atmos: 100 }],
    };
    const unit = { ...unitFixture(), troops: CITY_RESOURCE_MAX - 1, train: 100, atmos: 0 };
    expect(allocateCityGarrison(city, unit, 1100, 1).unit).toEqual({
      ...unit,
      troops: CITY_RESOURCE_MAX,
      train: 99,
      atmos: 0,
    });
  });
});
