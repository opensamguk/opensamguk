import { expect, it } from 'vitest';
import { monthlyFixture } from '../../test/monthlyFixture';
import { prepareInitialWorld, type InitialWorldOptions } from './persistence';

const options: InitialWorldOptions = { name: '시작 방랑 검증', turnTermMinutes: 60, endYear: null };
async function initial() {
  const world = await monthlyFixture();
  world.scenarioKey = 'engine-wandering-fixture';
  world.nations[0]!.capitalCityKey = null;
  for (const city of world.cities) if (city.nationId === 1) city.nationId = null;
  return world;
}

it.each<Partial<InitialWorldOptions>>([{ replayFormat: 1 }, { replayFormat: 'legacy' }, { replayFormat: 'policy' }])(
  'AC-INT-28 시작 방랑도 저장 준비에서 구판 형식을 거부한다 %j',
  async (selection) => {
    const world = await initial();
    expect(() => prepareInitialWorld(world, { ...options, ...selection })).toThrow('형식 3');
  },
);

it.each([{}, { replayFormat: 3 as const }])(
  'AC-INT-28 모든 규칙으로 시작 방랑을 준비하고 원본을 보존한다 %j',
  async (selection) => {
    const world = await initial();
    const before = structuredClone(world);
    expect(
      prepareInitialWorld(world, {
        ...options,
        ...selection,
      }).stateHash,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(world).toEqual(before);
  },
);

it('시작 방랑도 별도 기능 생성 옵션을 받지 않는다', async () => {
  const world = await initial();
  expect(() => prepareInitialWorld(world, { ...options, treatyFormat: 1 })).toThrow('별도 기능');
});
