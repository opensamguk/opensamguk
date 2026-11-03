import { expect, it } from 'vitest';
import { emptyCampaignState } from '../campaign/state';
import { LINEAGE_EXITED_YEAR } from './config';
import { assertLineageFinal } from './invariants';
import { emptyLineagePerson } from './state';
import { lineageFixture } from './testFixture';

it('AC-P2-32 혈연의 원본 참조와 비순환을 확인하고 유효한 상태를 바꾸지 않는다', () => {
  const world = lineageFixture(),
    [a, b, c, d] = Object.keys(world.generals).map(Number);
  world.generals[b!]!.sex = 'MALE';
  world.generals[c!]!.sex = world.generals[d!]!.sex = 'FEMALE';
  world.lineage!.persons[String(a)] = {
    ...emptyLineagePerson(),
    parents: [b!, c!].sort((x, y) => x - y) as [number, number],
  };
  const before = structuredClone(world);
  expect(() => assertLineageFinal(world, 0)).not.toThrow();
  expect(world).toEqual(before);
  world.lineage!.persons[String(b)] = {
    ...emptyLineagePerson(),
    parents: [a!, d!].sort((x, y) => x - y) as [number, number],
  };
  expect(() => assertLineageFinal(world, 0)).toThrow('순환');
  world.lineage!.persons[String(b)]!.parents = [d!, 2_000_000];
  expect(() => assertLineageFinal(world, 0)).toThrow('존재하지');
});

it('AC-P2-32 퇴장 표지·조작권·직위·재산과 기록이 함께 정리되어야 한다', () => {
  const world = lineageFixture(),
    id = Number(Object.keys(world.generals)[0]);
  const general = world.generals[id]!;
  world.lineage!.persons[String(id)] = {
    ...emptyLineagePerson(),
    exit: { tick: 10_000, cause: 'DIED', activeFromYear: general.activeFromYear },
  };
  expect(() => assertLineageFinal(world, 10_000)).toThrow('표지');
  general.activeFromYear = LINEAGE_EXITED_YEAR;
  expect(() => assertLineageFinal(world, 10_000)).toThrow('조작권');
  Object.assign(general, { userId: null, nationId: null, officerLevel: 0, crew: 0, gold: 0, rice: 0 });
  expect(() => assertLineageFinal(world, 10_000)).not.toThrow();
  for (const person of Object.values(world.generals)) Object.assign(person, { politics: 50, charm: 50 });
  world.campaign = emptyCampaignState(world, 'lineage-test', 'fixture');
  world.campaign!.units.push({ id: 100, ownerId: id, commanderId: id, troops: 0, crewType: 1, train: 0, atmos: 0 });
  expect(() => assertLineageFinal(world, 10_000)).toThrow('부곡');
});

it('AC-P2-32 같은 사람에게 장수 둘의 조작권을 남기거나 부모 없는 출생을 저장할 수 없다', () => {
  const world = lineageFixture(),
    [a, b] = Object.keys(world.generals).map(Number);
  const before = structuredClone(world);
  world.generals[a!]!.userId = world.generals[b!]!.userId = 'lineage-controller';
  expect(() => assertLineageFinal(world, 0)).toThrow('한 명');
  Object.assign(world.generals[b!]!, before.generals[b!]!);
  world.lineage!.persons[String(a)] = { ...emptyLineagePerson(), bornTick: 0 };
  expect(() => assertLineageFinal(world, 0)).toThrow('부모 둘');
});
