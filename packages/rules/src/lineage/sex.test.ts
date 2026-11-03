import { expect, it } from 'vitest';
import { cloneWorld } from '../model/clone';
import { marriageEligibility } from './eligibility';
import { assertLineageFinal } from './invariants';
import { emptyLineagePerson, initialLineageState } from './state';
import { lineageFixture, lineageTestConfig } from './testFixture';

it('AC-P2-32 확인된 남녀만 혼인하며 미상 성별을 이름이나 직책으로 추정하지 않는다', () => {
  const world = lineageFixture(),
    [a, b] = Object.keys(world.generals).map(Number);
  expect(marriageEligibility(world, a!, b!, 0)).toBeNull();
  world.generals[b!]!.sex = 'MALE';
  expect(marriageEligibility(world, a!, b!, 0)?.code).toBe('SEX_PAIR');
  world.generals[b!]!.sex = 'UNKNOWN';
  expect(marriageEligibility(world, a!, b!, 0)?.code).toBe('SEX_UNKNOWN');
  expect(world.generals[b!]!.sex).toBe('UNKNOWN');
  delete world.generals[b!]!.sex;
  expect(() => initialLineageState(lineageTestConfig, world, 'sex-fixture')).toThrow();
});

it('AC-P2-32 부모는 가주·다른 부모 순서를 보존하며 성별은 순서로 추정하지 않는다', () => {
  const world = lineageFixture(),
    [child, mother, father] = Object.keys(world.generals).map(Number);
  world.lineage!.persons[String(child)] = { ...emptyLineagePerson(), parents: [father!, mother!] };
  expect(() => assertLineageFinal(world, 0)).not.toThrow();
  expect(world.lineage!.persons[String(child)]!.parents).toEqual([father, mother]);
  world.lineage!.persons[String(child)]!.parents = [mother!, father!];
  expect(() => assertLineageFinal(world, 0)).not.toThrow();
  expect(world.lineage!.persons[String(child)]!.parents).toEqual([mother, father]);
  world.generals[father!]!.sex = 'UNKNOWN';
  expect(() => assertLineageFinal(world, 0)).toThrow('남녀');
});

it('AC-P2-32 기존 판 복제에는 성별·가문 필드를 새로 넣지 않는다', () => {
  const world = lineageFixture();
  delete world.lineage;
  world.ruleFeatures = world.ruleFeatures!.filter((feature) => feature !== 'lineage-v1');
  for (const general of Object.values(world.generals)) delete general.sex;
  const copy = cloneWorld(world);
  expect(copy).toEqual(world);
  expect(copy).not.toHaveProperty('lineage');
  for (const general of Object.values(copy.generals)) expect(general).not.toHaveProperty('sex');
});
