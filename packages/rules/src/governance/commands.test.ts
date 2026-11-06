import { rngFor } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { testUnits } from '../../test/commandFixture';
import { createCommandResolver, createCommandResolverWithCommands, extensionCommands } from '../commands/resolve';
import { nationStrategyCommands } from '../nationStrategy/commands';
import type { Actor } from '../commands/types';
import { createCampaignCommandResolver } from '../campaign/commands';
import { deepFreeze } from '../personnel/testFixture';
import { createGovernanceCommandResolver, GOVERNANCE_HOSTILE_COMMANDS, governanceHostilityFailure } from './commands';
import { governanceFixture, vassal } from './testFixture';

const base = createCommandResolver({ general: ['fire_attack', 'sabotage', 'incite', 'plunder'], nation: [] });
function fixture() {
  const world = governanceFixture();
  world.governance!.vassals = [vassal(1, 2, 1)];
  world.governance!.nextVassalId = 2;
  return world;
}
describe('AC-P2-31 봉신 계열의 모든 명령 소비 경계', () => {
  it.each(GOVERNANCE_HOSTILE_COMMANDS)('%s를 조회 정의·목록·사전 판정·실행에서 모두 차단한다', (key) => {
    const selectedBase =
      key === 'nation_raid'
        ? createCommandResolverWithCommands({ general: [], nation: ['nation_raid'] }, [
            ...extensionCommands,
            ...nationStrategyCommands,
          ])
        : base;
    const world = deepFreeze(fixture()),
      resolver = createGovernanceCommandResolver(selectedBase);
    const nationTarget = key === 'nation_declare' || key === 'nation_raid';
    const actor: Actor = {
      generalId: 1,
      target: nationTarget ? 'nation' : 'general',
      tick: 0,
      unitSet: testUnits,
    };
    const args = nationTarget ? { nationId: 2 } : { cityKey: 2 };
    const def = resolver.get(key)!;
    expect(def).toBeDefined();
    expect(def.check(world, actor, args)?.code).toBe('VASSAL_BOUND');
    expect(def.precheck(world, actor, args)?.code).toBe('VASSAL_BOUND');
    expect(
      resolver
        .list(actor.target!)
        .find((entry) => entry.key === key)!
        .check(world, actor, args)?.code,
    ).toBe('VASSAL_BOUND');
    expect(resolver.precheck(world, actor, key, args)?.code).toBe('VASSAL_BOUND');
    const result = resolver.run(world, actor, key, args, rngFor('bound'));
    expect(result).toMatchObject({ code: 'VASSAL_BOUND' });
    expect(() => def.execute(world, actor, args, rngFor('bound'))).toThrow('같은 봉신 계열');
    expect(world.governance!.revision).toBe(0);
  });
  it('부곡이 바꾼 attack 정의도 가장 바깥에서 차단한다', () => {
    const resolver = createGovernanceCommandResolver(createCampaignCommandResolver(base));
    const world = deepFreeze(fixture()),
      actor = { generalId: 1, tick: 0, unitSet: testUnits };
    expect(resolver.get('attack')!.precheck(world, actor, { cityKey: 2 })?.code).toBe('VASSAL_BOUND');
    expect(resolver.run(world, actor, 'attack', { cityKey: 2 }, rngFor('campaign'))).toMatchObject({
      code: 'VASSAL_BOUND',
    });
  });
  it('예약 뒤 군주가 교체되면 현재 서명과 계열로 다시 판정한다', () => {
    const world = fixture(),
      actor = { generalId: 1, tick: 0 };
    expect(governanceHostilityFailure(world, actor, 'attack', { cityKey: 2 })?.code).toBe('VASSAL_BOUND');
    world.generals[2]!.officerLevel = 0;
    expect(governanceHostilityFailure(world, actor, 'attack', { cityKey: 2 })).toBeNull();
  });
  it('꺼진 월드의 명령 결과를 유지하며 거부한 명령은 난수를 쓰지 않는다', () => {
    const world = fixture(),
      resolver = createGovernanceCommandResolver(base),
      actor: Actor = { generalId: 1, target: 'nation', tick: 0 };
    const random = rngFor('unchanged'),
      untouched = rngFor('unchanged');
    resolver.run(world, actor, 'nation_declare', { nationId: 2 }, random);
    expect(random.pick([1, 2, 3, 4, 5])).toBe(untouched.pick([1, 2, 3, 4, 5]));
    world.ruleFeatures = [];
    delete world.governance;
    expect(resolver.run(deepFreeze(world), actor, 'nation_declare', { nationId: 2 }, rngFor('old'))).toEqual(
      base.run(world, actor, 'nation_declare', { nationId: 2 }, rngFor('old')),
    );
  });
});
