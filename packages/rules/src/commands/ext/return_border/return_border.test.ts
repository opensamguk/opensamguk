import { describe, expect, it, vi } from 'vitest';
import { createRng } from '@opensamguk/shared';
import { commandInitial, commandWorld, testUnits } from '../../../../test/commandFixture';
import { initialNationLifecycle } from '../../../nationLifecycle/state';
import { initialReplayState, runReplayAction } from '../../../replay';
import { resolverForRuleFeatures } from '../../../ruleCommands';
import { checkRuleFeatures } from '../../../ruleRegistry';
import { applyEffects } from '../../effects';
import { createCommandResolver } from '../../resolve';

const features = ['border-return-v1', 'nation-lifecycle-v1', 'personnel'];
const actor = { generalId: 1, tick: 0, unitSet: testUnits };
const key = 'return_border';

function makeWorld() {
  const world = commandWorld();
  world.ruleFeatures = [...features];
  world.nationLifecycle = initialNationLifecycle();
  world.generals[1]!.cityKey = 2;
  return world;
}

describe('AC-M1-14 접경귀환', () => {
  it('같은 거리의 아군 보급 도시를 중복 없이 정렬해 같은 시드로 도시만 바꾼다', () => {
    const world = makeWorld();
    world.cities[2]!.connections = [4, 3, 1, 4];
    world.cities[4]!.supplied = true;
    const before = structuredClone(world);
    const resolver = resolverForRuleFeatures(world)!;
    const rng = createRng('border-return');
    const pick = vi.spyOn(rng, 'pick');
    const result = resolver.run(world, actor, key, {}, rng);
    if ('code' in result) throw new Error(result.message);
    const cityKey = createRng('border-return').pick([1, 4]);
    expect(pick).toHaveBeenCalledExactlyOnceWith([1, 4]);
    expect(result.logs).toEqual([{ kind: 'success', text: `도시${cityKey} 접경귀환` }]);
    expect(applyEffects(world, result.effects)).toEqual({
      ...before,
      generals: { ...before.generals, 1: { ...before.generals[1], cityKey } },
    });
    expect(world).toEqual(before);
  });

  it('보급이 끊긴 아군 도시와 적 도시를 지나 거리 3의 보급 도시를 고른다', () => {
    const world = makeWorld();
    world.cities[2]!.connections = [1];
    world.cities[1]!.connections = [2, 3];
    world.cities[1]!.supplied = false;
    world.cities[3]!.nationId = 2;
    world.cities[4]!.supplied = true;
    const resolver = resolverForRuleFeatures(world)!;
    const rng = createRng('border-return-single');
    const pick = vi.spyOn(rng, 'pick');
    expect(resolver.precheck(world, actor, key, {})).toBeNull();
    expect(pick).not.toHaveBeenCalled();
    const result = resolver.run(world, actor, key, {}, rng);
    if ('code' in result) throw new Error(result.message);
    expect(pick).toHaveBeenCalledExactlyOnceWith([4]);
    expect(applyEffects(world, result.effects).generals[1]!.cityKey).toBe(4);
    world.cities[3]!.connections = [1, 5];
    world.cities[5] = { ...world.cities[3]!, cityKey: 5, connections: [3, 4] };
    expect(resolver.precheck(world, actor, key, {})).toEqual({
      code: 'BAD_TARGET',
      message: '3칸 안에 돌아갈 자기 국가 도시가 없습니다.',
    });
  });

  it('재야·아군 도시·방랑과 잘못된 인자·대상을 거부한다', () => {
    const world = makeWorld();
    const resolver = resolverForRuleFeatures(world)!;
    expect(resolver.precheck(world, { ...actor, generalId: 999 }, key, {})).toMatchObject({ code: 'NO_ACTOR' });
    expect(resolver.precheck(world, { ...actor, generalId: 4 }, key, {})).toMatchObject({ code: 'NOT_NATION' });
    expect(resolver.precheck(world, actor, key, { cityKey: 4 })).toMatchObject({ code: 'BAD_ARGS' });
    expect(resolver.precheck(world, { ...actor, target: 'nation' }, key, {})).toMatchObject({ code: 'BAD_ARGS' });
    world.generals[1]!.cityKey = 1;
    expect(resolver.precheck(world, actor, key, {})).toEqual({
      code: 'BAD_STATE',
      message: '이미 자기 국가 도시에 있습니다.',
    });
    world.cities[1]!.nationId = null;
    world.cities[4]!.nationId = null;
    world.nationLifecycle!.nations['1'] = { sinceTick: 0 };
    expect(resolver.precheck(world, actor, key, {})).toEqual({
      code: 'BAD_STATE',
      message: '방랑 중인 국가는 접경귀환할 수 없습니다.',
    });
  });

  it('새 월드에서만 목록에 추가하고 기존 귀환과 기능 선행 조건을 보존한다', () => {
    const world = makeWorld();
    const enabled = resolverForRuleFeatures(world)!;
    world.ruleFeatures = features.slice(1);
    const previous = resolverForRuleFeatures(world)!;
    expect(enabled.list('general').map(({ key }) => key)).toEqual([
      ...previous.list('general').map(({ key }) => key),
      key,
    ]);
    expect(previous.get(key)).toBeUndefined();
    expect(previous.run(world, actor, 'return', {}, createRng('return'))).toEqual(
      createCommandResolver(null).run(world, actor, 'return', {}, createRng('return')),
    );
    expect(() => checkRuleFeatures(['border-return-v1', 'personnel'])).toThrow('의존·충돌');
  });

  it('예턴을 실제 재생 명령 경로로 처리한다', () => {
    const initial = commandInitial();
    initial.ruleFeatures = [...features];
    Object.assign(initial.generals[0]!, { cityKey: 2, userId: 'player' });
    initial.nations[0]!.isNpc = false;
    const replay = initialReplayState(initial);
    replay.residenceAnchors = { 1: 0 };
    replay.turns[1]![0] = { commandKey: key, args: {} };
    const after = runReplayAction(replay, initial.seed, testUnits);
    expect(after.state.generals[1]!.cityKey).toBe(1);
    expect(after).toEqual(runReplayAction(replay, initial.seed, testUnits));
  });
});
