import {
  financeRates,
  storedFinanceRates,
  NATION_FINANCE_FEATURE,
  estimateTaxIncome,
  nationPhilosophy,
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

function nextTaxDate(current: { year: number; month: number }, first: number, second: number) {
  const month = current.month <= first ? first : current.month <= second ? second : first;
  return { month, year: current.year + (month < current.month ? 1 : 0) };
}

type NationFinanceSource = { philosophy: string; financeRates: unknown; gold?: number; rice?: number };
export const effectiveFinanceRates = (world: World, nation?: NationFinanceSource | null) =>
  financeRates(
    world.ruleFeatures.includes(NATION_FINANCE_FEATURE) ? storedFinanceRates(nation?.financeRates) : undefined,
  );

export function projectCityIncome(
  world: World,
  now: number,
  city: City,
  state?: WorldView,
  nation?: NationFinanceSource | null,
) {
  const current = toGameDate(world.startYear, nowTick(worldClock(world), now));
  const estimate = (resource: 'gold' | 'rice', first: number, second: number) => {
    const date = nextTaxDate(current, first, second);
    const bonuses = state?.officeEffects ? residentOfficeBonuses(state, date.year) : undefined;
    const multiplier = nationPhilosophy(world, nation?.philosophy)?.[resource];
    return {
      ...date,
      amount: estimateTaxIncome([city], 0, resource, bonuses, multiplier, effectiveFinanceRates(world, nation)).gross,
    };
  };
  return { gold: estimate('gold', 1, 7), rice: estimate('rice', 4, 10) };
}

export function nationPopulation(settlements: readonly City[]) {
  return {
    population: settlements.reduce((sum, city) => sum + city.population, 0),
    populationMax: settlements.reduce((sum, city) => sum + city.populationMax, 0),
  };
}

export function projectNationFinance(
  world: World,
  now: number,
  settlements: readonly City[],
  generals: readonly Member[],
  state?: WorldView,
  nation?: NationFinanceSource,
) {
  const current = toGameDate(world.startYear, nowTick(worldClock(world), now));
  const estimate = (resource: 'gold' | 'rice', first: number, second: number) => {
    const { year, month } = nextTaxDate(current, first, second);
    const members = generals.filter((general) => general.removedAt === null && general.activeFromYear <= year);
    const bonuses = state?.officeEffects ? residentOfficeBonuses(state, year) : undefined;
    const multiplier = nationPhilosophy(world, nation?.philosophy)?.[resource];
    const rates = effectiveFinanceRates(world, nation);
    const reserves = world.ruleFeatures.includes('city-resources-v1') ? 0 : (nation?.[resource] ?? 0);
    return {
      totals: {
        year,
        month,
        ...estimateTaxIncome(settlements, members.length, resource, bonuses, multiplier, rates, reserves),
      },
      cityGross: new Map(
        settlements.map((city) => [
          city.cityKey,
          estimateTaxIncome([city], 0, resource, bonuses, multiplier, rates).gross,
        ]),
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
