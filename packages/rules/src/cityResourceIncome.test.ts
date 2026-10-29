import { describe, expect, it } from 'vitest';
import { commandWorld } from '../test/commandFixture';
import { applyCityResourceIncome } from './cityResourceIncome';
import { CITY_RESOURCE_MAX, emptyCityResourcesState } from './cityResources/state';
import { settleIncome } from './monthly';
import { deepFreeze } from './personnel/testFixture';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['city-resources-v1'];
  for (const city of Object.values(world.cities))
    Object.assign(city, { population: 10_000, commerce: 0, agriculture: 0 });
  Object.assign(world.cities[1]!, { commerce: 100, agriculture: 75 });
  Object.assign(world.cities[4]!, { commerce: 200, agriculture: 25 });
  Object.assign(world.cities[2]!, { commerce: 50, agriculture: 50 });
  for (const nation of Object.values(world.nations)) Object.assign(nation, { gold: 17, rice: 23 });
  for (const general of Object.values(world.generals))
    Object.assign(general, { gold: 100 + general.id, rice: 200 + general.id, activeFromYear: 191 });
  Object.assign(world.generals[4]!, { nationId: 1 });
  world.generals[3]!.activeFromYear = 192;
  world.cityResources = emptyCityResourcesState(world);
  Object.assign(world.cityResources.cities['1']!, { gold: 7, rice: 11 });
  Object.assign(world.cityResources.cities['4']!, { gold: 13, rice: 17 });
  return world;
}

