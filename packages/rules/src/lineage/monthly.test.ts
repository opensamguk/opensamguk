import { expect, it } from 'vitest';
import { decideLineageAction } from './actions';
import type { LineageResources } from './birth';
import { settleLineageMonthly } from './monthly';
import { emptyLineagePerson } from './state';
import { lineageFixture } from './testFixture';
import { hashState } from '@opensamguk/shared/node';
import { lineageConfigSchema } from './config';

const resources: LineageResources = { statRules: { total: 180, min: 0, max: 100 }, unitSet: { defaultCrewTypeId: 1 } };

function birthWorld() {
  const world = lineageFixture(),
    [a, b] = Object.keys(world.generals).map(Number);
  world.lineage!.config.marriage.npc.perMonth = 0;
  world.lineage!.config.birth.chanceBp = 10000;
  world.lineage!.config.birth.givenNames = ['가', '나', '다', '라', '마', '바'];
  world.lineage!.config.limits.maxBirthsPerYear = 3;
  world.lineage!.marriages = [{ id: 1, a: a!, b: b!, householdGeneralId: a!, sinceTick: 0 }];
  world.lineage!.nextMarriageId = 2;
  return world;
}

it('AC-P2-32 주기를 생략한 기존 설정의 12개월 출생과 변경 전 전체 상태 해시를 보존한다', () => {
  let world = birthWorld();
  const births: number[] = [];
  for (let month = 1; month <= 12; month++) {
    const result = settleLineageMonthly(world, month * 10000, resources);
    world = result.state;
    births.push(result.effects.births.length);
  }
  expect(births).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(hashState(world)).toBe('d00fb76e73d1ae62ae4aaf3e609338cb2e6b9093b6df8c1e19b443fdda68bbf3');
  expect(world.lineage!.config.version).toBe(1);
});

