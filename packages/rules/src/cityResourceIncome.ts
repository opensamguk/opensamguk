import type { GameDate } from '@opensamguk/shared';
import { BALANCE } from './balance';
import { CITY_RESOURCE_MAX, readCityResourcesState } from './cityResources/state';
import { cloneWorld } from './model/clone';
import type { WorldState, WorldView } from './model/world';

function quantity(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > CITY_RESOURCE_MAX)
    throw new RangeError('도시 세수의 수량 범위를 넘었습니다.');
  return value;
}

function sum(left: number, right: number): number {
  return quantity(left + right);
}

function sameFields(before: object, after: object, except?: string): boolean {
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && (key === except || JSON.stringify(left[key]) === JSON.stringify(right[key])),
    )
  );
}

// 기존 정산의 실제 지급을 받아 국고 증가분만 도시 원장으로 옮긴다.
export function applyCityResourceIncome(before: WorldView, settled: WorldView, date: GameDate): WorldState {
  const active = before.ruleFeatures?.includes('city-resources-v1') ?? false;
  if (active !== (settled.ruleFeatures?.includes('city-resources-v1') ?? false))
    throw new Error('도시 세수 정산 중 규칙 판이 바뀌었습니다.');
  if (!active) return cloneWorld(settled);
  if (!Number.isSafeInteger(date.year) || !Number.isInteger(date.month) || date.month < 1 || date.month > 12)
    throw new Error('도시 세수 정산 날짜를 확인하세요.');
  const original = readCityResourcesState(before.cityResources, before);
  const ledger = readCityResourcesState(settled.cityResources, settled);
  if (JSON.stringify(original) !== JSON.stringify(ledger)) throw new Error('세수 지급 전에 도시 원장이 바뀌었습니다.');
  const resource = [1, 7].includes(date.month) ? 'gold' : [4, 10].includes(date.month) ? 'rice' : undefined;
  const next = cloneWorld(settled);
  next.cityResources = ledger;
  for (const collection of ['cities', 'nations', 'generals'] as const) {
    const keys = Object.keys(before[collection]);
    if (
      keys.length !== Object.keys(settled[collection]).length ||
      keys.some((key) => {
        const after = settled[collection][Number(key)];
        const prior = before[collection][Number(key)];
        return (
          !prior ||
          !after ||
          (collection !== 'cities' && String((prior as { id: number }).id) !== key) ||
          !sameFields(prior, after, collection === 'cities' ? undefined : resource)
        );
      })
    )
      throw new Error('기존 세수 정산 밖의 월드 변경이 섞였습니다.');
  }
  for (const city of Object.values(before.cities))
    if (city.nationId !== null && !before.nations[city.nationId]) throw new Error('도시 세수의 소속 국가가 없습니다.');
  for (const nation of Object.values(before.nations)) {
    const after = settled.nations[nation.id];
    if (!after) throw new Error('세수 정산 국가가 없습니다.');
    for (const key of ['gold', 'rice'] as const) {
      quantity(nation[key]);
      quantity(after[key]);
    }
  }
  for (const general of Object.values(before.generals)) {
    if (general.nationId !== null && !before.nations[general.nationId])
      throw new Error('급여 장수의 소속 국가가 없습니다.');
    const after = settled.generals[general.id];
    if (!after) throw new Error('급여 정산 장수가 없습니다.');
    for (const key of ['gold', 'rice'] as const) {
      quantity(general[key]);
      quantity(after[key]);
    }
    if (resource) {
      const paid = quantity(after[resource] - general[resource]);
      if ((general.nationId === null || general.activeFromYear > date.year) && paid !== 0)
        throw new Error('급여 대상 밖의 장수에게 지급됐습니다.');
    }
  }
  if (!resource) return next;

  const field = resource === 'gold' ? 'commerce' : 'agriculture';
  for (const nation of Object.values(before.nations).sort((left, right) => left.id - right.id)) {
    const after = settled.nations[nation.id];
    if (!after) throw new Error('세수 정산 국가가 없습니다.');
    const delta = quantity(quantity(after[resource]) - quantity(nation[resource]));
    const cities = Object.values(before.cities)
      .filter((city) => city.nationId === nation.id && city.kind !== 'PASS')
      .sort((left, right) => left.cityKey - right.cityKey);
    let weight = 0;
    const exactWeights = cities.map((city) => {
      quantity(city[field]);
      quantity(city.population);
      weight += city[field] * (city.population / BALANCE.MONTHLY_POPULATION_UNIT) * BALANCE.MONTHLY_TAX_RATE;
      return BigInt(city[field]) * BigInt(city.population);
    });
    const gross = quantity(Math.round(weight));
    let salaries = 0;
    for (const general of Object.values(before.generals).filter((row) => row.nationId === nation.id)) {
      const current = settled.generals[general.id];
      if (!current) throw new Error('급여 정산 장수가 없습니다.');
      const paid = quantity(quantity(current[resource]) - quantity(general[resource]));
      salaries = sum(salaries, paid);
    }
    if (sum(delta, salaries) !== gross) throw new Error('기존 세수와 급여·도시 적립의 합계가 다릅니다.');
    next.nations[nation.id]![resource] = nation[resource];
    if (delta === 0) continue;
    const exactTotal = exactWeights.reduce((total, value) => total + value, 0n);
    if (weight <= 0 || exactTotal === 0n) throw new Error('적립할 도시의 세수 가중치가 없습니다.');
    // 공통 인구 단위·세율을 소거해 큰 곱셈에서도 정수 버림을 정확히 계산한다.
    const deposits = exactWeights.map((value) => Number((BigInt(delta) * value) / exactTotal));
    let remainder = delta - deposits.reduce((total, value) => sum(total, value), 0);
    for (let index = 0; remainder > 0; index++, remainder--) {
      if (index >= deposits.length) throw new Error('도시 세수 잔여 배분 한도를 넘었습니다.');
      deposits[index] = deposits[index]! + 1;
    }
    if (deposits.reduce((total, value) => sum(total, value), 0) !== delta)
      throw new Error('도시 세수 배분 총액이 다릅니다.');
    for (let index = 0; index < cities.length; index++) {
      const city = ledger.cities[String(cities[index]!.cityKey)]!;
      city[resource] = sum(city[resource], deposits[index]!);
    }
  }
  next.cityResources = readCityResourcesState(ledger, next);
  return next;
}
