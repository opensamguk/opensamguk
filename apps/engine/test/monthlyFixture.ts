import { loadInitialWorld } from '../src/world/resources';

export async function monthlyFixture() {
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'monthly-golden' });
  initial.nations = initial.nations.slice(0, 2).map((nation, i) => ({
    ...nation,
    id: i + 1,
    gold: 100,
    rice: 200,
    capitalCityKey: i === 0 ? 1 : 4,
  }));
  initial.cities = initial.cities.slice(0, 4).map((city, i) => ({
    ...city,
    cityKey: i + 1,
    name: `도시${i + 1}`,
    nationId: i % 2 === 0 ? 1 : 2,
    connections: [[2], [1, 3, 4], [2], [2]][i]!,
    population: 1000,
    populationMax: 2000,
    agriculture: 200,
    agricultureMax: 1000,
    commerce: 100,
    commerceMax: 1000,
    security: 50,
    securityMax: 1000,
    defence: 50,
    defenceMax: 1000,
    wall: 50,
    wallMax: 1000,
    trust: 80,
    supplied: true,
  }));
  initial.generals = initial.generals.slice(0, 3).map((general, i) => ({
    ...general,
    id: i + 1,
    nationId: i === 1 ? 2 : 1,
    cityKey: [3, 4, 1][i]!,
    activeFromYear: i === 2 ? initial.startYear + 1 : initial.startYear,
    nextTurnTick: [100, 10000, 500][i]!,
    gold: 1000,
    rice: 1000,
    train: 30,
    atmos: 40,
    injury: 2,
  }));
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'DECLARED', untilTick: 10000 }];
  return initial;
}
