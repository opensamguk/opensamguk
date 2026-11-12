import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { monthlyFixture } from '../test/monthlyFixture';
import {
  appointOfficer,
  clearLostCityOffices,
  defaultOfficeEffects,
  officeEffectsSchema,
  residentOfficeBonuses,
  runMonthly,
  toWorldState,
  type WorldState,
} from '@opensamguk/rules';

function settle(state: WorldState, month: number) {
  return runMonthly(state, 10000 * month, rngFor('office-residency', 'monthly', 191, month));
}
function ownedGold(state: WorldState, nationId: number) {
  return (
    state.nations[nationId]!.gold +
    Object.values(state.generals)
      .filter((general) => general.nationId === nationId)
      .reduce((total, general) => total + general.gold, 0)
  );
}
async function source() {
  const before = toWorldState(await monthlyFixture());
  before.officeEffects = structuredClone(defaultOfficeEffects);
  const city = before.cities[1]!;
  city.commerce = 1000;
  city.agriculture = 1000;
  city.population = 20000;
  city.populationMax = 40000;
  const ruler = before.generals[1]!;
  ruler.officerLevel = 12;
  const military = before.generals[3]!;
  military.activeFromYear = before.startYear;
  const governor = { ...military, id: 4, strength: 65 };
  const central = { ...military, id: 5, officerLevel: 11 };
  before.generals[4] = governor;
  before.generals[5] = central;
  return before;
}
function appoint(state: WorldState, generalId: number, officerLevel: number, cityKey: number) {
  const result = appointOfficer(state, 1, generalId, officerLevel, cityKey);
  if (!result.ok) throw Error(result.message);
  return result.state;
}

describe('AC-M3-12 1030 고정 시드 관직 주재 골든', () => {
  it('태수와 군사 보정은 각각 10%이고 참모가 함께 있어도 가장 큰 한 번만 붙는다', async () => {
    const before = await source();
    const disabled = structuredClone(before);
    delete disabled.officeEffects;
    const comparison = settle(disabled, 1).state;
    const central = settle(before, 1);
    const governor = appoint(before, 4, 4, 1);
    const military = appoint(before, 3, 3, 1);
    const both = appoint(governor, 3, 3, 1);
    const gold = (state: WorldState) => ownedGold(state, 1);
    expect([
      gold(central.state) - gold(comparison),
      gold(settle(governor, 1).state) - gold(comparison),
      gold(settle(military, 1).state) - gold(comparison),
      gold(settle(both, 1).state) - gold(comparison),
    ]).toEqual([200, 400, 400, 400]);
    expect(settle(both, 1).officeTaxLogs).toEqual([{ generalId: 3, text: '도시1 주재로 세수 10% 보정' }]);
    expect(settle(both, 2).officeTaxLogs).toEqual([]);
    expect(both.generals[3]).toMatchObject({ officerLevel: 3, officerCityKey: 1 });

    both.generals[3]!.cityKey = 3;
    both.generals[4]!.cityKey = 3;
    both.generals[5]!.cityKey = 2;
    expect(gold(settle(both, 7).state) - gold(settle(disabled, 7).state)).toBe(0);
    expect(both.generals[4]).toMatchObject({ officerLevel: 4, officerCityKey: 1 });
    both.generals[4]!.cityKey = 1;
    expect(gold(settle(both, 7).state) - gold(settle(disabled, 7).state)).toBe(400);
  });

  it('수뇌는 자기 도시의 보급 단절 손실만 줄이고 담당 도시 점령은 관직을 해제한다', async () => {
    const before = await source();
    before.cities[1]!.connections = [];
    before.cities[3]!.connections = [];
    before.nations[1]!.capitalCityKey = 3;
    before.cities[1]!.security = 1000;
    before.generals[5]!.officerLevel = 5;
    before.generals[5]!.train = 100;
    before.generals[5]!.atmos = 100;
    const disabled = structuredClone(before);
    delete disabled.officeEffects;
    const settled = settle(before, 2).state;
    const previous = settle(disabled, 2).state;
    expect([settled.cities[1]!.commerce, previous.cities[1]!.commerce]).toEqual([910, 900]);
    expect([settled.cities[1]!.security, previous.cities[1]!.security]).toEqual([910, 900]);
    expect([settled.generals[5]!.train, previous.generals[5]!.train]).toEqual([91, 90]);
    const assigned = appoint(before, 4, 4, 1);
    const lost = structuredClone(assigned);
    lost.cities[1]!.nationId = 2;
    clearLostCityOffices(assigned, lost);
    expect(lost.generals[4]!.officerLevel).toBe(1);
    expect(lost.generals[4]).not.toHaveProperty('officerCityKey');
    expect(residentOfficeBonuses(lost, lost.startYear).has(1)).toBe(false);
  });

  it('관직 효과 표는 정의된 대상과 범위만 허용한다', () => {
    expect(officeEffectsSchema.parse(defaultOfficeEffects)).toEqual(defaultOfficeEffects);
    expect(officeEffectsSchema.safeParse({ ...defaultOfficeEffects, security: 50 }).success).toBe(false);
    expect(officeEffectsSchema.safeParse({ ...defaultOfficeEffects, tax: { 3: 10, 4: 51, 11: 5 } }).success).toBe(
      false,
    );
  });
});
