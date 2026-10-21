import { loadInitialWorld } from '../src/world/resources';

export async function warFixture() {
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'war-database' });
  initial.nations = initial.nations
    .slice(0, 2)
    .map((n, i) => ({ ...n, id: i + 1, capitalCityKey: i + 1, gold: 100000, rice: 100000, tech: 0 }));
  initial.cities = initial.cities.slice(0, 4).map((c, i) => ({
    ...c,
    cityKey: i + 1,
    name: `도시${i + 1}`,
    nationId: [1, 2, null, 1][i]!,
    connections: [[2], [1, 3], [2, 4], [3]][i]!,
    population: 20000,
    populationMax: 50000,
    agriculture: 100,
    agricultureMax: 1000,
    commerce: 100,
    commerceMax: 1000,
    security: 100,
    securityMax: 1000,
    wall: i === 1 ? 10 : 100,
    wallMax: 1000,
    defence: 0,
    defenceMax: 1000,
    trust: 80,
    supplied: i < 2,
  }));
  initial.generals = initial.generals.slice(0, 4).map((g, i) => ({
    ...g,
    id: i + 1,
    nationId: [1, 2, 2, null][i]!,
    cityKey: [1, 2, 2, 3][i]!,
    officerLevel: i < 2 ? 12 : i === 2 ? 1 : 0,
    leadership: 100,
    activeFromYear: 175,
    gold: 100000,
    rice: 100000,
    crew: [10000, 20, 10, 100][i]!,
    crewType: 1100,
    train: 100,
    atmos: 100,
    nextTurnTick: i === 0 ? 100 : 5000,
  }));
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  initial.nationTurns = Object.fromEntries(
    [1, 2].map((id) => [
      id,
      Array.from({ length: 30 }, (_, i) =>
        id === 1 && i === 0
          ? { commandKey: 'nation_reward', args: { generalId: 1, resource: 'gold', amount: 10 } }
          : { commandKey: 'nation_rest', args: {} },
      ),
    ]),
  );
  return initial;
}
