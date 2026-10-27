import { describe, expect, it } from 'vitest';
import { rngFor, type Rng } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { createCommandResolver, createCommandResolverWithCommands, extensionCommands } from '../commands/resolve';
import { trade } from '../commands/trade';
import { applyEffects } from '../commands/effects';
import { deepFreeze } from '../personnel/testFixture';
import { createCampaignCommandResolver } from './commands';
import { emptyCampaignState } from './state';

const base = createCommandResolver({ general: ['fire_attack', 'sabotage', 'incite', 'plunder'], nation: [] });
const resolver = createCampaignCommandResolver(base);
const actor = { generalId: 1, tick: 100, unitSet: testUnits };
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  world.generals[1]!.userId = 'owner';
  world.campaign = emptyCampaignState(world, 'command-seed', 'sourced-fixture');
  return world;
}
function run(world: ReturnType<typeof fixture>, key: string, args: unknown, rng = rngFor('commands', key)) {
  const result = resolver.run(deepFreeze(world), actor, key, args, rng);
  if ('code' in result) throw new Error(result.message);
  return { result, state: applyEffects(world, result.effects) };
}
describe('AC-INT-09 기존 명령의 부곡 실행 연결', () => {
  it('교역의 예약 사전검사와 실행 검사를 구별하고 꺼진 명령 오류를 보존한다', () => {
    const world = fixture();
    const tradeBase = createCommandResolverWithCommands({ general: ['trade'], nation: [] }, [
      ...extensionCommands,
      trade,
    ]);
    const wrapped = createCampaignCommandResolver(tradeBase);
    expect(tradeBase.precheck(world, actor, 'trade', { cityKey: 2 })).toBeNull();
    expect(wrapped.precheck(world, actor, 'trade', { cityKey: 2 })).toBeNull();
    expect(wrapped.run(world, actor, 'trade', { cityKey: 2 }, rngFor('trade'))).toMatchObject({ code: 'BAD_STATE' });
    for (const key of ['plunder', 'unknown']) {
      expect(wrapped.precheck(world, actor, key, null)).toEqual(tradeBase.precheck(world, actor, key, null));
      expect(wrapped.run(world, actor, key, null, rngFor('disabled'))).toEqual(
        tradeBase.run(world, actor, key, null, rngFor('disabled')),
      );
    }
  });
  it('기존 모병·훈련·사기·소집해제 명령은 부곡만 바꾸고 비용을 한 번 쓴다', () => {
    const world = fixture();
    let next = run(world, 'recruit', { amount: 100, crewType: 1100 }).state;
    expect(next.generals[1]!.crew).toBe(0);
    expect(next.campaign!.units[0]!.troops).toBe(100);
    const gold = next.generals[1]!.gold;
    next = run(next, 'train', {}).state;
    expect(next.generals[1]!.gold).toBe(gold - 100);
    expect(next.campaign!.units[0]!.train).toBeGreaterThan(0);
    next = run(next, 'morale', {}).state;
    expect(next.campaign!.units[0]!.atmos).toBeGreaterThan(0);
    next = run(next, 'dismiss', {}).state;
    expect(next.campaign!.units[0]!.troops).toBe(0);
    expect(next.cities[1]!.population).toBe(world.cities[1]!.population);
  });
  it('기존 이동·귀환은 같은 거점의 NPC 지휘관과 부곡을 따르게 한다', () => {
    const world = fixture();
    Object.assign(world.generals[4]!, { nationId: 1, cityKey: 1, officerLevel: 1 });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    world.campaign!.units = [{ id: 1, ownerId: 1, commanderId: 4, troops: 100, crewType: 1100, train: 50, atmos: 50 }];
    world.campaign!.nextUnitId = 2;
    world.cities[2]!.nationId = 1;
    let next = run(world, 'move', { cityKey: 2 }).state;
    expect(next.generals[4]!.cityKey).toBe(2);
    next = run(next, 'return', {}).state;
    expect(next.generals[4]!.cityKey).toBe(1);
    expect(next.campaign).toEqual(world.campaign);
  });
  it('사람 휘하를 둔 소속 변경과 휘하 NPC의 독립 군사 행동은 사전 거부한다', () => {
    const world = fixture();
    Object.assign(world.generals[1]!, { officerLevel: 1 });
    Object.assign(world.generals[4]!, { nationId: 1, userId: 'other' });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'STAFF' }];
    expect(resolver.precheck(world, actor, 'resign', {})?.code).toBe('BAD_STATE');
    expect(resolver.precheck(world, { ...actor, generalId: 4 }, 'resign', {})?.code).toBe('BAD_STATE');
    world.generals[4]!.userId = null;
    expect(resolver.precheck(world, { ...actor, generalId: 4 }, 'move', { cityKey: 2 })?.code).toBe('COMMAND_DISABLED');
  });
  it('소속을 바꾸면 NPC 하위 관계와 소유 병력을 보존하고 사람 예약은 건드리지 않는다', () => {
    const world = fixture();
    Object.assign(world.generals[1]!, { nationId: null, officerLevel: 0, cityKey: 3 });
    Object.assign(world.generals[4]!, { nationId: null, officerLevel: 0, cityKey: 3 });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    world.campaign!.units = [{ id: 1, ownerId: 1, commanderId: 4, troops: 100, crewType: 1100, train: 50, atmos: 50 }];
    world.campaign!.nextUnitId = 2;
    const { state } = run(world, 'join', { nationId: 1 });
    expect([state.generals[1]!.nationId, state.generals[4]!.nationId]).toEqual([1, 1]);
    expect(state.generals[4]!.cityKey).toBe(1);
    expect(state.campaign!.units).toEqual(world.campaign!.units);
  });
  it('거병의 병력 조건은 General.crew를 채우지 않고 자기 부곡으로 검사한다', () => {
    const world = fixture();
    Object.assign(world.generals[1]!, { nationId: null, officerLevel: 0, cityKey: 3 });
    world.campaign!.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 50, atmos: 50 }];
    world.campaign!.nextUnitId = 2;
    const { state, result } = run(world, 'uprising', { name: '새 나라', color: '#123456' });
    expect(state.generals[1]!.nationId).not.toBeNull();
    expect(state.generals[1]!.crew).toBe(0);
    expect(state.campaign!.units[0]!.troops).toBe(100);
    expect(result.logs[0]!.text).toBe('새 나라 거병');
  });
  it('계략은 기존 부상 RNG를 유지하며 실제 지휘 부곡에만 병력·훈련·사기 피해를 준다', () => {
    const world = fixture();
    world.generals[3]!.cityKey = 3;
    world.campaign!.units = [{ id: 1, ownerId: 2, commanderId: 2, troops: 1000, crewType: 1100, train: 80, atmos: 70 }];
    world.campaign!.nextUnitId = 2;
    const makeRng = () => {
      const calls: string[] = [];
      const rng: Rng = {
        next: () => {
          calls.push('next');
          return 0;
        },
        int: (min) => {
          calls.push('int');
          return min;
        },
        pick: (values) => values[0]!,
      };
      return { rng, calls };
    };
    const actual = makeRng(),
      legacy = makeRng();
    const legacyResult = base.run(world, actor, 'fire_attack', { cityKey: 2 }, legacy.rng);
    if ('code' in legacyResult) throw new Error(legacyResult.message);
    const { state } = run(world, 'fire_attack', { cityKey: 2 }, actual.rng);
    expect(actual.calls).toEqual(legacy.calls);
    expect(state.campaign!.units[0]).toMatchObject({ troops: 980, train: 78, atmos: 69 });
    expect(state.generals[2]!.crew).toBe(0);
    expect(state.generals[2]!.train).toBe(world.generals[2]!.train);
    expect(state.generals[2]!.injury).toBeGreaterThan(world.generals[2]!.injury);
    expect(state.campaign!.revision).toBe(1);
  });
});
