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

export function publicNationPower(cities: number, generals: number, tech: number): number {
  // 도시·장수 수와 함께 공개해도 기술 원값을 역산할 수 없도록 구간만 쓴다.
  return cities + generals + Math.min(11, Math.floor(tech / 1_000));
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
