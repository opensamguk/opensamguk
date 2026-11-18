import { expect, it } from 'vitest';
import { operationalFixture } from '../../../test/operationalMapFixture';
import { attachOperationalKinds } from './stored';

it.each([
  undefined,
  { cityUpgrade: { enabled: false, completed: {} } },
  { cityUpgrade: { enabled: true, completed: {} } },
])('AC-INT-30 증축 이력이 없는 현의 소속 null은 거부한다: %j', (campaign) => {
  const map = operationalFixture();
  const source = map.sites[0]!;
  if (source.kind !== 'CITY') throw Error('도시 필요');
  source.parentCityKey = 2;
  const cities = [
    { cityKey: 1, kind: 'CITY', level: 1, state: 0, stateTerm: 0, parentCityKey: null },
    { cityKey: 2, kind: 'CITY', level: 1, state: 0, stateTerm: 0, parentCityKey: null },
    { cityKey: 99, kind: 'PASS', level: 0, state: 0, stateTerm: 0, parentCityKey: null },
  ];
  expect(() => attachOperationalKinds(cities, map, campaign)).toThrow('부모 도시');
  cities[0]!.level = 5;
  expect(() => attachOperationalKinds(cities, map, campaign)).not.toThrow();
  cities[0]!.level = 1;
  expect(() =>
    attachOperationalKinds(cities, map, { cityUpgrade: { enabled: false, completed: { '1': { level: 1 } } } }),
  ).not.toThrow();
});
