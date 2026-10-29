import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { BALANCE } from '../balance';
import { emptyCampaignState } from '../campaign/state';
import { recruitCost, drillGain } from '../commands/statScores';
import { deepFreeze } from '../personnel/testFixture';
import { applyCityAllocation } from './allocation';
import { applyCityPreparation } from './preparation';
import { emptyCityResourcesState } from './state';

function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'city-resources-v1'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  Object.assign(world.generals[1]!, { cityKey: 1, nationId: 1, officerLevel: 12, gold: 7, rice: 11 });
  Object.assign(world.generals[2]!, { cityKey: 1, nationId: 1, userId: null, leadership: 80 });
  world.campaign = emptyCampaignState(world, 'city-actions', 'sourced-fixture');
  world.campaign.links = [{ masterId: 1, personId: 2, relation: 'LIEUTENANT' }];
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 2, troops: 1000, crewType: 1100, train: 60, atmos: 80 }];
  world.campaign.nextUnitId = 2;
  world.cityResources = emptyCityResourcesState(world);
  Object.assign(world.cityResources.cities['1']!, {
    gold: 100_000,
    rice: 4321,
    garrison: [{ crewType: 1100, troops: 1000, train: 40, atmos: 60 }],
  });
  return world;
}
const actor = { generalId: 1, unitSet: testUnits };
const allocation = { cityKey: 1, unitId: 1, crewType: 1100, amount: 500 };
function applied<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return outcome as Extract<T, { ok: true }>;
}

