import { expect, it } from 'vitest';
import { cloneWorld } from '../model/clone';
import { LINEAGE_EXITED_YEAR } from './config';
import { heirEligibility, lineageAge, lineageDescendants, marriageEligibility } from './eligibility';
import { emptyLineagePerson } from './state';
import { lineageFixture } from './testFixture';

it('AC-P2-32 자기 혼인·미등장·퇴장 장수는 거부하고 입력을 바꾸지 않는다', () => {
  const world = lineageFixture(),
    ids = Object.keys(world.generals).map(Number),
    a = ids[0]!,
    b = ids[1]!;
  const before = structuredClone(world);
  expect(marriageEligibility(world, a, a, 0)?.code).toBe('SELF');
  expect(marriageEligibility(world, a, b, 0)).toBeNull();
  expect(world).toEqual(before);
  world.generals[b]!.activeFromYear = world.startYear + 1;
  expect(marriageEligibility(world, a, b, 0)?.code).toBe('BAD_TARGET');
  world.generals[b]!.activeFromYear = LINEAGE_EXITED_YEAR;
  expect(marriageEligibility(world, a, b, 0)?.code).toBe('BAD_TARGET');
});

it('AC-P2-32 공통 조상과 직계 혈연은 막고 무관한 장수는 허용한다', () => {
  const world = lineageFixture(),
    ids = Object.keys(world.generals).map(Number),
    [parent, a, b, unrelated] = ids;
  const second = ids[4]!;
  world.generals[second]!.sex = 'FEMALE';
  world.generals[unrelated!]!.sex = 'MALE';
  world.lineage!.persons[String(a)] = {
    ...emptyLineagePerson(),
    parents: [parent!, second].sort((x, y) => x - y) as [number, number],
  };
  world.lineage!.persons[String(b)] = {
    ...emptyLineagePerson(),
    parents: [parent!, second].sort((x, y) => x - y) as [number, number],
  };
  expect(marriageEligibility(world, a!, b!, 0)?.code).toBe('KIN');
  expect(marriageEligibility(world, parent!, a!, 0)?.code).toBe('KIN');
  expect(marriageEligibility(world, a!, unrelated!, 0)).toBeNull();
});

it('AC-P2-32 후계자는 범위 안의 자손·같은 국가·조작자 없음·등장 조건을 모두 만족한다', () => {
  const world = lineageFixture(),
    ids = Object.keys(world.generals).map(Number),
    [from, heir, other] = ids;
  world.generals[heir!]!.nationId = world.generals[from!]!.nationId;
  world.generals[heir!]!.userId = null;
  world.lineage!.persons[String(heir)] = {
    ...emptyLineagePerson(),
    parents: [from!, other!].sort((a, b) => a - b) as [number, number],
  };
  expect(heirEligibility(world, from!, heir!, 0)).toBeNull();
  world.generals[heir!]!.userId = 'another-player';
  expect(heirEligibility(world, from!, heir!, 0)?.reason).toBe('HEIR_CONTROLLED');
  world.generals[heir!]!.userId = null;
  world.generals[heir!]!.nationId = null;
  expect(heirEligibility(world, from!, heir!, 0)?.reason).toBe('HEIR_NATION');
  expect(heirEligibility(world, from!, other!, 0)?.reason).toBe('NOT_DESCENDANT');
  world.generals[heir!]!.nationId = world.generals[from!]!.nationId;
  world.generals[heir!]!.activeFromYear = world.startYear + 1;
  expect(heirEligibility(world, from!, heir!, 0)?.reason).toBe('BAD_HEIR');
});

it('AC-P2-32 자손 깊이와 현재 게임 연도의 나이를 계산하며 가문 복제를 격리한다', () => {
  const world = lineageFixture(),
    ids = Object.keys(world.generals).map(Number),
    [parent, child, grandchild, other] = ids;
  world.lineage!.persons[String(child)] = {
    ...emptyLineagePerson(),
    parents: [parent!, other!].sort((a, b) => a - b) as [number, number],
  };
  world.lineage!.persons[String(grandchild)] = {
    ...emptyLineagePerson(),
    parents: [child!, other!].sort((a, b) => a - b) as [number, number],
  };
  expect(lineageDescendants(world, parent!, 1)).toEqual([child]);
  expect(lineageDescendants(world, parent!, 2)).toEqual([child, grandchild]);
  expect(lineageAge(world, parent!, 120_000)).toBe(26);
  const copy = cloneWorld(world);
  copy.lineage!.persons[String(child)]!.heirId = grandchild!;
  expect(world.lineage!.persons[String(child)]!.heirId).toBeNull();
});
