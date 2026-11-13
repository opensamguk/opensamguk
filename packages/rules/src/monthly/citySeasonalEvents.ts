import type { Rng } from '@opensamguk/shared';
import type { WorldState } from '../model/world';

export const CITY_SEASONAL_EVENTS_FEATURE = 'city-seasonal-events-v1';
export const CITY_SEASONAL_EVENTS = {
  boom: '호황',
  harvest: '풍작',
  epidemic: '역병',
  earthquake: '지진',
  cold: '혹한',
  rebellion: '황건적 습격',
  flood: '홍수',
  typhoon: '태풍',
  locust: '메뚜기 떼',
  famine: '흉년',
  snow: '폭설',
} as const;
export type CitySeasonalEvent = keyof typeof CITY_SEASONAL_EVENTS;

export function storedCitySeasonalEvent(value: string | null | undefined) {
  if (value == null) return {};
  if (!Object.hasOwn(CITY_SEASONAL_EVENTS, value)) throw new Error('저장된 도시 계절 사건이 올바르지 않습니다.');
  return { seasonalEvent: value as CitySeasonalEvent };
}

export function citySeasonalEventInfo(value: string) {
  const kind = storedCitySeasonalEvent(value).seasonalEvent!;
  return { kind, name: CITY_SEASONAL_EVENTS[kind], favorable: kind === 'boom' || kind === 'harvest' };
}

// core2026 c81d304, app/game-engine/src/turn/monthlyDisasterAction.ts (MIT).
const quarters: Record<number, readonly CitySeasonalEvent[]> = {
  1: ['epidemic', 'earthquake', 'cold', 'rebellion'],
  4: ['flood', 'earthquake', 'typhoon'],
  7: ['locust', 'earthquake', 'famine'],
  10: ['cold', 'earthquake', 'snow', 'rebellion'],
};
const fields = ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const;

export function settleCitySeasonalEvents(state: WorldState, date: { year: number; month: number }, rng: Rng) {
  const disasters = quarters[date.month];
  if (!disasters) return [];
  const cities = Object.values(state.cities).sort((a, b) => a.cityKey - b.cityKey);
  for (const city of cities) delete city.seasonalEvent;
  if (date.year < state.startYear + 3) return [];
  const goodEvent = date.month === 4 ? 'boom' : date.month === 7 ? 'harvest' : null;
  const good = rng.next() < (goodEvent === null ? 0 : 0.25);
  const affected = cities.filter((city) => {
    if (city.kind === 'PASS' || city.securityMax <= 0) return false;
    const security = Math.min(1, city.security / city.securityMax);
    return rng.next() < (good ? 0.02 + security * 0.05 : 0.06 - security * 0.05);
  });
  if (!affected.length) return [];
  const event = good && goodEvent !== null ? goodEvent : rng.pick(disasters);
  const struck = new Set(affected.map((city) => city.cityKey));
  for (const city of affected) {
    city.seasonalEvent = event;
    const safety = Math.min(1, city.security / city.securityMax / 0.8);
    const factor = good ? 1.01 + safety * 0.04 : 0.8 + safety * 0.15;
    for (const field of fields) city[field] = Math.min(city[`${field}Max`], Math.round(city[field] * factor));
    city.trust = Math.min(100, city.trust * factor);
  }
  const injuries: { generalId: number; text: string }[] = [];
  if (!good) {
    for (const general of Object.values(state.generals).sort((a, b) => a.id - b.id)) {
      if (
        !struck.has(general.cityKey) ||
        general.removedAt !== undefined ||
        general.activeFromYear > date.year ||
        rng.next() >= 0.3
      )
        continue;
      general.injury = Math.min(80, general.injury + rng.int(1, 16));
      for (const field of ['crew', 'atmos', 'train'] as const) general[field] = Math.round(general[field] * 0.98);
      injuries.push({ generalId: general.id, text: `${CITY_SEASONAL_EVENTS[event]}으로 부상을 당했습니다.` });
    }
  }
  return injuries;
}
