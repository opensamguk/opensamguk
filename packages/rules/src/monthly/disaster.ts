// core2026 81e101f monthlyDisasterAction.ts (MIT devsam), resources/NOTICE.md.
import type { GameDate, Rng } from '@opensamguk/shared';
import type { WorldState } from '../model/world';
import { cityDistances } from '../cityAffiliation';

const disasters: Record<number, readonly (readonly [number, string])[]> = {
  1: [
    [4, '역병이 발생하여 도시가 황폐해지고 있습니다.'],
    [5, '지진으로 피해가 속출하고 있습니다.'],
    [3, '추위가 풀리지 않아 얼어죽는 백성들이 늘어나고 있습니다.'],
    [9, '황건적이 출현해 도시를 습격하고 있습니다.'],
  ],
  4: [
    [7, '홍수로 인해 피해가 급증하고 있습니다.'],
    [5, '지진으로 피해가 속출하고 있습니다.'],
    [6, '태풍으로 인해 피해가 속출하고 있습니다.'],
  ],
  7: [
    [8, '메뚜기 떼가 발생하여 도시가 황폐해지고 있습니다.'],
    [5, '지진으로 피해가 속출하고 있습니다.'],
    [8, '흉년이 들어 굶어죽는 백성들이 늘어나고 있습니다.'],
  ],
  10: [
    [3, '혹한으로 도시가 황폐해지고 있습니다.'],
    [5, '지진으로 피해가 속출하고 있습니다.'],
    [3, '눈이 많이 쌓여 도시가 황폐해지고 있습니다.'],
    [9, '황건적이 출현해 도시를 습격하고 있습니다.'],
  ],
};
export type DisasterLog = { kind: 'disaster' | 'boom'; text: string; generalId?: number };
export function disasterProbability(security: number, maximum: number, good: boolean) {
  const ratio = security / maximum;
  return good ? 0.02 + ratio * 0.05 : 0.06 - ratio * 0.05;
}

export function settleDisaster(state: WorldState, date: GameDate, rng: Rng): DisasterLog[] {
  const logs: DisasterLog[] = [];
  if (!disasters[date.month]) return logs;
  const cities = Object.values(state.cities)
    .filter((city) => city.state != null)
    .sort((a, b) => a.cityKey - b.cityKey);
  for (const city of cities)
    if (city.state! <= 10) {
      city.state = 0;
      city.stateTerm = 0;
    }
  if (!cities.length || date.year < state.startYear + 3) return logs;
  const good = [4, 7].includes(date.month) && rng.next() < 0.25;
  const targets = cities
    .filter((city) => city.kind !== 'PASS' && city.kind !== 'FIELD' && city.securityMax > 0)
    .filter((city) => rng.next() < disasterProbability(city.security, city.securityMax, good));
  if (!targets.length) return logs;
  const [code, body] = rng.pick(
    good
      ? [[date.month === 4 ? 2 : 1, `${date.month === 4 ? '호황' : '풍작'}으로 도시가 번창하고 있습니다.`] as const]
      : disasters[date.month]!,
  );
  const affected = targets.filter((city) => city.level !== 1 || (!good && (code === 6 || code === 7)));
  if (!affected.length) return logs;
  const kind = good ? 'boom' : 'disaster';
  logs.push({
    kind,
    text: `${good ? (code === 2 ? '【호황】' : '【풍작】') : '【재난】'}${affected.map((city) => city.name).join(' ')}에 ${body}`,
  });
  const groups = new Map<number, number>();
  for (const city of affected) {
    let parent = city.parentCityKey ?? city.cityKey;
    if (city.parentCityKey == null && city.level < 5) {
      const major = cities.filter((candidate) => candidate.kind === 'CITY' && candidate.level >= 5);
      const local = major.filter((candidate) => candidate.region === city.region);
      const distance = cityDistances(state.cities, city.cityKey);
      parent =
        (local.length ? local : major).sort(
          (a, b) =>
            (distance.get(a.cityKey) ?? Infinity) - (distance.get(b.cityKey) ?? Infinity) || a.cityKey - b.cityKey,
        )[0]?.cityKey ?? city.cityKey;
    }
    groups.set(parent, (groups.get(parent) ?? 0) + 1);
    const securityRatio = Math.max(0, Math.min(1, city.security / city.securityMax / 0.8));
    const factor = good ? 1.01 + securityRatio * 0.04 : 0.8 + securityRatio * 0.15;
    city.state = code;
    city.stateTerm = 3;
    for (const field of ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const)
      city[field] = Math.round(good ? Math.min(city[field] * factor, city[`${field}Max`]) : city[field] * factor);
    city.trust = good ? Math.min(city.trust * factor, 100) : city.trust * factor;
    if (good) continue;
    for (const general of Object.values(state.generals)
      .filter((general) => general.cityKey === city.cityKey && general.removedAt === undefined)
      .sort((a, b) => a.id - b.id)) {
      if (rng.next() >= 0.3) continue;
      general.injury = Math.min(80, general.injury + rng.int(1, 16));
      for (const field of ['crew', 'atmos', 'train'] as const) general[field] = Math.round(general[field] * 0.98);
      if (state.campaign) {
        for (const unit of state.campaign.units.filter((unit) => unit.commanderId === general.id))
          for (const field of ['troops', 'atmos', 'train'] as const) unit[field] = Math.round(unit[field] * 0.98);
      }
      logs.push({ kind, generalId: general.id, text: '재난으로 인해 부상을 당했습니다.' });
    }
  }
  if (state.campaign && logs.some((log) => log.generalId !== undefined)) state.campaign.revision++;
  logs.push({
    kind,
    text: [...groups]
      .sort(([a], [b]) => a - b)
      .map(([key, count]) => `${state.cities[key]!.name} 일대 ${count}곳`)
      .join(', '),
  });
  return logs;
}

export function expireCityStates(state: WorldState) {
  for (const city of Object.values(state.cities)) {
    if (city.state == null || !city.stateTerm) continue;
    city.stateTerm--;
    if (city.stateTerm === 0) city.state = 0;
  }
}
