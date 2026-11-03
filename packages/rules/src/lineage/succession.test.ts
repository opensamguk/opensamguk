import { expect, it } from 'vitest';
import { emptyCampaignState } from '../campaign/state';
import { LINEAGE_EXITED_YEAR, LINEAGE_MAX } from './config';
import { assertLineageFinal } from './invariants';
import { applySuccession, retireNpcWithoutHeir } from './succession';
import { emptyLineagePerson } from './state';
import { lineageFixture } from './testFixture';

function family(campaign = false) {
  const world = lineageFixture(),
    [from, heir, mother, other, human] = Object.keys(world.generals).map(Number);
  for (const g of Object.values(world.generals))
    Object.assign(g, { nationId: 1, politics: 50, charm: 50, crew: 0, officerLevel: 0 });
  Object.assign(world.generals[from!]!, {
    userId: 'lineage-player',
    officerLevel: 12,
    gold: 100,
    rice: 200,
    cityKey: 1,
  });
  Object.assign(world.generals[heir!]!, { userId: null, gold: 40, rice: 50, cityKey: 1 });
  world.generals[mother!]!.sex = 'FEMALE';
  world.lineage!.persons[String(heir)] = { ...emptyLineagePerson(), parents: [from!, mother!] };
  world.lineage!.persons[String(from)] = { ...emptyLineagePerson(), heirId: heir! };
  if (campaign) world.campaign = emptyCampaignState(world, 'lineage-fixture', 'fixture');
  return { world, from: from!, heir: heir!, mother: mother!, other: other!, human: human! };
}
const unit = (id: number, ownerId: number, commanderId: number, troops: number) => ({
  id,
  ownerId,
  commanderId,
  troops,
  crewType: 1,
  train: 20,
  atmos: 30,
});

it('AC-P2-32 후계자가 이미 지휘하던 전임자 부곡은 위치 그대로 자기 부곡으로 승계한다', () => {
  const { world, from, heir } = family(true),
    campaign = world.campaign!;
  campaign.links = [{ masterId: from, personId: heir, relation: 'LIEUTENANT' }];
  campaign.units = [unit(1, from, heir, 30)];
  campaign.nextUnitId = 2;
  const outcome = applySuccession(world, from, heir, 'HUMAN', 0);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw Error(outcome.message);
  expect(outcome.world.campaign!.units).toEqual([unit(1, heir, heir, 30)]);
  expect(outcome.world.campaign!.links).toEqual([]);
  expect(outcome.loss).toEqual({ gold: 0, rice: 0, troops: 0 });
  expect(() => assertLineageFinal(outcome.world, 0)).not.toThrow();
});

it('AC-P2-32 사람 계승은 조작권 하나·직위·금·쌀·병력을 손실 없이 이전하고 원본을 바꾸지 않는다', () => {
  const { world, from, heir } = family();
  Object.assign(world.generals[from]!, { crew: 80, train: 20, atmos: 30 });
  const before = structuredClone(world);
  const outcome = applySuccession(world, from, heir, 'HUMAN', 100);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw Error(outcome.message);
  expect(world).toEqual(before);
  expect(outcome.loss).toEqual({ gold: 0, rice: 0, troops: 0 });
  expect(outcome.world.generals[heir]).toMatchObject({
    userId: 'lineage-player',
    officerLevel: 12,
    gold: 140,
    rice: 250,
    crew: 80,
    cityKey: 1,
    train: 20,
    atmos: 30,
  });
  expect(outcome.world.generals[from]).toMatchObject({
    userId: null,
    nationId: null,
    gold: 0,
    rice: 0,
    crew: 0,
    officerLevel: 0,
    activeFromYear: LINEAGE_EXITED_YEAR,
  });
  expect(outcome.world.lineage!.persons[String(from)]).toMatchObject({
    successorId: heir,
    heirId: null,
    exit: { cause: 'SUCCEEDED', tick: 100 },
  });
  expect(() => assertLineageFinal(outcome.world, 100)).not.toThrow();
  expect(applySuccession(outcome.world, from, heir, 'HUMAN', 100)).toMatchObject({ ok: false });
});

it('AC-P2-32 사람 계승은 타 도시·병력 충돌·상한 초과를 거절하며 부분 재산 이전이 없다', () => {
  const { world, from, heir } = family();
  world.generals[from]!.crew = 200;
  world.generals[heir]!.cityKey = 2;
  expect(applySuccession(world, from, heir, 'HUMAN', 0)).toMatchObject({ ok: false, code: 'HEIR_AWAY' });
  world.generals[heir]!.cityKey = 1;
  world.generals[heir]!.crew = 1;
  expect(applySuccession(world, from, heir, 'HUMAN', 0)).toMatchObject({ ok: false, code: 'HEIR_HAS_CREW' });
  world.generals[heir]!.crew = 0;
  world.generals[heir]!.leadership = 1;
  expect(applySuccession(world, from, heir, 'HUMAN', 0)).toMatchObject({ ok: false, code: 'HEIR_CAPACITY' });
  world.generals[heir]!.gold = LINEAGE_MAX;
  expect(applySuccession(world, from, heir, 'HUMAN', 0)).toMatchObject({ ok: false, code: 'HOLDER_FULL' });
  expect(world.generals[from]!.gold).toBe(100);
});

