import { expect, it } from 'vitest';
import { warFixture } from '../../test/warFixture';
import { prepareInitialWorld, type InitialWorldOptions } from './persistence';

const options: InitialWorldOptions = { name: '시작 방랑 검증', turnTermMinutes: 60, endYear: null };
async function initial() {
  const world = await warFixture();
  world.nations[0]!.capitalCityKey = null;
  for (const city of world.cities) if (city.nationId === 1) city.nationId = null;
  return world;
}

it.each<Partial<InitialWorldOptions>>([
  {},
  { replayFormat: 1 },
  { replayFormat: 'legacy' },
  { replayFormat: 'policy' },
  { treatyFormat: 1 },
  { ruleFeatures: ['personnel'] },
])('시작 방랑은 저장 준비에서 기존 형식과 기능 비활성 조합을 거부한다 %j', async (selection) => {
  const world = await initial();
  expect(() => prepareInitialWorld(world, { ...options, ...selection })).toThrow('시작 방랑');
});

it('형식 3과 명시한 인사·국가 변천 조합을 준비하고 원본을 보존한다', async () => {
  const world = await initial();
  const before = structuredClone(world);
  expect(
    prepareInitialWorld(world, {
      ...options,
      replayFormat: 3,
      ruleFeatures: ['nation-lifecycle-v1', 'personnel'],
    }).stateHash,
  ).toMatch(/^[0-9a-f]{64}$/);
  expect(world).toEqual(before);
});
