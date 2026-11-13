import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { emptyCampaignState } from '../campaign/state';
import { createCampaignCommandResolver } from '../campaign/commands';
import { createCityResourceCommandResolver } from '../cityResources/commands';
import { cityNpcPreparation } from '../cityResources/npc';
import { CITY_RESOURCE_MAX, emptyCityResourcesState } from '../cityResources/state';
import { createCommandResolver } from '../commands/resolve';
import { runGeneralTurn } from '../commands/turn';
import { cloneWorld } from '../model/clone';
import { deepFreeze } from '../personnel/testFixture';
import { settleNpcLogistics } from './npc';
import * as actions from './operations';
import { initialLogisticsState, logisticsConfigSchema, type LogisticsConfig } from './state';

const config: LogisticsConfig = {
  version: 1,
  specialties: [],
  capacity: { base: 100, perLevel: 100, maxLevel: 2 },
  upgrade: { gold: 50, wood: 10 },
  transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 1000, maxPerOrder: 100, maxActivePerNation: 2 },
  recruitPer100: {
    '1': { iron: 2, wood: 0, horses: 0 },
    '2': { iron: 0, wood: 2, horses: 0 },
    '3': { iron: 1, wood: 0, horses: 1 },
  },
  build: { wall: { iron: 0, wood: 10, horses: 0 }, defence: { iron: 5, wood: 5, horses: 0 } },
  trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
};
const settings = { recruitTarget: 500, budgetBp: 2000, maxActions: 3, stockCapBp: 8000, upgradeAtBp: 9000 };
function fixture(enabled = true) {
  const world = commandWorld();
  world.ruleFeatures = ['campaign-v1', 'city-resources-v1', 'five-stats', 'logistics-v1'];
  for (const general of Object.values(world.generals)) Object.assign(general, { crew: 0, politics: 50, charm: 50 });
  world.generals[2]!.userId = 'other-player';
  world.cities[1]!.connections = [2, 4];
  world.cities[4]!.connections = [1];
  world.cities[3]!.connections = [2];
  world.cities[4]!.supplied = true;
  world.campaign = emptyCampaignState(world, 'npc-logistics', 'fixed-fixture');
  world.cityResources = emptyCityResourcesState(world);
  world.cityResources.cities['1']!.gold = 10_000;
  world.logistics = initialLogisticsState({ ...config, ...(enabled ? { npc: settings } : {}) }, world);
  return world;
}
function month(world = fixture()) {
  const base = actions.settleLogisticsMonthly(deepFreeze(world), 10_000);
  return { base, npc: settleNpcLogistics(deepFreeze(base.state), 10_000, testUnits) };
}
afterEach(() => vi.restoreAllMocks());

