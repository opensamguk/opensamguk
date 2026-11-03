import { expect, it, vi } from 'vitest';
import { createRng } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { createCommandResolver } from '../commands/resolve';
import { applyEffects } from '../commands/effects';
import { cloneWorld } from '../model/clone';
import { emptyCampaignState } from '../campaign/state';
import { createCampaignCommandResolver } from '../campaign/commands';
import { createStratagemCardResolver } from './resolver';
import { initialStratagemCards } from './state';
import { TEST_STRATAGEM_CARDS_CONFIG } from './testFixture';
import { triggerStratagemTrap } from './trap';

const actor = { generalId: 1, tick: 100, unitSet: testUnits },
  target = { cityKey: 2 },
  base = createCommandResolver({ general: ['fire_attack', 'sabotage', 'incite', 'plunder'], nation: [] });
function fixture(campaign: boolean, armed = true) {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'stratagem-basic', 'stratagem-cards-v1'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55 });
  if (campaign) {
    world.ruleFeatures.push('campaign-v1');
    for (const general of Object.values(world.generals)) general.crew = 0;
    Object.assign(world.generals[4]!, { nationId: 1, cityKey: 1, officerLevel: 1 });
    world.generals[1]!.userId = 'owner';
    world.campaign = emptyCampaignState(world, 'trap-fixture', 'sourced-fixture');
    world.campaign.links = [
      { masterId: 1, personId: 4, relation: 'LIEUTENANT' },
      { masterId: 2, personId: 3, relation: 'LIEUTENANT' },
    ];
    world.campaign.units = [
      { id: 1, ownerId: 1, commanderId: 1, troops: 200, crewType: 1100, train: 100, atmos: 100 },
      { id: 2, ownerId: 1, commanderId: 4, troops: 100, crewType: 1100, train: 100, atmos: 100 },
      { id: 3, ownerId: 2, commanderId: 2, troops: 20, crewType: 1100, train: 100, atmos: 100 },
      { id: 4, ownerId: 2, commanderId: 3, troops: 10, crewType: 1100, train: 100, atmos: 100 },
    ];
    world.campaign.nextUnitId = 5;
  }
  world.stratagemCards = initialStratagemCards(TEST_STRATAGEM_CARDS_CONFIG, world, 'trap-cards');
  if (armed) world.stratagemCards.nations[2]!.traps = [{ cityKey: 2, setTick: 0 }];
  return world;
}
const selected = (campaign: boolean) => (campaign ? createCampaignCommandResolver(base) : base);

it('AC-P2-23 구판 출병 함정은 병력·사기를 줄이고 한 번만 발동한다', () => {
  const world = fixture(false),
    before = structuredClone(world),
    result = triggerStratagemTrap(world, actor, 2)!;
  expect(result.cancelled).toBe(false);
  expect(result.state.generals[1]).toMatchObject({ crew: 8000, atmos: 90 });
  expect(result.state.generals[2]).toEqual(world.generals[2]);
  expect(result.state.stratagemCards!.nations[2]!.traps).toEqual([]);
  expect(triggerStratagemTrap(result.state, actor, 2)).toBeNull();
  expect(world).toEqual(before);
});

it('AC-P2-23 부곡판은 참전 부곡 모두에만 피해를 주고 장수 병력 0을 지킨다', () => {
  const world = fixture(true),
    before = structuredClone(world),
    result = triggerStratagemTrap(world, actor, 2)!;
  expect(result.state.campaign!.units.slice(0, 2).map((unit) => [unit.troops, unit.atmos, unit.train])).toEqual([
    [160, 90, 100],
    [80, 90, 100],
  ]);
  expect(result.state.campaign!.units.slice(2)).toEqual(world.campaign!.units.slice(2));
  expect(result.state.campaign!.revision).toBe(world.campaign!.revision + 1);
  expect(Object.values(result.state.generals).every((general) => general.crew === 0)).toBe(true);
  expect(world).toEqual(before);
});