describe('AC-INT-18A 기존 급여를 보존하는 도시 세수 배분', () => {
  it.each([1, 7])('%s월에는 실제 기존 급여를 보존하고 금 국고 증가분만 도시에 적립한다', (month) => {
    const before = fixture();
    const settled = settleIncome(before, { year: 191, month });
    const snapshots = structuredClone({ before, settled });
    const next = applyCityResourceIncome(deepFreeze(before), deepFreeze(settled), { year: 191, month });
    expect(next.generals).toEqual(settled.generals);
    expect(next.generals[1]!.gold).toBe(251);
    expect(next.generals[4]!.gold).toBe(254);
    expect(next.generals[2]!.gold).toBe(152);
    expect(next.generals[3]!.gold).toBe(103);
    expect(next.nations).toEqual(before.nations);
    expect(next.cityResources!.cities['1']).toEqual({ gold: 107, rice: 11, garrison: [] });
    expect(next.cityResources!.cities['4']).toEqual({ gold: 213, rice: 17, garrison: [] });
    expect(next.cityResources!.cities['2']).toEqual({ gold: 50, rice: 0, garrison: [] });
    expect(next.cityResources!.cities['3']).toEqual({ gold: 0, rice: 0, garrison: [] });
    expect({ before, settled }).toEqual(snapshots);
  });

  it.each([4, 10])('%s월에는 쌀만 적립하고 기존 금·부곡·도시 지표는 그대로 둔다', (month) => {
    const before = fixture();
    const settled = settleIncome(before, { year: 191, month });
    const next = applyCityResourceIncome(before, settled, { year: 191, month });
    expect(next.cityResources!.cities['1']).toEqual({ gold: 7, rice: 86, garrison: [] });
    expect(next.cityResources!.cities['4']).toEqual({ gold: 13, rice: 42, garrison: [] });
    expect(next.cityResources!.cities['2']).toEqual({ gold: 0, rice: 50, garrison: [] });
    expect(next.nations).toEqual(before.nations);
    expect(next.generals).toEqual(settled.generals);
    expect(next.cities).toEqual(before.cities);
    expect(next.campaign).toEqual(before.campaign);
  });

  it.each([2, 3, 5, 6, 8, 9, 11, 12])('%s월에는 적립 없이 독립 복사본을 돌려준다', (month) => {
    const before = fixture();
    const settled = settleIncome(before, { year: 191, month });
    const next = applyCityResourceIncome(deepFreeze(before), deepFreeze(settled), { year: 191, month });
    expect(next).toEqual(before);
    expect(next).not.toBe(settled);
    expect(next.cityResources).not.toBe(settled.cityResources);
  });

  it('기능 표시가 없는 기존 판의 정산값에 도시 원장을 추가하지 않는다', () => {
    const before = commandWorld();
    const settled = settleIncome(before, { year: 191, month: 1 });
    const next = applyCityResourceIncome(deepFreeze(before), deepFreeze(settled), { year: 191, month: 1 });
    expect(next).toEqual(settled);
    expect(Object.hasOwn(next, 'cityResources')).toBe(false);
    expect(next).not.toBe(settled);
    expect(next.generals[1]).not.toBe(settled.generals[1]);
  });

  it('활동 장수 0명인 국가는 세수 전액을 도시들에 나눈다', () => {
    const before = fixture();
    for (const general of Object.values(before.generals)) general.activeFromYear = 192;
    const settled = settleIncome(before, { year: 191, month: 1 });
    const next = applyCityResourceIncome(before, settled, { year: 191, month: 1 });
    expect(next.cityResources!.cities['1']!.gold).toBe(207);
    expect(next.cityResources!.cities['4']!.gold).toBe(413);
    expect(next.cityResources!.cities['2']!.gold).toBe(100);
    expect(next.generals).toEqual(before.generals);
    expect(next.nations).toEqual(before.nations);
  });

  it('소수 세수 반올림과 급여의 실제 결과를 받아 도시 키 순서로 잔여를 준다', () => {
    const before = fixture();
    Object.assign(before.cities[1]!, { population: 1000, commerce: 1 });
    Object.assign(before.cities[4]!, { population: 1000, commerce: 2 });
    const settled = settleIncome(before, { year: 191, month: 1 });
    expect(settled.nations[1]!.gold).toBe(18);
    expect(settled.generals[1]!.gold).toBe(101);
    const next = applyCityResourceIncome(before, settled, { year: 191, month: 1 });
    expect(next.cityResources!.cities['1']!.gold).toBe(8);
    expect(next.cityResources!.cities['4']!.gold).toBe(13);
    expect(next.nations[1]!.gold).toBe(17);
    expect(next.generals).toEqual(settled.generals);
  });

  it('세수 0과 국가 무도시에서도 급여·국고·도시 잔액을 만들지 않는다', () => {
    const before = fixture();
    for (const city of Object.values(before.cities)) city.commerce = 0;
    before.cities[2]!.nationId = null;
    const settled = settleIncome(before, { year: 191, month: 1 });
    expect(applyCityResourceIncome(before, settled, { year: 191, month: 1 })).toEqual(before);
  });

  it('동률인 도시의 정수 잔여는 도시 키가 작은 곳에 먼저 적립한다', () => {
    const before = fixture();
    for (const key of [1, 4]) Object.assign(before.cities[key]!, { population: 1, commerce: 2500 });
    const settled = settleIncome(before, { year: 191, month: 1 });
    const next = applyCityResourceIncome(before, settled, { year: 191, month: 1 });
    expect(next.cityResources!.cities['1']!.gold).toBe(8);
    expect(next.cityResources!.cities['4']!.gold).toBe(13);
    expect(next.generals[1]!.gold).toBe(101);
    expect(next.nations[1]!.gold).toBe(17);
  });

  it('관문과 중립 도시의 경제 수치를 국가 세수 배분에서 제외한다', () => {
    const before = fixture();
    before.cities[4]!.kind = 'PASS';
    before.cities[3]!.commerce = 100_000;
    const settled = settleIncome(before, { year: 191, month: 1 });
    const next = applyCityResourceIncome(before, settled, { year: 191, month: 1 });
    expect(next.cityResources!.cities['1']!.gold).toBe(107);
    expect(next.cityResources!.cities['4']!.gold).toBe(13);
    expect(next.cityResources!.cities['3']!.gold).toBe(0);
    expect(next.generals[1]!.gold).toBe(151);
    expect(next.nations).toEqual(before.nations);
  });

  it('정산 전 소유 변경을 반영하고 이전 국가나 도시에 중복 지급하지 않는다', () => {
    const before = fixture();
    before.cities[4]!.nationId = 2;
    const settled = settleIncome(before, { year: 191, month: 1 });
    const next = applyCityResourceIncome(before, settled, { year: 191, month: 1 });
    expect(next.cityResources!.cities['1']!.gold).toBe(107);
    expect(next.cityResources!.cities['4']!.gold).toBe(213);
    expect(next.cityResources!.cities['2']!.gold).toBe(50);
    expect(next.generals[2]!.gold).toBe(352);
    expect(next.nations).toEqual(before.nations);
  });

  it('큰 곱셈에서도 비례배분 정수와 총액을 정확히 보존한다', () => {
    const before = fixture();
    for (const general of Object.values(before.generals)) general.activeFromYear = 192;
    for (const nation of Object.values(before.nations)) nation.gold = 0;
    for (const city of Object.values(before.cities)) city.commerce = 0;
    Object.assign(before.cities[1]!, { population: 5000, commerce: 1_000_000_000 });
    Object.assign(before.cities[4]!, { population: 5000, commerce: 1_000_000_001 });
    for (const city of Object.values(before.cityResources!.cities)) city.gold = 0;
    const settled = settleIncome(before, { year: 191, month: 1 });
    expect(settled.nations[1]!.gold).toBe(2_000_000_001);
    const next = applyCityResourceIncome(before, settled, { year: 191, month: 1 });
    expect(next.cityResources!.cities['1']!.gold).toBe(1_000_000_000);
    expect(next.cityResources!.cities['4']!.gold).toBe(1_000_000_001);
    expect(next.nations[1]!.gold).toBe(0);
  });

  it.each(['city', 'nation', 'gross'] as const)('%s Int32 초과는 양쪽 입력을 보존한 채 실패한다', (target) => {
    const before = fixture();
    if (target === 'city') before.cityResources!.cities['1']!.gold = CITY_RESOURCE_MAX;
    if (target === 'nation') before.nations[1]!.gold = CITY_RESOURCE_MAX;
    if (target === 'gross') before.cities[1]!.commerce = CITY_RESOURCE_MAX;
    const settled = settleIncome(before, { year: 191, month: 1 });
    const snapshots = structuredClone({ before, settled });
    expect(() => applyCityResourceIncome(deepFreeze(before), deepFreeze(settled), { year: 191, month: 1 })).toThrow(
      RangeError,
    );
    expect({ before, settled }).toEqual(snapshots);
  });

  it.each([
    'negative',
    'salary',
    'inactive',
    'unaffiliated',
    'missing-nation',
    'ledger',
    'feature',
    'city-change',
  ] as const)('%s 정산 불일치를 보정하거나 덮지 않고 거부한다', (kind) => {
    const before = fixture();
    if (kind === 'unaffiliated') before.generals[4]!.nationId = null;
    const settled = settleIncome(before, { year: 191, month: 1 });
    if (kind === 'negative') settled.nations[1]!.gold = 16;
    if (kind === 'salary') settled.generals[1]!.gold++;
    if (kind === 'inactive') settled.generals[3]!.gold++;
    if (kind === 'unaffiliated') settled.generals[4]!.gold++;
    if (kind === 'missing-nation') delete settled.nations[2];
    if (kind === 'ledger') settled.cityResources!.cities['1']!.gold++;
    if (kind === 'feature') settled.ruleFeatures = [];
    if (kind === 'city-change') settled.cities[1]!.population++;
    const snapshots = structuredClone({ before, settled });
    expect(() => applyCityResourceIncome(deepFreeze(before), deepFreeze(settled), { year: 191, month: 1 })).toThrow();
    expect({ before, settled }).toEqual(snapshots);
  });

  it('원장의 누락·알 수 없는 도시와 없는 소속 국가를 거부한다', () => {
    const before = fixture();
    const settled = settleIncome(before, { year: 191, month: 1 });
    delete settled.cityResources;
    expect(() => applyCityResourceIncome(before, settled, { year: 191, month: 1 })).toThrow();
    settled.cityResources = structuredClone(before.cityResources!);
    settled.cityResources.cities['99'] = { gold: 0, rice: 0, garrison: [] };
    expect(() => applyCityResourceIncome(before, settled, { year: 191, month: 1 })).toThrow();
    const orphaned = fixture();
    orphaned.cities[1]!.nationId = 99;
    expect(() =>
      applyCityResourceIncome(orphaned, settleIncome(orphaned, { year: 191, month: 1 }), { year: 191, month: 1 }),
    ).toThrow('국가');
  });
});
