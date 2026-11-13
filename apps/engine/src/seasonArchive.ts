import type { Prisma } from '@opensamguk/db';
import { publicNationPower, readCampaignState, type WorldState } from '@opensamguk/rules';

export function activeSeasonGenerals(state: WorldState, year: number) {
  return Object.values(state.generals).filter(
    (general) => general.removedAt === undefined && general.activeFromYear <= year,
  );
}

export function nationTroopTotals(state: WorldState, year: number) {
  const totals = new Map<number, number>();
  const active = new Map(activeSeasonGenerals(state, year).map((general) => [general.id, general]));
  const campaign = state.ruleFeatures?.includes('campaign-v1') ? readCampaignState(state.campaign, state) : undefined;
  const add = (nationId: number | null | undefined, troops: number) => {
    if (nationId != null) totals.set(nationId, (totals.get(nationId) ?? 0) + troops);
  };
  if (campaign) {
    for (const unit of campaign.units) {
      if (active.has(unit.commanderId)) add(active.get(unit.ownerId)?.nationId, unit.troops);
    }
  } else {
    for (const general of active.values()) add(general.nationId, general.crew);
  }
  return totals;
}

export function finalNationSummaries(state: WorldState, year: number, nationIds: readonly number[]) {
  const troops = nationTroopTotals(state, year);
  const members = new Map<number, { generalId: number; name: string; portraitId: number | null }[]>();
  for (const general of activeSeasonGenerals(state, year)) {
    if (general.nationId === null) continue;
    const roster = members.get(general.nationId) ?? [];
    roster.push({ generalId: general.id, name: general.name, portraitId: general.portraitId });
    members.set(general.nationId, roster);
  }
  return nationIds.map((nationId) => {
    const { name, color, philosophy, level, tech } = state.nations[nationId]!;
    return {
      nationId,
      name,
      color,
      philosophy,
      level,
      tech,
      troops: troops.get(nationId) ?? 0,
      roster: (members.get(nationId) ?? []).sort((a, b) => a.generalId - b.generalId),
    };
  });
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
