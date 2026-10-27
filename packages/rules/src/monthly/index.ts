import type { GameDate, Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldState, WorldView } from '../model/world';
import { refreshSupply } from '../supply';

export const MONTHLY_STAGES = ['income', 'population', 'supply', 'diplomacy', 'yearbook'] as const;
export interface NationSummary {
  nationId: number;
  cities: number;
  generals: number;
  power: number;
  gold: number;
  rice: number;
}
export interface Yearbook {
  nations: NationSummary[];
  cities: { cityKey: number; nationId: number | null }[];
}
export const monthlyDate = (startYear: number, tick: number): GameDate => {
  if (!Number.isSafeInteger(tick) || tick <= 0 || tick % TICKS_PER_MONTH !== 0) {
    throw new Error('월간 정산 tick은 양수인 달 경계여야 합니다.');
  }
  const index = tick / TICKS_PER_MONTH - 1;
  return { year: startYear + Math.floor(index / 12), month: (index % 12) + 1 };
};
const citiesById = (state: WorldView) => Object.values(state.cities).sort((a, b) => a.cityKey - b.cityKey);
const generalsById = (state: WorldView) => Object.values(state.generals).sort((a, b) => a.id - b.id);
const nationsById = (state: WorldView) => Object.values(state.nations).sort((a, b) => a.id - b.id);

export function settleIncome(state: WorldView, date: GameDate): WorldState {
  const next = structuredClone(state) as WorldState;
  const resource = [1, 7].includes(date.month) ? 'gold' : [4, 10].includes(date.month) ? 'rice' : null;
  if (!resource) return next;
  for (const nation of nationsById(next)) {
    const income = Math.round(
      citiesById(next)
        .filter((city) => city.nationId === nation.id && city.kind !== 'PASS')
        .reduce(
          (sum, city) =>
            sum +
            city[resource === 'gold' ? 'commerce' : 'agriculture'] *
              (city.population / BALANCE.MONTHLY_POPULATION_UNIT) *
              BALANCE.MONTHLY_TAX_RATE,
          0,
        ),
    );
    const members = generalsById(next).filter(
      (general) => general.nationId === nation.id && general.activeFromYear <= date.year,
    );
    const perGeneral = members.length
      ? Math.floor(Math.round(income * BALANCE.MONTHLY_SALARY_RATE) / members.length)
      : 0;
    next.nations[nation.id]![resource] += income - perGeneral * members.length;
    for (const general of members) next.generals[general.id]![resource] += perGeneral;
  }
  return next;
}

export function settlePopulation(state: WorldView, taxRate: number = BALANCE.MONTHLY_TAX_RATE): WorldState {
  const next = structuredClone(state) as WorldState;
  for (const city of citiesById(next)) {
    if (city.kind === 'PASS') continue;
    const target = next.cities[city.cityKey]!;
    target.population = Math.max(
      0,
      Math.min(
        city.populationMax,
        Math.round(city.population + BALANCE.MONTHLY_SETTLEMENT_RATE * (city.populationMax - city.population)),
      ),
    );
    target.trust = Math.max(
      0,
      Math.min(
        BALANCE.MAX_TRUST,
        Math.round(city.trust + (BALANCE.MONTHLY_TRUST_BASE - taxRate) * BALANCE.MONTHLY_TRUST_FACTOR),
      ),
    );
  }
  return next;
}

export function settleSupply(state: WorldView): WorldState {
  const next = structuredClone(state) as WorldState;
  refreshSupply(next);
  for (const city of citiesById(next)) {
    const target = next.cities[city.cityKey]!;
    // 재야 도시에는 보급 단절 페널티를 부과하지 않는다.
    if (city.nationId === null || target.supplied) continue;
    for (const field of ['agriculture', 'commerce', 'security', 'defence', 'wall'] as const) {
      target[field] = Math.max(0, Math.round(city[field] * BALANCE.UNSUPPLIED_FACTOR));
    }
    for (const general of generalsById(next).filter((general) => general.cityKey === city.cityKey)) {
      next.generals[general.id]!.train = Math.max(0, general.train - BALANCE.UNSUPPLIED_TRAIN_LOSS);
      next.generals[general.id]!.atmos = Math.max(0, general.atmos - BALANCE.UNSUPPLIED_ATMOS_LOSS);
    }
  }
  return next;
}

export function settleDiplomacy(state: WorldView, tick: number): WorldState {
  const next = structuredClone(state) as WorldState;
  next.diplomacies = next.diplomacies
    .flatMap((relation) => {
      if (relation.untilTick > tick || relation.state === 'WAR') return [relation];
      return relation.state === 'DECLARED' ? [{ ...relation, state: 'WAR' as const }] : [];
    })
    .sort((a, b) => a.nationA - b.nationA || a.nationB - b.nationB);
  return next;
}

export function buildYearbook(state: WorldView, year: number): Yearbook {
  return {
    nations: nationsById(state).map((nation) => {
      const cities = citiesById(state).filter((city) => city.nationId === nation.id && city.kind !== 'PASS');
      const generals = generalsById(state).filter(
        (general) => general.nationId === nation.id && general.activeFromYear <= year,
      );
      return {
        nationId: nation.id,
        cities: cities.length,
        generals: generals.length,
        power: Math.round(
          nation.gold +
            nation.rice +
            cities.reduce((sum, city) => sum + city.population, 0) +
            generals.reduce((sum, general) => sum + general.crew, 0),
        ),
        gold: nation.gold,
        rice: nation.rice,
      };
    }),
    cities: citiesById(state).map(({ cityKey, nationId }) => ({ cityKey, nationId })),
  };
}

export function runMonthly(state: WorldView, tick: number, rng: Rng) {
  const date = monthlyDate(state.startYear, tick);
  // 현 단계는 난수를 소비하지 않는다. 재해·사건을 붙일 때 이 스트림만 쓴다.
  void rng;
  let next = settleIncome(state, date);
  next = settlePopulation(next);
  next = settleSupply(next);
  next = settleDiplomacy(next, tick);
  // 미등장 장수는 턴을 쌓지 않는다. 등장 연도 1월에는 원래 offset부터 실행한다.
  for (const general of generalsById(next)) {
    if (general.activeFromYear > date.year) {
      next.generals[general.id]!.nextTurnTick = Math.max(
        general.nextTurnTick,
        tick + (general.nextTurnTick % TICKS_PER_MONTH),
      );
    }
  }
  return { state: next, date, stages: [...MONTHLY_STAGES], yearbook: buildYearbook(next, date.year) };
}
