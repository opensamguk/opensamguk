import { createDb, readPublishedResources } from '@opensamguk/db';
import { buildInitialWorld } from '@opensamguk/rules';

export async function readFixture() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL을 설정하세요.');
  const db = createDb(connectionString);
  let contents: unknown[];
  try {
    contents = (
      await readPublishedResources(db, [
        { kind: 'MAP', name: 'che', version: 1 },
        { kind: 'SCENARIO', name: '1030', version: 1 },
        { kind: 'UNIT_SET', name: 'basic', version: 1 },
        { kind: 'STAT_RULES', name: 'default', version: 1 },
      ])
    ).map(({ content }) => content);
  } finally {
    await db.$disconnect();
  }
  const [map, scenario, unitSet, statRules] = contents;
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
