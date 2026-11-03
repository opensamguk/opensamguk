import { governanceFixture } from '../governance/testFixture';
import type { LineageConfig } from './config';
import { initialLineageState } from './state';

// 시험 설정이다. 공개 프로필의 기본값이 아니다.
export const lineageTestConfig: LineageConfig = {
  version: 1,
  marriage: {
    minAge: 16,
    maxAge: 80,
    maxSpouses: 1,
    kinDepth: 3,
    offerMonths: 6,
    npc: { perMonth: 10, affinityGap: 149, chanceBp: 10_000 },
  },
  birth: {
    minParentAge: 16,
    maxParentAge: 80,
    chanceBp: 10_000,
    comingOfAgeYears: 16,
    femaleBp: 5000,
    statSpread: 2,
    lifespan: { min: 60, max: 80 },
    givenNames: ['가', '나', '다'],
    compoundSurnames: ['공손', '제갈'],
  },
  heir: { depth: 3 },
  limits: { maxGenerals: 1000, maxBirthsPerYear: 10, sentOffers: 3, receivedOffers: 3, worldOffers: 100 },
};
export function lineageFixture() {
  const world = governanceFixture();
  world.ruleFeatures!.push('lineage-v1');
  for (const [index, general] of Object.values(world.generals).entries())
    general.sex = index % 2 === 0 ? 'MALE' : 'FEMALE';
  world.lineage = initialLineageState(lineageTestConfig, world, 'lineage-fixture');
  for (const general of Object.values(world.generals)) {
    general.birthYear = world.startYear - 25;
    general.deathYear = world.startYear + 50;
  }
  return world;
}