it('AC-P2-32 사람 계승은 NPC 부장 위치를 유지하고 사람 휘하를 새 상관에게 강제로 묶지 않는다', () => {
  const { world, from, heir, mother, human } = family(true),
    campaign = world.campaign!;
  world.generals[human]!.userId = 'other-human';
  campaign.links = [
    { masterId: from, personId: mother, relation: 'LIEUTENANT' },
    { masterId: from, personId: human, relation: 'STAFF' },
  ];
  campaign.units = [unit(1, from, from, 20), unit(2, from, mother, 30)];
  campaign.nextUnitId = 3;
  const outcome = applySuccession(world, from, heir, 'HUMAN', 0);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw Error(outcome.message);
  expect(outcome.world.campaign!.units).toEqual([unit(1, heir, heir, 20), unit(2, heir, mother, 30)]);
  expect(outcome.world.generals[mother]!.cityKey).toBe(world.generals[mother]!.cityKey);
  expect(outcome.world.campaign!.links).toEqual([{ masterId: heir, personId: mother, relation: 'LIEUTENANT' }]);
  expect(outcome.releasedPeople).toContain(human);
  expect(outcome.loss).toEqual({ gold: 0, rice: 0, troops: 0 });
  expect(() => assertLineageFinal(outcome.world, 0)).not.toThrow();
});

it('AC-P2-32 NPC 사망은 기존 후계자 병력을 지키며 초과분만 명시 손실로 기록한다', () => {
  const { world, from, heir } = family(true),
    campaign = world.campaign!;
  world.generals[from]!.userId = null;
  world.generals[heir]!.leadership = 1;
  world.generals[heir]!.gold = LINEAGE_MAX;
  campaign.units = [unit(1, from, from, 80), unit(2, heir, heir, 40)];
  campaign.nextUnitId = 3;
  const outcome = applySuccession(world, from, heir, 'NPC_DEATH', 0);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw Error(outcome.message);
  expect(outcome.loss).toEqual({ gold: 100, rice: 0, troops: 20 });
  expect(outcome.world.campaign!.units).toEqual([unit(1, heir, heir, 60), unit(2, heir, heir, 40)]);
  expect(outcome.world.lineage!.persons[String(from)]!.exit!.cause).toBe('DIED');
});

it('AC-P2-32 NPC 사망의 다른 도시 부곡은 손실 처리하고 남의 부곡을 소유자에게 빈 병력으로 돌린다', () => {
  const { world, from, heir, mother, other } = family(true),
    campaign = world.campaign!;
  world.generals[from]!.userId = null;
  world.generals[heir]!.cityKey = 2;
  campaign.links = [
    { masterId: other, personId: from, relation: 'LIEUTENANT' },
    { masterId: from, personId: mother, relation: 'LIEUTENANT' },
  ];
  campaign.units = [unit(1, from, from, 80), unit(2, other, from, 45), unit(3, from, mother, 30)];
  campaign.nextUnitId = 4;
  const outcome = applySuccession(world, from, heir, 'NPC_DEATH', 0);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw Error(outcome.message);
  expect(outcome.loss.troops).toBe(125);
  expect(outcome.world.campaign!.units).toEqual([unit(2, other, other, 0), unit(3, heir, mother, 30)]);
  expect(outcome.world.generals[mother]!.cityKey).toBe(world.generals[mother]!.cityKey);
  expect(() => assertLineageFinal(outcome.world, 0)).not.toThrow();
});

it('AC-P2-32 후계자 없는 NPC의 자산은 손실로 남고 남의 부곡은 원래 소유자의 남은 한도로 반환한다', () => {
  const { world, from, heir, other } = family(true),
    campaign = world.campaign!;
  expect(retireNpcWithoutHeir(world, from, 0)).toMatchObject({ ok: false, code: 'BAD_TARGET' });
  world.generals[from]!.userId = null;
  world.generals[heir]!.activeFromYear = world.startYear + 100;
  world.generals[other]!.cityKey = 1;
  world.generals[other]!.leadership = 50;
  campaign.links = [{ masterId: other, personId: from, relation: 'LIEUTENANT' }];
  campaign.units = [unit(1, from, from, 80), unit(2, other, from, 45), unit(3, other, other, 4970)];
  campaign.nextUnitId = 4;
  const outcome = retireNpcWithoutHeir(world, from, 0);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw Error(outcome.message);
  expect(outcome.loss).toEqual({ gold: 100, rice: 200, troops: 95 });
  expect(outcome.world.campaign!.units).toEqual([unit(2, other, other, 30), unit(3, other, other, 4970)]);
  expect(outcome.world.generals[heir]!.gold).toBe(40);
  expect(outcome.world.lineage!.persons[String(from)]!.successorId).toBeNull();
  expect(() => assertLineageFinal(outcome.world, 0)).not.toThrow();
});