describe('AC-INT-18A 도시 모집·준비·배속의 보존과 권한', () => {
  it.each(['recruit', 'conscript'] as const)('%s는 도시 금·인구만 차감하고 도시 병력만 더한다', (key) => {
    const world = fixture(),
      before = structuredClone(world);
    const result = applied(applyCityPreparation(deepFreeze(world), actor, key, { amount: 1000, crewType: 1100 }));
    const cost = recruitCost(
      world,
      world.generals[1]!,
      1000,
      testUnits.crewTypes.find((row) => row.id === 1100)!.cost,
      key === 'conscript',
    );
    expect(result.state.cityResources!.cities['1']).toEqual({
      gold: 100_000 - cost,
      rice: 4321,
      garrison: [{ crewType: 1100, troops: 2000, train: 20, atmos: 30 }],
    });
    expect(result.state.cities[1]!.population).toBe(world.cities[1]!.population - 1000);
    expect(result.state.cities[1]!.trust).toBe(
      world.cities[1]!.trust - (key === 'conscript' ? BALANCE.CONSCRIPT_TRUST_LOSS : 0),
    );
    expect(result.state.campaign).toEqual(before.campaign);
    expect(result.state.generals).toEqual(before.generals);
    expect(result.state.nations).toEqual(before.nations);
    expect(world).toEqual(before);
  });
  it('도시 모집에 개인 통솔 상한이나 개인 금을 쓰지 않는다', () => {
    const world = fixture();
    Object.assign(world.generals[1]!, { leadership: 1, gold: 0 });
    expect(applyCityPreparation(world, actor, 'recruit', { amount: 2000, crewType: 1100 }).ok).toBe(true);
    world.cityResources!.cities['1']!.gold = 0;
    world.generals[1]!.gold = 1_000_000;
    expect(applyCityPreparation(world, actor, 'recruit', { amount: 1, crewType: 1100 })).toMatchObject({
      ok: false,
      code: 'NO_GOLD',
    });
  });
  it.each(['train', 'morale'] as const)('%s는 실행 장수 산식과 도시 비용만 사용한다', (key) => {
    const world = fixture(),
      before = structuredClone(world);
    const result = applied(applyCityPreparation(deepFreeze(world), actor, key, { target: 'city', crewType: 1100 }));
    const field = key === 'morale' ? 'atmos' : 'train';
    expect(result.state.cityResources!.cities['1']!.garrison[0]![field]).toBe(
      before.cityResources!.cities['1']!.garrison[0]![field] + drillGain(world, world.generals[1]!, key === 'morale'),
    );
    expect(result.state.cityResources!.cities['1']!.gold).toBe(100_000 - BALANCE.DRILL_COST);
    expect(result.state.campaign).toEqual(before.campaign);
    expect(result.state.generals).toEqual(before.generals);
    expect(world).toEqual(before);
  });
  it.each(['no-city-gold', 'population', 'supply', 'enemy', 'bad-type', 'unit-arg'] as const)(
    '모집의 %s 반례는 입력을 보존한다',
    (kind) => {
      const world = fixture();
      if (kind === 'no-city-gold') world.cityResources!.cities['1']!.gold = 0;
      if (kind === 'population') world.cities[1]!.population = 0;
      if (kind === 'supply') world.cities[1]!.supplied = false;
      if (kind === 'enemy') world.cities[1]!.nationId = 2;
      const before = structuredClone(world);
      const args = {
        amount: 1,
        crewType: kind === 'bad-type' ? 1000 : 1100,
        ...(kind === 'unit-arg' ? { unitId: 1 } : {}),
      };
      expect(applyCityPreparation(deepFreeze(world), actor, 'recruit', args).ok).toBe(false);
      expect(world).toEqual(before);
    },
  );
  it('권한자는 원격 자기 도시에서 집결한 부곡에 등량 배속하며 예약과 지갑을 바꾸지 않는다', () => {
    const world = fixture();
    world.generals[4]!.nationId = 1;
    world.generals[4]!.officerLevel = 5;
    const before = structuredClone(world);
    const result = applied(applyCityAllocation(deepFreeze(world), { ...actor, generalId: 4 }, allocation));
    expect(result.state.cityResources!.cities['1']).toEqual({
      gold: 100_000,
      rice: 4321,
      garrison: [{ crewType: 1100, troops: 500, train: 40, atmos: 60 }],
    });
    expect(result.state.campaign!.units[0]).toMatchObject({ troops: 1500, train: 53, atmos: 73 });
    expect(result.state.campaign!.revision).toBe(before.campaign!.revision + 1);
    expect(result.state.generals).toEqual(before.generals);
    expect(result.state.cities).toEqual(before.cities);
    expect(result.state.nations).toEqual(before.nations);
    expect(world).toEqual(before);
  });
  it.each([5, 6, 7, 8, 9, 10, 11, 12])('직책%s는 명시적 배속 권한을 쓴다', (level) => {
    const world = fixture();
    world.generals[1]!.officerLevel = level;
    expect(applyCityAllocation(world, actor, allocation).ok).toBe(true);
  });
  it.each([0, 1, 2, 3, 4, 13])('직책%s의 도시 병력 배속을 거부한다', (level) => {
    const world = fixture();
    world.generals[1]!.officerLevel = level;
    expect(applyCityAllocation(world, actor, allocation)).toMatchObject({ ok: false, code: 'PROTECTED' });
  });
  it.each([
    'enemy-city',
    'owner-away',
    'commander-away',
    'other-nation',
    'shortage',
    'type',
    'capacity',
    'revision',
  ] as const)('배속의 %s 반례에서 양쪽 병력이 불변이다', (kind) => {
    const world = fixture();
    if (kind === 'enemy-city') world.cities[1]!.nationId = 2;
    if (kind === 'owner-away') world.generals[1]!.cityKey = 4;
    if (kind === 'commander-away') world.generals[2]!.cityKey = 4;
    if (kind === 'other-nation') world.generals[4]!.nationId = 2;
    if (kind === 'shortage') world.cityResources!.cities['1']!.garrison[0]!.troops = 499;
    if (kind === 'capacity') world.generals[2]!.leadership = 10;
    if (kind === 'revision') world.campaign!.revision = 2_147_483_647;
    const before = structuredClone(world);
    const outcome = applyCityAllocation(
      deepFreeze(world),
      kind === 'other-nation' ? { ...actor, generalId: 4 } : actor,
      { ...allocation, crewType: kind === 'type' ? 1200 : 1100 },
    );
    expect(outcome.ok).toBe(false);
    expect(world).toEqual(before);
  });
  it('같은 실제 지휘관의 다른 부곡도 상한에 합산한다', () => {
    const world = fixture();
    world.campaign!.units.push({ ...world.campaign!.units[0]!, id: 2, troops: 6800 });
    world.campaign!.nextUnitId = 3;
    expect(applyCityAllocation(world, actor, allocation)).toMatchObject({ ok: false, code: 'AT_MAX' });
  });
  it('전량 배속은 도시 행을 지우고 빈 부곡은 도시 훈련·사기를 그대로 받는다', () => {
    const world = fixture();
    world.campaign!.units[0]!.troops = 0;
    const next = applied(applyCityAllocation(world, actor, { ...allocation, amount: 1000 })).state;
    expect(next.cityResources!.cities['1']!.garrison).toEqual([]);
    expect(next.campaign!.units[0]).toMatchObject({ troops: 1000, train: 40, atmos: 60 });
  });
  it('기능 표시가 없으면 기존 판을 새 규칙으로 처리하지 않는다', () => {
    const world = fixture();
    world.ruleFeatures = ['five-stats'];
    expect(applyCityAllocation(world, actor, allocation)).toMatchObject({ ok: false, code: 'COMMAND_DISABLED' });
    expect(applyCityPreparation(world, actor, 'train', { target: 'city', crewType: 1100 })).toMatchObject({
      ok: false,
      code: 'COMMAND_DISABLED',
    });
  });
});
