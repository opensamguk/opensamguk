import {
  BALANCE,
  estimateTaxIncome,
  nowTick,
  residentOfficeBonuses,
  toGameDate,
  type WorldView,
} from '@opensamguk/rules';
import { worldClock } from '../queries';

type TaxCity = Parameters<typeof estimateTaxIncome>[0][number];
type City = TaxCity & { populationMax: number };
type Member = { activeFromYear: number; removedAt: number | null };
type World = Parameters<typeof worldClock>[0] & {
  startYear: number;
  ruleFeatures: readonly string[];
};

export function nationPopulation(settlements: readonly City[]) {
  return {
    population: settlements.reduce((sum, city) => sum + city.population, 0),
    populationMax: settlements.reduce((sum, city) => sum + city.populationMax, 0),
  };
}

export const salaryRate = BALANCE.MONTHLY_SALARY_RATE;

export function projectNationFinance(
  world: World,
  now: number,
  settlements: readonly City[],
  generals: readonly Member[],
  state?: WorldView,
) {
  const current = toGameDate(world.startYear, nowTick(worldClock(world), now));
  const estimate = (resource: 'gold' | 'rice', first: number, second: number) => {
    const month = current.month <= first ? first : current.month <= second ? second : first;
    const year = current.year + (month < current.month ? 1 : 0);
    const members = generals.filter((general) => general.removedAt === null && general.activeFromYear <= year);
    const bonuses = state?.officeEffects ? residentOfficeBonuses(state, year) : undefined;
    return {
      totals: { year, month, ...estimateTaxIncome(settlements, members.length, resource, bonuses) },
      cityGross: new Map(
        settlements.map((city) => [city.cityKey, estimateTaxIncome([city], 0, resource, bonuses).gross]),
      ),
    };
  };
  const gold = estimate('gold', 1, 7);
  const rice = estimate('rice', 4, 10);
  return {
    financeEstimate: {
      gold: gold.totals,
      rice: rice.totals,
      destination: world.ruleFeatures.includes('city-resources-v1') ? ('city' as const) : ('nation' as const),
    },
    cityIncome: new Map(
      settlements.map((city) => [
        city.cityKey,
        { gold: gold.cityGross.get(city.cityKey)!, rice: rice.cityGross.get(city.cityKey)! },
      ]),
    ),
  };
}
