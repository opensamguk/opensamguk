import type { GameDate, Rng } from '@opensamguk/shared';
import { COURT_PROMOTION_FEATURE, promoteNationCourts } from '../personnel/nationRank';
import { nationPhilosophy } from '../personnel/nationPhilosophy';
import { BALANCE } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldState, WorldView } from '../model/world';
import { refreshSupply } from '../supply';
import { readCampaignState } from '../campaign/state';
import { residentOfficeBonuses, type OfficeBonuses } from '../personnel/residentOffice';
import { applyCityResourceIncome } from '../cityResourceIncome';
import { CITY_SEASONAL_EVENTS_FEATURE, settleCitySeasonalEvents } from './citySeasonalEvents';
import { financeRates, rankedPayroll, RANKED_PAYROLL_FEATURE } from '../personnel/financeRates';

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
const generalsById = (state: WorldView) =>
  Object.values(state.generals)
    .filter((general) => general.removedAt === undefined)
    .sort((a, b) => a.id - b.id);
const nationsById = (state: WorldView) => Object.values(state.nations).sort((a, b) => a.id - b.id);

export function estimateTaxIncome(
  cities: readonly { cityKey: number; commerce: number; agriculture: number; population: number }[],
  memberCount: number,
  resource: 'gold' | 'rice',
  bonuses?: ReturnType<typeof residentOfficeBonuses>,
  incomeMultiplier = 1,
  rates = financeRates(),
  reserves = 0,
) {
  const gross = Math.round(
    incomeMultiplier *
      cities.reduce(
        (sum, city) =>
          sum +
          city[resource === 'gold' ? 'commerce' : 'agriculture'] *
            (city.population / BALANCE.MONTHLY_POPULATION_UNIT) *
            rates.taxRate *
            (1 + (bonuses?.get(city.cityKey)?.tax?.percent ?? 0) / 100),
        0,
      ),
  );
  const payrollBudget = Math.min(gross + reserves, Math.round(gross * rates.salaryRate));
  const perGeneral = memberCount ? Math.floor(payrollBudget / memberCount) : 0;
  const payroll = perGeneral * memberCount;
  return { gross, perGeneral, payroll, net: gross - payroll };
}

export function settleIncome(
  state: WorldView,
  date: GameDate,
  bonuses = residentOfficeBonuses(state, date.year),
): WorldState {
  const next = structuredClone(state) as WorldState;
  const resource = [1, 7].includes(date.month) ? 'gold' : [4, 10].includes(date.month) ? 'rice' : null;
  if (!resource) return next;
  for (const nation of nationsById(next)) {
    const cities = citiesById(next).filter((city) => city.nationId === nation.id && city.kind !== 'PASS');
    const members = generalsById(next).filter(
      (general) => general.nationId === nation.id && general.activeFromYear <= date.year,
    );
    const multiplier = nationPhilosophy(next, nation.philosophy)?.[resource];
    const reserves = next.ruleFeatures?.includes('city-resources-v1') ? 0 : nation[resource];
    const rates = financeRates(nation.financeRates);
    const { gross, net, perGeneral } = estimateTaxIncome(
      cities,
      members.length,
      resource,
      bonuses,
      multiplier,
      rates,
      reserves,
    );
    if (next.ruleFeatures?.includes(RANKED_PAYROLL_FEATURE)) {
      const payments = rankedPayroll(members, rates.salaryRate, gross + reserves);
      next.nations[nation.id]![resource] += gross - payments.reduce((sum, payment) => sum + payment, 0);
      members.forEach((general, index) => (next.generals[general.id]![resource] += payments[index]!));
    } else {
      next.nations[nation.id]![resource] += net;
      for (const general of members) next.generals[general.id]![resource] += perGeneral;
    }
  }
  return next;
}

export function settlePopulation(state: WorldView, taxRate: number = BALANCE.MONTHLY_TAX_RATE): WorldState {
  const next = structuredClone(state) as WorldState;
  for (const city of citiesById(next)) {
    if (city.kind === 'PASS') continue;
    const target = next.cities[city.cityKey]!;
    const nation = city.nationId === null ? undefined : state.nations[city.nationId];
    const growth = nationPhilosophy(state, nation?.philosophy)?.population ?? 1;
    target.population = Math.max(
      0,
      Math.min(
        city.populationMax,
        Math.round(city.population + BALANCE.MONTHLY_SETTLEMENT_RATE * (city.populationMax - city.population) * growth),
      ),
    );
    target.trust = Math.max(
      0,
      Math.min(
        BALANCE.MAX_TRUST,
        Math.round(
          city.trust +
            (BALANCE.MONTHLY_TRUST_BASE -
              (nation?.financeRates ? financeRates(nation.financeRates).taxRate : taxRate)) *
              BALANCE.MONTHLY_TRUST_FACTOR,
        ),
      ),
    );
  }
  return next;
}

