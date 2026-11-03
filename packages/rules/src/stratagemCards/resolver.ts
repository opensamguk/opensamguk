import { applyEffects } from '../commands/effects';
import type { CommandResolver } from '../commands/resolve';
import { fail, success } from '../commands/support';
import type { Actor, CommandDef } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { STRATAGEM_CARD_KINDS } from './config';
import { incrementCardsRevision, readStratagemCardsState, reconcileStratagemCards } from './state';
import { triggerStratagemTrap } from './trap';

const enabled = (world: WorldView) => world.ruleFeatures?.includes('stratagem-cards-v1') ?? false;
const cardFor = (key: string) => STRATAGEM_CARD_KINDS.find((kind) => kind !== 'trap' && kind === key);

function cardFailure(world: WorldView, actor: Actor, key: string, reserve: boolean) {
  if (!enabled(world) || !cardFor(key)) return null;
  const state = readStratagemCardsState(world.stratagemCards, world);
  if (reserve && !state.config.checkOnReserve) return null;
  const nationId = world.generals[actor.generalId]?.nationId;
  return nationId !== null && nationId !== undefined && state.nations[nationId]?.hand.includes(cardFor(key)!)
    ? null
    : fail('NO_SCHEME_CARD', '이 계략 패가 없습니다.');
}

// 실제 등록은 엔진·입력 경로를 함께 갖춘 뒤 한다. 현재는 명시 시험 config로만 검증한다.
export function createStratagemCardResolver(base: CommandResolver): CommandResolver {
  const definition = (key: string): CommandDef | undefined => {
    const original = base.get(key);
    if (!original) return undefined;
    return {
      ...original,
      check: (world, actor, args) => original.check(world, actor, args) ?? cardFailure(world, actor, key, false),
      precheck: (world, actor, args) => original.precheck(world, actor, args) ?? cardFailure(world, actor, key, true),
      execute(world, actor, args, rng) {
        if (!enabled(world)) return original.execute(world, actor, args, rng);
        const denied = original.check(world, actor, args) ?? cardFailure(world, actor, key, false);
        if (denied) throw Error(denied.message);
        let state = cloneWorld(world);
        const kind = cardFor(key);
        if (kind) {
          const cards = readStratagemCardsState(state.stratagemCards, state);
          // 확률 실패 미소모는 결과 판정 계약이 추가로 필요하다. 미구현 값을 조용히 무시하지 않는다.
          if (!cards.config.consumeOnRollFailure) throw Error('확률 실패 미소모 규칙은 아직 지원하지 않습니다.');
          const nationId = state.generals[actor.generalId]!.nationId!,
            hand = cards.nations[nationId]!.hand;
          hand.splice(hand.indexOf(kind), 1);
          incrementCardsRevision(cards);
          state.stratagemCards = cards;
        }
        const trap =
          key === 'attack' ? triggerStratagemTrap(state, actor, (args as { cityKey: number }).cityKey) : null;
        if (trap) state = trap.state;
        const result = trap?.cancelled
          ? { ...success('함정 피해로 출병 병력이 전투하지 못해 점령에 실패했습니다.'), effects: [] }
          : original.execute(state, actor, args, rng);
        state = applyEffects(state, result.effects);
        state.stratagemCards = reconcileStratagemCards(state, state.stratagemCards, actor.tick ?? 0);
        return {
          ...result,
          ...(trap
            ? {
                logs: [{ kind: 'success' as const, text: trap.text }, ...result.logs],
                history: [...trap.history, ...(result.history ?? [])],
              }
            : {}),
          effects: [{ kind: 'world', state }],
        };
      },
    };
  };
  const prepare = (actor: Actor, key: string, args: unknown) => {
    const def = definition(key);
    if (!def) return { failure: fail('UNKNOWN_COMMAND', '없는 명령입니다.') };
    if (def.target !== (actor.target ?? 'general')) return { failure: fail('BAD_ARGS', '명령 대상이 다릅니다.') };
    const parsed = def.args.safeParse(args);
    return parsed.success ? { def, args: parsed.data } : { failure: fail('BAD_ARGS', '명령 인자가 잘못되었습니다.') };
  };
  return {
    get: definition,
    list: (target) => base.list(target).map((def) => definition(def.key)!),
    precheck(world, actor, key, args) {
      if (!enabled(world) || !base.get(key)) return base.precheck(world, actor, key, args);
      const prepared = prepare(actor, key, args);
      return 'failure' in prepared ? prepared.failure : prepared.def.precheck(world, actor, prepared.args);
    },
    run(world, actor, key, args, rng) {
      if (!enabled(world) || !base.get(key)) return base.run(world, actor, key, args, rng);
      const prepared = prepare(actor, key, args);
      if ('failure' in prepared) return prepared.failure;
      return prepared.def.check(world, actor, prepared.args) ?? prepared.def.execute(world, actor, prepared.args, rng);
    },
  };
}