describe('AC-P2-30 NPC의 실제 물류 예산·수송·모집', () => {
  it('기존 설정에 npc 키를 만들지 않으며 병종 없이도 종전 정산을 그대로 돌려준다', () => {
    const world = fixture(false),
      parsed = logisticsConfigSchema.parse(config);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(config));
    expect(Object.hasOwn(parsed, 'npc')).toBe(false);
    const oldNpcConfig = { ...config, npc: settings };
    expect(logisticsConfigSchema.parse(oldNpcConfig)).toStrictEqual(oldNpcConfig);
    const base = actions.settleLogisticsMonthly(world, 10_000);
    expect(settleNpcLogistics(deepFreeze(base.state), 10_000, undefined)).toEqual({ state: base.state, movements: [] });
    expect(settleNpcLogistics(base.state, 10_000, undefined).state).toBe(base.state);
  });
  it.each(['human', 'future', 'duplicate', 'player-nation'] as const)('%s 군주는 자동 지출하지 않는다', (kind) => {
    const world = fixture();
    if (kind === 'human') world.generals[1]!.userId = 'ruler-player';
    if (kind === 'future') world.generals[1]!.activeFromYear = world.startYear + 1;
    if (kind === 'duplicate') Object.assign(world.generals[3]!, { nationId: 1, officerLevel: 12 });
    if (kind === 'player-nation') world.nations[1]!.isNpc = false;
    const { base, npc } = month(world);
    expect(npc).toEqual({ state: base.state, movements: [] });
    expect(npc.state.cityResources!.cities['1']!.gold).toBe(10_000);
  });
  it('월 매입 뒤 실제 NPC 차례가 같은 재료를 소모해 도시 수비병을 모집한다', () => {
    const world = fixture(),
      { base, npc } = month(world);
    expect(npc.movements).toEqual([{ holder: 'city', id: 1, good: 'iron', delta: 10, reason: 'TRADE' }]);
    expect(npc.state.cityResources!.cities['1']!.gold).toBe(9970);
    expect(npc.state.generals).toEqual(base.state.generals);
    expect(npc.state.logistics!.revision).toBe(base.state.logistics!.revision + 1);
    expect(
      cityNpcPreparation(npc.state, 1, { unitSet: testUnits }).find((choice) => choice.key === 'recruit')?.args,
    ).toEqual({ amount: 500, crewType: 1100 });
    const resolver = createCityResourceCommandResolver(createCampaignCommandResolver(createCommandResolver(null)));
    const turn = runGeneralTurn(
      npc.state,
      { generalId: 1, tick: 10_100, unitSet: testUnits },
      { commandKey: 'rest', args: {} },
      'npc-logistics',
      {},
      resolver,
    );
    expect(turn.commandKey).toBe('recruit');
    expect('code' in turn.result).toBe(false);
    expect(turn.state.cityResources!.cities['1']!.garrison).toEqual([
      { crewType: 1100, troops: 500, train: 0, atmos: 0 },
    ]);
    expect(turn.state.logistics!.cities['1']!.iron).toBe(0);
    expect(turn.state.cityResources!.cities['1']!.gold).toBe(5470);
    expect(world.logistics!.cities['1']!.iron).toBe(0);
  });
  it('국고 상한을 고정한 판은 여러 도시의 실제 구매 지출을 합산한다', () => {
    const world = fixture();
    world.nations[1]!.gold = 450;
    Object.assign(world.generals[3]!, { nationId: 1, cityKey: 4, crewType: 1100 });
    world.cities[4]!.connections = [1, 2];
    world.cities[2]!.connections.push(4);
    world.cityResources!.cities['4']!.gold = 10_000;
    const { npc: old } = month(cloneWorld(world));
    expect(old.movements.map(({ id, delta }) => [id, delta])).toEqual([
      [4, 10],
      [1, 10],
    ]);

    world.logistics!.config = { ...config, npc: { ...settings, treasuryBudgetBp: 1000 } };
    const { npc } = month(cloneWorld(world));
    expect(npc.movements.map(({ id, delta }) => [id, delta])).toEqual([
      [4, 10],
      [1, 5],
    ]);
    expect(npc.state.cityResources!.cities['4']!.gold).toBe(9970);
    expect(npc.state.cityResources!.cities['1']!.gold).toBe(9985);
    expect(npc.state.nations[1]!.gold).toBe(450);
    world.nations[1]!.gold = 0;
    expect(month(world).npc.movements).toEqual([]);
  });
  it('후방 재고를 자기 보급 경로로 보내며 도착 손실을 매입으로 보충한다', () => {
    const world = fixture();
    world.logistics!.cities['4']!.iron = 10;
    const { npc } = month(world);
    expect(npc.state.cityResources!.cities['1']!.gold).toBe(10_000);
    expect(npc.state.logistics!.convoys).toMatchObject([
      { fromCityKey: 4, toCityKey: 1, goods: { iron: 10 }, arriveTick: 20_000 },
    ]);
    expect(npc.state.logistics!.cities['4']!.iron).toBe(0);
    const arrived = actions.settleLogisticsMonthly(npc.state, 20_000);
    expect(arrived.movements).toContainEqual({
      holder: 'convoy',
      id: 1,
      good: 'iron',
      delta: -1,
      reason: 'LOSS_TRANSIT',
    });
    expect(arrived.state.logistics!.cities['1']!.iron).toBe(9);
    const refill = settleNpcLogistics(arrived.state, 20_000, testUnits);
    expect(refill.state.logistics!.cities['1']!.iron).toBe(10);
    expect(refill.state.cityResources!.cities['1']!.gold).toBe(9997);
  });
  it('서로 다른 재료가 부족한 전선끼리 재화별 여분을 교환한다', () => {
    const world = fixture();
    Object.assign(world.generals[3]!, { nationId: 1, cityKey: 4, crewType: 1200 });
    world.cities[4]!.connections = [1, 2];
    world.cities[2]!.connections.push(4);
    world.cityResources!.cities['4']!.gold = 10_000;
    world.logistics!.cities['1']!.wood = 10;
    world.logistics!.cities['4']!.iron = 10;
    const { npc } = month(world);
    expect(npc.state.logistics!.convoys).toMatchObject([
      { fromCityKey: 1, toCityKey: 4, goods: { iron: 0, wood: 10, horses: 0 } },
      { fromCityKey: 4, toCityKey: 1, goods: { iron: 10, wood: 0, horses: 0 } },
    ]);
    expect(npc.movements.every((row) => row.reason === 'DEPART')).toBe(true);
  });
  it('가득 찬 불필요한 재고를 필요한 공간만큼 매도한 뒤 매입한다', () => {
    const world = fixture();
    world.logistics!.cities['1']!.wood = 100;
    const { npc } = month(world);
    expect(npc.movements).toEqual([
      { holder: 'city', id: 1, good: 'wood', delta: -30, reason: 'TRADE' },
      { holder: 'city', id: 1, good: 'iron', delta: 10, reason: 'TRADE' },
    ]);
    expect(npc.state.logistics!.cities['1']).toEqual({ iron: 10, wood: 70, horses: 0, level: 0 });
    expect(npc.state.cityResources!.cities['1']!.gold).toBe(10_000);
  });
  it('매도금 한도 거부도 행동 수에 세며 실제 금·목재로 창고를 증축한다', () => {
    const world = fixture();
    world.logistics!.cities['1']!.wood = 100;
    world.cityResources!.cities['1']!.gold = CITY_RESOURCE_MAX;
    const spy = vi.spyOn(actions, 'runLogisticsAction');
    const { npc } = month(world);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(npc.movements).toEqual([
      { holder: 'city', id: 1, good: 'wood', delta: -10, reason: 'UPGRADE' },
      { holder: 'city', id: 1, good: 'iron', delta: 10, reason: 'TRADE' },
    ]);
    expect(npc.state.logistics!.cities['1']!.level).toBe(1);
    expect(npc.state.cityResources!.cities['1']!.gold).toBe(CITY_RESOURCE_MAX - 80);
  });
  it('도착 예정 물량을 중복 구매하지 않고 거부 뒤에도 행동 상한을 넘지 않는다', () => {
    const world = fixture();
    world.logistics!.config = {
      ...config,
      transport: { ...config.transport, hopsPerMonth: 1 },
      npc: { ...settings, maxActions: 1 },
    };
    Object.assign(world.cities[3]!, { nationId: 1, supplied: true, connections: [1, 4] });
    world.cities[1]!.connections = [2, 3];
    world.cities[2]!.connections = [1];
    world.cities[4]!.connections = [3];
    world.logistics!.cities['4']!.iron = 10;
    world.logistics!.convoys = [1, 2].map((id) => ({
      id,
      nationId: 1,
      fromCityKey: 4,
      toCityKey: 1,
      path: [4, 3, 1],
      goods: { iron: 1, wood: 0, horses: 0 },
      departTick: 0,
      arriveTick: 20_000,
    }));
    world.logistics!.nextConvoyId = 3;
    const spy = vi.spyOn(actions, 'runLogisticsAction');
    const { base, npc } = month(world);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(npc).toEqual({ state: base.state, movements: [] });
    const copy = cloneWorld(world);
    copy.logistics!.convoys[0]!.goods.iron = 10;
    const covered = month(copy).npc;
    expect(covered.movements).toEqual([]);
    expect(covered.state.cityResources!.cities['1']!.gold).toBe(10_000);
  });
  it('다른 국가의 낮은 ID 방문 장수가 자국 전선의 판단을 가리지 않는다', () => {
    const world = fixture();
    world.generals[1]!.cityKey = 4;
    Object.assign(world.generals[2]!, { cityKey: 1, userId: null });
    Object.assign(world.generals[3]!, { cityKey: 1, nationId: 1 });
    expect(month(world).npc.state.logistics!.cities['1']!.iron).toBe(10);
  });
  it('휘하 NPC만 있는 전선에는 모집할 수 없는 장수 몫으로 자동 매입하지 않는다', () => {
    const world = fixture();
    Object.assign(world.generals[1]!, { officerLevel: 1 });
    Object.assign(world.generals[3]!, { nationId: 1, cityKey: 4, officerLevel: 12 });
    world.campaign!.links = [{ masterId: 3, personId: 1, relation: 'LIEUTENANT' }];
    expect(month(world).npc.movements).toEqual([]);
  });
  it('도시 모집 한도가 100명 미만으로 남아도 공통 올림 비용으로 재료를 확보한다', () => {
    const world = fixture();
    world.cityResources!.cities['1']!.garrison = [{ crewType: 1100, troops: 1950, train: 100, atmos: 100 }];
    expect(month(world).npc.state.logistics!.cities['1']!.iron).toBe(2);
  });
  it('기존 군자금으로 모집할 인원을 남기고 도시별 원래 금의 예산만 지출한다', () => {
    const world = fixture();
    world.logistics!.config.trade.iron.buy = 1000;
    const { npc } = month(world);
    expect(npc.state.logistics!.cities['1']!.iron).toBe(2);
    expect(npc.state.cityResources!.cities['1']!.gold).toBe(8000);
  });
});
