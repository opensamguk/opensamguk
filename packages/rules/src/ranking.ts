// 국력 구성 참고: core2026 df6c926, monthlyNationStatsHandler.ts (MIT, resources/NOTICE.md).
import { rngFor } from '@opensamguk/shared';
import type { WorldView } from './model/world';

export type GeneralRankingBy = 'dedication' | 'experience' | 'merit';
export type NationRankingBy = 'cities' | 'generals' | 'power';

export interface GeneralRankingRow {
  id: number;
  name: string;
  nation: { id: number; name: string; color: string } | null;
  dedication: number;
  experience: number;
  wins: number;
  captures: number;
}

export interface NationRankingRow {
  id: number;
  name: string;
  color: string;
  cities: number;
  generals: number;
  power: number;
}

export type RankedGeneral = GeneralRankingRow & { rank: number; value: number; merit: number };
export type RankedNation = NationRankingRow & { rank: number; value: number };

export function publicNationPower(
  state: WorldView,
  nationId: number,
  at: { seed: string; tick: number; year: number },
): number {
  const nation = state.nations[nationId];
  if (!nation) return 0;
  const generals = Object.values(state.generals)
    .filter((general) => general.nationId === nationId && general.activeFromYear <= at.year)
    .sort((a, b) => a.id - b.id);
  const cities = Object.values(state.cities)
    .filter((city) => city.nationId === nationId && city.supplied)
    .sort((a, b) => a.cityKey - b.cityKey);
  const resources = generals.reduce((sum, general) => sum + general.gold + general.rice, nation.gold + nation.rice);
  let population = 0,
    current = 0,
    maximum = 0;
  for (const city of cities) {
    population += city.population;
    current += city.population + city.agriculture + city.commerce + city.security + city.wall + city.defence;
    maximum +=
      city.populationMax + city.agricultureMax + city.commerceMax + city.securityMax + city.wallMax + city.defenceMax;
  }
  const cityPower = maximum > 0 ? Math.round((population * current) / maximum / 100) : 0;
  let generalPower = 0,
    experience = 0;
  for (const general of generals) {
    generalPower +=
      (general.leadership >= 40 ? general.leadership * 2 : 0) +
      Math.sqrt(general.intel * general.strength) +
      general.leadership / 4;
    experience += general.experience + general.dedication;
  }
  const base = Math.round(
    (Math.round(resources / 100) + nation.tech + cityPower + generalPower + Math.round(experience / 100)) / 10,
  );
  const multiplier = 0.95 + rngFor(at.seed, 'ranking-power', at.tick, nationId).next() * 0.1;
  return Math.round(base * multiplier);
}

export function generalMerit(wins: number, captures: number): number {
  return wins + captures;
}

export function rankGenerals(rows: readonly GeneralRankingRow[], by: GeneralRankingBy): RankedGeneral[] {
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      nation: row.nation ? { id: row.nation.id, name: row.nation.name, color: row.nation.color } : null,
      dedication: row.dedication,
      experience: row.experience,
      wins: row.wins,
      captures: row.captures,
      merit: generalMerit(row.wins, row.captures),
      value: by === 'merit' ? generalMerit(row.wins, row.captures) : row[by],
    }))
    .sort((a, b) => b.value - a.value || a.id - b.id)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function rankNations(rows: readonly NationRankingRow[], by: NationRankingBy): RankedNation[] {
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      cities: row.cities,
      generals: row.generals,
      power: row.power,
      value: row[by],
    }))
    .sort((a, b) => b.value - a.value || a.id - b.id)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
