import {
  financeRates,
  storedFinanceRates,
  NATION_FINANCE_FEATURE,
  rankedPayroll,
  RANKED_PAYROLL_FEATURE,
  WALL_INCOME_FEATURE,
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
type Member = { id: number; dedication: number; activeFromYear: number; removedAt: number | null };
type World = Parameters<typeof worldClock>[0] & {
  startYear: number;
  ruleFeatures: readonly string[];
};

function nextTaxDate(current: { year: number; month: number }, first: number, second: number) {
  const month = current.month <= first ? first : current.month <= second ? second : first;
  return { month, year: current.year + (month < current.month ? 1 : 0) };
}

type NationFinanceSource = {
  philosophy: string;
  financeRates: unknown;
  capitalCityKey: number | null;
  level: number;
  gold?: number;
  rice?: number;
};
const wallIncomeNation = (world: World, nation?: NationFinanceSource | null) =>
  world.ruleFeatures.includes(WALL_INCOME_FEATURE) ? (nation ?? undefined) : undefined;
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
    const income = estimateTaxIncome(
      [city],
      0,
      resource,
      bonuses,
      multiplier,
      effectiveFinanceRates(world, nation),
      0,
      wallIncomeNation(world, nation),
    );
    return {
      ...date,
      amount: income.gross,
      ...(income.wallIncome === undefined ? {} : { wallIncome: income.wallIncome }),
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
    const wall = wallIncomeNation(world, nation);
    const totals = estimateTaxIncome(settlements, members.length, resource, bonuses, multiplier, rates, reserves, wall);
    const ranked = world.ruleFeatures.includes(RANKED_PAYROLL_FEATURE);
    const payments = ranked
      ? rankedPayroll(members, rates.salaryRate, totals.gross + reserves)
      : members.map(() => totals.perGeneral);
    const payroll = payments.reduce((sum, amount) => sum + amount, 0);
    return {
      totals: {
        year,
        month,
        gross: totals.gross,
        ...(totals.wallIncome === undefined ? {} : { wallIncome: totals.wallIncome }),
        payroll,
        net: totals.gross - payroll,
        perGeneral: ranked && members.length ? Math.floor(payroll / members.length) : totals.perGeneral,
      },
      salaries: new Map(members.map(({ id }, index) => [id, payments[index]!])),
      cityGross: new Map(
        settlements.map((city) => [
          city.cityKey,
          estimateTaxIncome([city], 0, resource, bonuses, multiplier, rates, 0, wall).gross,
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
      ...(world.ruleFeatures.includes(RANKED_PAYROLL_FEATURE) ? { rankedPayroll: true as const } : {}),
    },
    salaries: { gold: gold.salaries, rice: rice.salaries },
    cityIncome: new Map(
      settlements.map((city) => [
        city.cityKey,
        { gold: gold.cityGross.get(city.cityKey)!, rice: rice.cityGross.get(city.cityKey)! },
      ]),
    ),
  };
}
