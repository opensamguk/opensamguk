import type { Prisma } from '@opensamguk/db';
import { publicNationPower, type WorldState } from '@opensamguk/rules';

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
    generals: Object.values(state.generals).filter(
      (general) =>
        general.nationId === nationId && general.removedAt === undefined && general.activeFromYear <= at.year,
    ).length,
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