export function settleSupply(state: WorldView, bonuses: OfficeBonuses = new Map()): WorldState {
  const next = structuredClone(state) as WorldState;
  const campaign = state.ruleFeatures?.includes('campaign-v1') ? readCampaignState(next.campaign, next) : undefined;
  if (campaign) next.campaign = campaign;
  refreshSupply(next);
  for (const city of citiesById(next)) {
    const target = next.cities[city.cityKey]!;
    // 재야 도시에는 보급 단절 페널티를 부과하지 않는다.
    if (city.nationId === null || target.supplied) continue;
    const loss = (100 - (bonuses.get(city.cityKey)?.supplyLoss?.percent ?? 0)) / 100;
    for (const field of ['agriculture', 'commerce', 'security', 'defence', 'wall'] as const) {
      const factor = loss === 1 ? BALANCE.UNSUPPLIED_FACTOR : 1 - (1 - BALANCE.UNSUPPLIED_FACTOR) * loss;
      target[field] = Math.max(0, Math.round(city[field] * factor));
    }
    if (campaign) {
      for (const unit of campaign.units.filter((unit) => next.generals[unit.commanderId]!.cityKey === city.cityKey)) {
        unit.train = Math.max(0, unit.train - Math.round(BALANCE.UNSUPPLIED_TRAIN_LOSS * loss));
        unit.atmos = Math.max(0, unit.atmos - Math.round(BALANCE.UNSUPPLIED_ATMOS_LOSS * loss));
      }
    } else {
      for (const general of generalsById(next).filter((general) => general.cityKey === city.cityKey)) {
        next.generals[general.id]!.train = Math.max(
          0,
          general.train - Math.round(BALANCE.UNSUPPLIED_TRAIN_LOSS * loss),
        );
        next.generals[general.id]!.atmos = Math.max(
          0,
          general.atmos - Math.round(BALANCE.UNSUPPLIED_ATMOS_LOSS * loss),
        );
      }
    }
  }
  if (campaign && JSON.stringify(campaign.units) !== JSON.stringify(state.campaign!.units)) {
    if (campaign.revision === 2_147_483_647) throw new Error('휘하 변경 번호 한도를 넘었습니다.');
    campaign.revision++;
    readCampaignState(campaign, next);
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
  const campaign = state.ruleFeatures?.includes('campaign-v1') ? readCampaignState(state.campaign, state) : undefined;
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
            (campaign
              ? campaign.units
                  .filter(
                    (unit) =>
                      generals.some((general) => general.id === unit.ownerId) &&
                      state.generals[unit.commanderId]!.activeFromYear <= year,
                  )
                  .reduce((sum, unit) => sum + unit.troops, 0)
              : generals.reduce((sum, general) => sum + general.crew, 0)),
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
  const bonuses = residentOfficeBonuses(state, date.year);
  let next = settleIncome(state, date, bonuses);
  if (state.ruleFeatures?.includes('city-resources-v1')) next = applyCityResourceIncome(state, next, date, bonuses);
  next = settlePopulation(next);
  next = settleSupply(next, bonuses);
  next = settleDiplomacy(next, tick);
  if (state.ruleFeatures?.includes(COURT_PROMOTION_FEATURE)) promoteNationCourts(next);
  const seasonalEventLogs = state.ruleFeatures?.includes(CITY_SEASONAL_EVENTS_FEATURE)
    ? settleCitySeasonalEvents(next, date, rng)
    : [];
  // 미등장 장수는 턴을 쌓지 않는다. 등장 연도 1월에는 원래 offset부터 실행한다.
  for (const general of generalsById(next)) {
    if (general.activeFromYear > date.year) {
      next.generals[general.id]!.nextTurnTick = Math.max(
        general.nextTurnTick,
        tick + (general.nextTurnTick % TICKS_PER_MONTH),
      );
    }
  }
  const officeTaxLogs: { generalId: number; text: string }[] = [];
  const field = [1, 7].includes(date.month) ? 'commerce' : [4, 10].includes(date.month) ? 'agriculture' : null;
  if (field) {
    for (const [cityKey, { tax }] of bonuses) {
      if (!tax) continue;
      const city = state.cities[cityKey]!;
      if (city[field] > 0 && city.population > 0)
        officeTaxLogs.push({ generalId: tax.generalId, text: `${city.name} 주재로 세수 ${tax.percent}% 보정` });
    }
  }
  return {
    state: next,
    date,
    officeTaxLogs,
    seasonalEventLogs,
    stages: [...MONTHLY_STAGES],
    yearbook: buildYearbook(next, date.year),
  };
}