it.each(['away', 'inactive'] as const)('AC-P2-23 %s 부곡은 기존 출병 선택자와 같이 제외한다', (mode) => {
  const world = fixture(true);
  if (mode === 'away') world.generals[4]!.cityKey = 3;
  else world.generals[4]!.activeFromYear = 210;
  const result = triggerStratagemTrap(world, actor, 2)!;
  expect(result.state.campaign!.units[0]!.troops).toBe(160);
  expect(result.state.campaign!.units[1]).toEqual(world.campaign!.units[1]);
});

it.each([false, true])('AC-P2-23 함정 없는 출병은 원래 결과와 RNG가 같다 (부곡=%s)', (campaign) => {
  const world = fixture(campaign, false),
    original = selected(campaign),
    wrapped = createStratagemCardResolver(original),
    left = createRng('attack-golden'),
    right = createRng('attack-golden'),
    expected = original.run(world, actor, 'attack', target, left),
    actual = wrapped.run(world, actor, 'attack', target, right);
  if ('code' in expected || 'code' in actual) throw Error('출병 고정물이 실행 조건을 만족하지 못했습니다.');
  const actualState = applyEffects(cloneWorld(world), actual.effects),
    expectedState = applyEffects(cloneWorld(world), expected.effects);
  expect(Object.keys(actualState.stratagemCards!.nations)).toEqual(Object.keys(actualState.nations));
  expect(actualState.stratagemCards!.config).toEqual(world.stratagemCards!.config);
  delete actualState.stratagemCards;
  delete expectedState.stratagemCards;
  expect(actualState).toEqual(expectedState);
  expect(actual.logs).toEqual(expected.logs);
  expect(actual.history).toEqual(expected.history);
  expect(actual.reports).toEqual(expected.reports);
  expect(actual.battleAwards).toEqual(expected.battleAwards);
  expect(left.next()).toBe(right.next());
});

it.each([false, true])('AC-P2-23 함정 뒤 전투 병력이 없으면 비용·전투·성벽·전공 없이 끝난다 (부곡=%s)', (campaign) => {
  const world = fixture(campaign);
  world.stratagemCards!.config.trap.lossBp = 10_000;
  const before = structuredClone(world),
    rng = createRng('cancelled'),
    next = vi.spyOn(rng, 'next'),
    int = vi.spyOn(rng, 'int'),
    pick = vi.spyOn(rng, 'pick'),
    result = createStratagemCardResolver(selected(campaign)).run(world, actor, 'attack', target, rng);
  if ('code' in result) throw Error(result.message);
  const state = applyEffects(cloneWorld(world), result.effects);
  expect(result.battleAwards).toBeUndefined();
  expect(result.reports).toBeUndefined();
  expect(result.logs.some((log) => log.text.includes('점령에 실패'))).toBe(true);
  expect(state.cities).toEqual(before.cities);
  expect(state.generals[1]!.rice).toBe(before.generals[1]!.rice);
  expect(state.generals[2]).toEqual(before.generals[2]);
  expect(state.stratagemCards!.nations[2]!.traps).toEqual([]);
  expect(next).not.toHaveBeenCalled();
  expect(int).not.toHaveBeenCalled();
  expect(pick).not.toHaveBeenCalled();
  expect(world).toEqual(before);
});

it('AC-P2-23 사기가 0이 된 부곡은 병력이 남아도 전투하지 않는다', () => {
  const world = fixture(true);
  for (const unit of world.campaign!.units.slice(0, 2)) unit.atmos = 5;
  const result = triggerStratagemTrap(world, actor, 2)!;
  expect(result.cancelled).toBe(true);
  expect(result.state.campaign!.units[0]).toMatchObject({ troops: 160, atmos: 0 });
});

it('AC-P2-23 전쟁이 아닌 출병과 자기 도시에는 함정을 소모하지 않는다', () => {
  const world = fixture(true),
    before = structuredClone(world);
  expect(triggerStratagemTrap(world, { ...actor, generalId: 2 }, 2)).toBeNull();
  world.diplomacies = [];
  expect(
    createStratagemCardResolver(selected(true)).run(world, actor, 'attack', target, createRng('peace')),
  ).toMatchObject({ code: 'NOT_WAR' });
  expect(world.stratagemCards).toEqual(before.stratagemCards);
});

