import { expect, it, vi } from 'vitest';
import { createRng } from '@opensamguk/shared';
import { commandWorld } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { createCommandResolver } from '../commands/resolve';
import { cloneWorld } from '../model/clone';
import { initialStratagemCards } from './state';
import { createStratagemCardResolver } from './resolver';
import { TEST_STRATAGEM_CARDS_CONFIG } from './testFixture';

const base = createCommandResolver({ general: ['fire_attack', 'sabotage', 'incite', 'plunder'], nation: [] }),
  resolver = createStratagemCardResolver(base),
  actor = { generalId: 1, tick: 0 },
  target = { cityKey: 2 };
const setup = () => {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'stratagem-basic', 'stratagem-cards-v1'];
  for (const general of Object.values(world.generals)) {
    general.politics = general.intel;
    general.charm = general.leadership;
  }
  world.stratagemCards = initialStratagemCards(TEST_STRATAGEM_CARDS_CONFIG, world, 'consume-fixture');
  return world;
};
const failingRoll = () => {
  const rng = createRng('failed-roll');
  vi.spyOn(rng, 'next').mockReturnValue(0.999999);
  return rng;
};

it.each(['fire_attack', 'sabotage', 'incite', 'plunder'])('AC-P2-23 %s는 확률 실패에도 해당 패 한 장만 쓴다', (key) => {
  const world = setup(),
    kind = key as 'fire_attack' | 'sabotage' | 'incite' | 'plunder';
  world.stratagemCards!.nations[1]!.hand = [kind, 'trap', kind];
  const before = structuredClone(world),
    ordinary = base.run(world, actor, key, target, failingRoll()),
    result = resolver.run(world, actor, key, target, failingRoll());
  if ('code' in ordinary || 'code' in result) throw Error('계략 고정물이 실행 조건을 만족하지 못했습니다.');
  const expected = applyEffects(cloneWorld(world), ordinary.effects),
    actual = applyEffects(cloneWorld(world), result.effects);
  expect(result.logs).toEqual(ordinary.logs);
  expect(result.logs.some((log) => log.text.includes('실패'))).toBe(true);
  expect(actual.stratagemCards!.nations[1]!.hand).toEqual(['trap', kind]);
  expect(actual.stratagemCards!.revision).toBe(1);
  expected.stratagemCards = actual.stratagemCards!;
  expect(actual).toEqual(expected);
  expect(world).toEqual(before);
});

it('AC-P2-23 패 없이 예약할 수 있고 실행 때는 RNG·자원을 쓰지 않고 거부한다', () => {
  const world = setup(),
    before = structuredClone(world),
    rng = createRng('no-card'),
    next = vi.spyOn(rng, 'next');
  expect(resolver.precheck(world, actor, 'fire_attack', target)).toBeNull();
  expect(resolver.run(world, actor, 'fire_attack', target, rng)).toMatchObject({ code: 'NO_SCHEME_CARD' });
  expect(next).not.toHaveBeenCalled();
  expect(world).toEqual(before);
});

it('AC-P2-23 명시한 예약 검사와 일반 권한·자원 검사를 보존한다', () => {
  const world = setup();
  world.stratagemCards!.config.checkOnReserve = true;
  expect(resolver.precheck(world, actor, 'fire_attack', target)).toMatchObject({ code: 'NO_SCHEME_CARD' });
  world.generals[1]!.gold = 0;
  expect(resolver.precheck(world, actor, 'fire_attack', target)).toMatchObject({ code: 'NO_GOLD' });
  expect(resolver.run(world, actor, 'fire_attack', target, createRng('guard'))).toMatchObject({ code: 'NO_GOLD' });
  expect(resolver.run(world, actor, 'fire_attack', { cityKey: 1 }, createRng('guard'))).toMatchObject({
    code: 'BAD_TARGET',
  });
});

it('AC-P2-23 덱에서 빠진 계략도 패 소비 검사를 우회하지 못한다', () => {
  const world = setup();
  world.stratagemCards!.config.deck = world.stratagemCards!.config.deck.filter((card) => card.kind !== 'fire_attack');
  expect(resolver.run(world, actor, 'fire_attack', target, createRng('missing-kind'))).toMatchObject({
    code: 'NO_SCHEME_CARD',
  });
});

it('AC-P2-23 같은 국가 두 장수가 한 장을 함께 쓰면 먼저 실행한 한 명만 쓴다', () => {
  const world = setup();
  world.generals[3] = { ...world.generals[1]!, id: 3 };
  world.stratagemCards!.nations[1]!.hand = ['fire_attack'];
  const first = resolver.run(world, actor, 'fire_attack', target, failingRoll());
  if ('code' in first) throw Error(first.message);
  const after = applyEffects(cloneWorld(world), first.effects),
    before = structuredClone(after),
    rng = failingRoll();
  expect(resolver.run(after, { generalId: 3, tick: 0 }, 'fire_attack', target, rng)).toMatchObject({
    code: 'NO_SCHEME_CARD',
  });
  expect(rng.next).not.toHaveBeenCalled();
  expect(after).toEqual(before);
});

it('AC-P2-23 일반 명령과 기능을 끈 월드의 결과·난수 소비는 그대로다', () => {
  const off = commandWorld();
  for (const key of ['fire_attack', 'farm']) {
    const args = key === 'farm' ? {} : target,
      left = createRng('off-golden'),
      right = createRng('off-golden');
    expect(resolver.run(off, actor, key, args, left)).toEqual(base.run(off, actor, key, args, right));
    expect(left.next()).toBe(right.next());
  }
  const on = setup(),
    result = resolver.run(on, actor, 'farm', {}, createRng('farm'));
  if ('code' in result) throw Error(result.message);
  expect(applyEffects(cloneWorld(on), result.effects).stratagemCards).toEqual(on.stratagemCards);
});

it('AC-P2-23 아직 구현하지 않은 확률 실패 미소모 값과 revision 넘침은 적용 전에 멈춘다', () => {
  const world = setup();
  world.stratagemCards!.nations[1]!.hand = ['fire_attack'];
  world.stratagemCards!.config.consumeOnRollFailure = false;
  const before = structuredClone(world),
    rng = failingRoll();
  expect(() => resolver.run(world, actor, 'fire_attack', target, rng)).toThrow('아직 지원');
  expect(rng.next).not.toHaveBeenCalled();
  expect(world).toEqual(before);
  world.stratagemCards!.config.consumeOnRollFailure = true;
  world.stratagemCards!.revision = 2_147_483_647;
  expect(() => resolver.run(world, actor, 'fire_attack', target, rng)).toThrow('한도');
  expect(rng.next).not.toHaveBeenCalled();
});

it.each([false, true])('AC-P2-23 꺼진 명령과 없는 명령의 원래 오류를 보존한다 (기능=%s)', (on) => {
  const ordinary = createCommandResolver({ general: [], nation: [] }),
    wrapped = createStratagemCardResolver(ordinary),
    world = on ? setup() : commandWorld();
  for (const key of ['fire_attack', 'not-a-command']) {
    expect(wrapped.precheck(world, actor, key, target)).toEqual(ordinary.precheck(world, actor, key, target));
    expect(wrapped.run(world, actor, key, target, createRng('errors'))).toEqual(
      ordinary.run(world, actor, key, target, createRng('errors')),
    );
  }
  expect(wrapped.run(world, actor, 'fire_attack', target, createRng('disabled'))).toMatchObject({
    code: 'COMMAND_DISABLED',
  });
});
