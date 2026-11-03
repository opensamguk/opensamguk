import { expect, it } from 'vitest';
import { generateLineageChild, type LineageResources } from './birth';
import { lineageFixture } from './testFixture';

export const birthResources: LineageResources = {
  statRules: { total: 180, min: 0, max: 100 },
  unitSet: { defaultCrewTypeId: 1 },
};
function parents() {
  const world = lineageFixture(),
    [a, b] = Object.keys(world.generals).map(Number);
  world.generals[b!]!.name = '제갈부';
  world.lineage!.marriages = [{ id: 1, a: a!, b: b!, householdGeneralId: b!, sinceTick: 0 }];
  world.lineage!.nextMarriageId = 2;
  return { world, a: a!, b: b! };
}

it('AC-P2-32 출생은 같은 원본·시드에서 재현되며 가주 소속·복성을 따르고 통화를 만들지 않는다', () => {
  const { world, a, b } = parents(),
    before = structuredClone(world);
  const first = generateLineageChild(world, 1, 10_000, birthResources),
    again = generateLineageChild(world, 1, 10_000, birthResources);
  expect(first).toEqual(again);
  expect(first.ok).toBe(true);
  expect(world).toEqual(before);
  if (!first.ok) throw Error(first.message);
  expect(first.general).toMatchObject({
    userId: null,
    gold: 0,
    rice: 0,
    age: 0,
    crew: 0,
    experience: 0,
    dedication: 0,
    injury: 0,
    nationId: world.generals[b]!.nationId,
    cityKey: world.generals[b]!.cityKey,
    birthYear: world.startYear,
    activeFromYear: world.startYear + 16,
    officerLevel: 1,
  });
  expect(first.general.name.startsWith('제갈')).toBe(true);
  expect(first.person.parents).toEqual([b, a]);
  expect(first.general).not.toHaveProperty('politics');
  expect(first.general).not.toHaveProperty('charm');
});

it('AC-P2-32 성별 전용 난수는 능력치·이름·수명·턴 순서를 바꾸지 않는다', () => {
  const { world } = parents();
  world.lineage!.config.birth.femaleBp = 0;
  const male = generateLineageChild(world, 1, 10_000, birthResources);
  world.lineage!.config.birth.femaleBp = 10_000;
  const female = generateLineageChild(world, 1, 10_000, birthResources);
  expect(male.ok && female.ok).toBe(true);
  if (!male.ok || !female.ok) throw Error('출생 실패');
  expect(male.general.sex).toBe('MALE');
  expect(female.general.sex).toBe('FEMALE');
  expect({ ...male.general, sex: 'FEMALE' }).toEqual(female.general);
});

it('AC-P2-32 다섯 능력치는 원본 범위로 물려받으며 사람 생성의 합계 제한으로 다시 깎지 않는다', () => {
  const { world, a, b } = parents();
  for (const id of [a, b])
    Object.assign(world.generals[id]!, { leadership: 100, strength: 100, intel: 100, politics: 100, charm: 100 });
  world.ruleFeatures!.push('five-stats');
  world.lineage!.config.birth.statSpread = 0;
  const born = generateLineageChild(world, 1, 10_000, {
    ...birthResources,
    statRules: { count: 5, total: 275, min: 15, max: 90 },
  });
  expect(born.ok).toBe(true);
  if (!born.ok) throw Error(born.message);
  expect(born.general).toMatchObject({ leadership: 90, strength: 90, intel: 90, politics: 90, charm: 90 });
});

it('AC-P2-32 이름이 소진되거나 부모 자료가 불명확하면 장수나 돈을 부분 생성하지 않는다', () => {
  const { world } = parents(),
    ids = Object.keys(world.generals).map(Number);
  for (const [index, name] of ['가', '나', '다'].entries()) world.generals[ids[index + 2]!]!.name = `제갈${name}`;
  const before = structuredClone(world);
  expect(generateLineageChild(world, 1, 10_000, birthResources)).toMatchObject({ ok: false, code: 'NAME_EXHAUSTED' });
  expect(world).toEqual(before);
  world.generals[ids[0]!]!.sex = 'UNKNOWN';
  expect(generateLineageChild(world, 1, 10_000, birthResources)).toMatchObject({ ok: false, code: 'SEX_PAIR' });
});