it('AC-P2-23 만료·미래 설치 시각과 변경 번호 한도는 피해 적용 전에 검사한다', () => {
  const world = fixture(true);
  world.stratagemCards!.config.trapExpiryMonths = 1;
  expect(triggerStratagemTrap(world, { ...actor, tick: 10_000 }, 2)).toBeNull();
  world.stratagemCards!.nations[2]!.traps[0]!.setTick = 101;
  expect(triggerStratagemTrap(world, actor, 2)).toBeNull();
  expect(world.stratagemCards!.nations[2]!.traps).toHaveLength(1);
  world.stratagemCards!.nations[2]!.traps[0]!.setTick = 0;
  world.stratagemCards!.revision = 2_147_483_647;
  expect(() => triggerStratagemTrap(world, actor, 2)).toThrow('한도');
  world.stratagemCards!.revision = 0;
  world.campaign!.revision = 2_147_483_647;
  expect(() => triggerStratagemTrap(world, actor, 2)).toThrow('한도');
  expect(world.campaign!.units[0]!.troops).toBe(200);
  expect(world.stratagemCards!.nations[2]!.traps).toHaveLength(1);
});

it.each(
  [false, true].flatMap((campaign) =>
    [
      { capture: false, survives: true },
      { capture: true, survives: false },
      { capture: true, survives: true },
    ].map((outcome) => ({ campaign, ...outcome })),
  ),
)(
  'AC-P2-23 지연 출병의 전투·카드 상태를 보존한다: 부곡=$campaign 점령=$capture 상대국 생존=$survives',
  ({ campaign, capture, survives }) => {
    const world = fixture(campaign);
    if (capture && survives) {
      world.cities[3]!.nationId = 2;
      world.nations[2]!.capitalCityKey = 3;
    }
    world.stratagemCards!.monthlyTick = 10_000;
    world.stratagemCards!.nations[2]!.traps[0]!.setTick = actor.tick + 1;
    if (capture) {
      world.cities[2]!.wall = 0;
      if (campaign) world.campaign!.units = world.campaign!.units.filter((unit) => unit.ownerId === 1);
      else for (const general of Object.values(world.generals)) if (general.nationId === 2) general.crew = 0;
    } else {
      world.cities[2]!.wall = 1000;
      if (campaign) for (const unit of world.campaign!.units) unit.troops = unit.ownerId === 1 ? 100 : 10_000;
      else {
        world.generals[1]!.crew = 100;
        for (const general of Object.values(world.generals)) if (general.nationId === 2) general.crew = 10_000;
      }
    }
    const before = structuredClone(world),
      original = selected(campaign),
      left = createRng('delayed-turn'),
      right = createRng('delayed-turn'),
      ordinary = original.run(world, actor, 'attack', target, left),
      actual = createStratagemCardResolver(original).run(world, actor, 'attack', target, right);
    if ('code' in ordinary || 'code' in actual) throw Error('출병 고정물이 실행 조건을 만족하지 못했습니다.');
    const expectedState = applyEffects(cloneWorld(world), ordinary.effects),
      actualState = applyEffects(cloneWorld(world), actual.effects);
    expect(actualState.cities[2]!.nationId).toBe(capture ? 1 : 2);
    expect(actualState.nations[2] !== undefined).toBe(survives);
    expect(actualState.stratagemCards!.nations[2] !== undefined).toBe(survives);
    const expectedCards = structuredClone(world.stratagemCards!);
    if (capture) {
      if (survives) expectedCards.nations[2]!.traps = [];
      else delete expectedCards.nations[2];
      expectedCards.revision++;
    }
    expect(actualState.stratagemCards).toEqual(expectedCards);
    const { effects: ordinaryEffects, ...ordinaryDetails } = ordinary,
      { effects: actualEffects, ...actualDetails } = actual;
    expect(ordinaryEffects.length).toBeGreaterThan(0);
    expect(actualEffects.length).toBeGreaterThan(0);
    expect(actualDetails).toEqual(ordinaryDetails);
    delete expectedState.stratagemCards;
    delete actualState.stratagemCards;
    expect(actualState).toEqual(expectedState);
    expect(left.next()).toBe(right.next());
    expect(world).toEqual(before);
  },
);
