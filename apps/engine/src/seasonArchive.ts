import type { Prisma } from '@opensamguk/db';
import { publicNationPower, type WorldState } from '@opensamguk/rules';

export function activeSeasonGenerals(state: WorldState, year: number) {
  return Object.values(state.generals).filter(
    (general) => general.removedAt === undefined && general.activeFromYear <= year,
  );
}

export function seasonTraitDistribution(state: WorldState, year: number) {
  const counts = (values: (string | null)[]) => {
    const totals = new Map<string, number>();
    for (const value of values) if (value) totals.set(value, (totals.get(value) ?? 0) + 1);
    return [...totals]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
  };
  const generals = activeSeasonGenerals(state, year);
  return {
    philosophies: counts(Object.values(state.nations).map(({ philosophy }) => philosophy)),
    personalities: counts(generals.map(({ personality }) => personality)),
    specialties: counts(generals.map(({ special }) => special)),
  };
}

export function seasonWinnerSummary(
  state: WorldState,
  nationId: number,
  at: { seed: string; tick: number; year: number },
) {
  const nation = state.nations[nationId]!;
  const cities = Object.values(state.cities).filter((city) => city.nationId === nationId && city.kind !== 'PASS');
  return {
    level: nation.level,
    philosophy: nation.philosophy,
    cities: cities.length,
    generals: activeSeasonGenerals(state, at.year).filter((general) => general.nationId === nationId).length,
    power: publicNationPower(state, nationId, at),
    population: cities.reduce((sum, city) => sum + city.population, 0),
    populationMax: cities.reduce((sum, city) => sum + city.populationMax, 0),
    gold: nation.gold,
    rice: nation.rice,
  };
}

export async function persistSeasonArchive(tx: Prisma.TransactionClient, worldId: string, endedYear: number) {
  await tx.$executeRaw`
    INSERT INTO "SeasonGeneral" ("worldId", "generalId", "userId", "name", "nationId", "nationName", "nationColor", "officerLevel", "dedication", "experience", "wins", "captures", "stratagemSuccesses")
    SELECT g."worldId", g."id", g."userId", g."name", n."id", n."name", n."color",
           g."officerLevel", g."dedication", g."experience", g."battleWins", g."captures", g."stratagemSuccesses"
    FROM "General" AS g
    LEFT JOIN "Nation" AS n ON n."worldId" = g."worldId" AND n."id" = g."nationId"
    WHERE g."worldId" = ${worldId} AND g."removedAt" IS NULL AND g."activeFromYear" <= ${endedYear}
  `;
}
