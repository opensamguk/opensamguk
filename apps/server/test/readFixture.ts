import { readFile } from 'node:fs/promises';
import { buildInitialWorld } from '@opensamguk/rules';

export async function readFixture() {
  const readJson = async (path: string): Promise<unknown> =>
    JSON.parse(await readFile(new URL(`../../../resources/${path}`, import.meta.url), 'utf8'));
  const [map, scenario, unitSet, statRules] = await Promise.all([
    readJson('map/che.json'),
    readJson('scenario/1030.json'),
    readJson('unitset/basic.json'),
    readJson('scenario/default.json'),
  ]);
  const state = buildInitialWorld({ map, scenario, unitSet, statRules, seed: 'T1-12-visibility' });
  state.nations = state.nations
    .slice(0, 2)
    .map((nation, index) => ({ ...nation, id: index + 1, capitalCityKey: state.cities[index]!.cityKey }));
  state.cities = state.cities.map((city, index) => ({
    ...city,
    nationId: index === 0 ? 1 : index === 1 ? 2 : null,
    supplied: index === 0,
  }));
  state.generals = state.generals.slice(0, 4).map((general, index) => ({
    ...general,
    id: index + 1,
    nationId: index < 2 ? 1 : index === 2 ? 2 : null,
    cityKey: state.cities[0]!.cityKey,
    nextTurnTick: 500,
    gold: 11001 + index,
    rice: 12001 + index,
    crew: 13001 + index,
    train: 41 + index,
    atmos: 51 + index,
  }));
  state.diplomacies = [];
  return state;
}
