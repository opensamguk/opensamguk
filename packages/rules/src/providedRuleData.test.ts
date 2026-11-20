import { expect, it } from 'vitest';
import { commandInitial } from '../test/commandFixture';
import { providedRuleData } from './providedRuleData';
import { buildInitialWorld } from './world/bootstrap';
import { mapFixture, scenarioFixture, unitFixture } from './world/validate/testFixtures';
import { FIVE_STAT_RULES } from './general/fiveStats';

it('AC-INT-28 지도·인물 자료가 없으면 빈 관계·특산지와 최소 도시 키 소재지를 고정한다', () => {
  const initial = commandInitial();
  initial.cities = initial.cities.map((city, i) => ({ ...city, name: `시험도시${i}` })).reverse();
  initial.generals = initial.generals.map((general, i) => ({ ...general, name: `시험장수${i}`, sex: 'UNKNOWN' }));
  const before = structuredClone(initial);
  const data = providedRuleData(initial, 60);
  expect(data['relations-v1']).toEqual({ version: 1, pairs: [] });
  expect(data['logistics-v1']).toMatchObject({ specialties: [] });
  expect(data['governance-v1']).toMatchObject({ seatCityKey: Math.min(...initial.cities.map((city) => city.cityKey)) });
  expect(providedRuleData({ ...initial, cities: [...initial.cities].reverse() }, 60)).toEqual(data);
  expect(initial).toEqual(before);
  expect(() => providedRuleData({ ...initial, cities: [] }, 60)).toThrow('황실 소재지');
});

it('AC-INT-28 자료 없는 시나리오에 명시한 5능력치 판은 계속 거부한다', () => {
  const input = {
    map: mapFixture(),
    scenario: scenarioFixture(),
    unitSet: unitFixture(),
    seed: 'no-stats',
    statRules: { stat: FIVE_STAT_RULES },
  };
  expect(() => buildInitialWorld(input)).toThrow('5능력치 인물·출처');
  expect(
    buildInitialWorld({ ...input, statRules: { stat: { total: 165, min: 15, max: 80 } } }).generals[0],
  ).not.toHaveProperty('politics');
});