it('AC-P2-32 월 출산은 매월 추첨하되 같은 해의 이전 출생을 합산하고 새해에 상한을 다시 센다', () => {
  let world = birthWorld();
  world.lineage!.config.version = 2;
  const source = structuredClone(world),
    births: number[] = [];
  for (let month = 1; month <= 13; month++) {
    const result = settleLineageMonthly(world, month * 10000, resources);
    if (month === 1) expect(world).toEqual(source);
    world = result.state;
    births.push(result.effects.births.length);
    if (month === 4) expect(result.effects.skippedBirths).toEqual([{ marriageId: 1, reason: 'LIMIT' }]);
  }
  expect(births).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

it('AC-P2-32 가문 설정은 기존 연 출산1과 새 월 출산2만 허용한다', () => {
  const config = birthWorld().lineage!.config;
  expect(lineageConfigSchema.safeParse({ ...config, version: 3 }).success).toBe(false);
});
it('AC-P2-32 12월 정산은 다음 해 등장 NPC를 사망·혼인 후보로 앞당기지 않는다', () => {
  const world = lineageFixture(),
    id = Object.keys(world.generals).map(Number)[1]!;
  world.lineage!.monthlyTick = 110_000;
  world.lineage!.config.birth.chanceBp = 0;
  Object.assign(world.generals[id]!, {
    userId: null,
    activeFromYear: world.startYear + 1,
    deathYear: world.startYear - 1,
    officerLevel: 0,
  });
  const result = settleLineageMonthly(world, 120_000, resources);
  expect(result.effects.deaths.some((d) => d.generalId === id)).toBe(false);
  expect(result.effects.marriages.some((m) => m.a === id || m.b === id)).toBe(false);
  expect(result.state.lineage!.revision).toBe(world.lineage!.revision + 1);
});
function fixture() {
  const world = lineageFixture();
  world.lineage!.config.marriage.npc.perMonth = 0;
  world.lineage!.config.birth.chanceBp = 0;
  return world;
}
it('AC-P2-32 사람이 지정한 자손은 NPC 자동 계승이 가져가지 않는다', () => {
  const world = fixture(),
    [human, npc, heir] = Object.keys(world.generals).map(Number),
    parent = world.generals[npc!]!;
  Object.assign(world.generals[human!]!, { userId: 'reserved-player', nationId: parent.nationId, officerLevel: 1 });
  Object.assign(parent, { userId: null, deathYear: world.startYear - 1, crew: 0, gold: 100, rice: 200 });
  Object.assign(world.generals[heir!]!, {
    userId: null,
    nationId: parent.nationId,
    cityKey: parent.cityKey,
    officerLevel: 1,
    crew: 0,
    gold: 40,
    rice: 50,
  });
  world.lineage!.persons[String(heir)] = { ...emptyLineagePerson(), parents: [npc!, human!] };
  world.lineage!.persons[String(human)] = { ...emptyLineagePerson(), heirId: heir! };
  const next = settleLineageMonthly(world, 10000, resources);
  expect(next.effects.deaths).toContainEqual({
    generalId: npc,
    successorId: null,
    loss: { gold: 100, rice: 200, troops: 0 },
  });
  expect(next.state.lineage!.persons[String(human)]!.heirId).toBe(heir);
  expect(next.state.generals[heir!]).toMatchObject({ userId: null, gold: 40, rice: 50 });
});
it('AC-P2-32 NPC 자동 사망·자손 계승은 같은 시드에서 같고 사람은 과거 몰년에도 생존한다', () => {
  const world = fixture(),
    before = structuredClone(world),
    [human, npc, heir, , father] = Object.keys(world.generals).map(Number);
  Object.assign(world.generals[human!]!, { userId: 'living-player', deathYear: world.startYear - 1, age: 99 });
  Object.assign(world.generals[npc!]!, { userId: null, deathYear: world.startYear - 1, crew: 0, gold: 100, rice: 200 });
  Object.assign(world.generals[heir!]!, {
    userId: null,
    nationId: world.generals[npc!]!.nationId,
    cityKey: world.generals[npc!]!.cityKey,
    officerLevel: 1,
    crew: 0,
    gold: 40,
    rice: 50,
  });
  world.lineage!.persons[String(heir)] = { ...emptyLineagePerson(), parents: [npc!, father!] };
  const snapshot = structuredClone(world),
    first = settleLineageMonthly(world, 10_000, resources);
  expect(first).toEqual(settleLineageMonthly(world, 10_000, resources));
  expect(world).toEqual(snapshot);
  expect(first.effects.deaths).toContainEqual({
    generalId: npc,
    successorId: heir,
    loss: { gold: 0, rice: 0, troops: 0 },
  });
  expect(first.state.generals[heir!]).toMatchObject({ gold: 140, rice: 250, officerLevel: 12, userId: null });
  expect(first.state.generals[human!]).toMatchObject({ userId: 'living-player', age: 25 });
  expect(first.state.lineage!.persons[String(human)]?.exit).toBeUndefined();
  expect(() => settleLineageMonthly(first.state, 10_000, resources)).toThrow('중복');
  expect(before.lineage!.monthlyTick).toBe(0);
});

it('AC-P2-32 NPC 없는 공석은 사람을 자동 승진시키지 않고 명시 군주 청구를 기다린다', () => {
  const world = fixture(),
    [ruler, member] = Object.keys(world.generals).map(Number);
  Object.assign(world.generals[ruler!]!, { userId: null, deathYear: world.startYear - 1 });
  Object.assign(world.generals[member!]!, {
    nationId: world.generals[ruler!]!.nationId,
    officerLevel: 1,
    userId: 'claim-player',
  });
  const settled = settleLineageMonthly(world, 10_000, resources);
  expect(settled.effects.rulers).toContainEqual({ nationId: 1, generalId: null });
  expect(settled.state.generals[member!]!.officerLevel).toBe(1);
  const claimed = decideLineageAction(settled.state, member!, { type: 'ruler.claim', nationId: 1 }, 10_000);
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw Error(claimed.message);
  expect(claimed.world.generals[member!]!.officerLevel).toBe(12);
});

it('AC-P2-32 출생 확률만 다른 두 월드는 출생 단계에서 금·쌀 총량이 같고 다음 달에는 출생하지 않는다', () => {
  const world = fixture(),
    [a, b] = Object.keys(world.generals).map(Number);
  world.lineage!.marriages = [{ id: 1, a: a!, b: b!, householdGeneralId: a!, sinceTick: 0 }];
  world.lineage!.nextMarriageId = 2;
  world.generals[a!]!.name = '김부';
  const noBirth = settleLineageMonthly(world, 10_000, resources);
  world.lineage!.config.birth.chanceBp = 10_000;
  const birth = settleLineageMonthly(world, 10_000, resources);
  expect(noBirth.effects.births).toHaveLength(0);
  expect(birth.effects.births).toHaveLength(1);
  const sum = (view: typeof world) => Object.values(view.generals).reduce((total, g) => total + g.gold + g.rice, 0);
  expect(sum(birth.state)).toBe(sum(noBirth.state));
  const id = birth.effects.births[0]!.generalId;
  expect(birth.state.generals[id]).toMatchObject({ gold: 0, rice: 0, userId: null, age: 0 });
  const february = settleLineageMonthly(birth.state, 20_000, resources);
  expect(february.effects.births).toHaveLength(0);
  expect(february.state.generals[id]!.sex).toBe(birth.state.generals[id]!.sex);
});
