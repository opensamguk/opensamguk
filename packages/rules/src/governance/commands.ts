import type { Rng } from '@opensamguk/shared';
import { applyEffects } from '../commands/effects';
import type { CommandResolver } from '../commands/resolve';
import { fail } from '../commands/support';
import type { Actor, CommandDef, Failure } from '../commands/types';
import type { WorldView } from '../model/world';
import { governanceRealmIndex } from './realm';
import { reconcileGovernance } from './reconcile';

export const GOVERNANCE_HOSTILE_COMMANDS = [
  'nation_declare',
  'nation_raid',
  'attack',
  'fire_attack',
  'sabotage',
  'incite',
  'plunder',
] as const;
const hostile = new Set<string>(GOVERNANCE_HOSTILE_COMMANDS);

export function governanceHostilityFailure(
  world: WorldView,
  actor: Actor,
  key: string,
  value: unknown,
): Failure | null {
  if (!world.ruleFeatures?.includes('governance-v1') || !hostile.has(key)) return null;
  if (!world.governance) throw new Error('황실 기능이 켜진 월드의 상태가 없습니다.');
  const nationId = world.generals[actor.generalId]?.nationId;
  if (nationId === null || nationId === undefined || !world.nations[nationId] || !value || typeof value !== 'object')
    return null;
  const nationTarget = key === 'nation_declare' || key === 'nation_raid';
  const targetKey = nationTarget ? 'nationId' : 'cityKey';
  if (!(targetKey in value)) return null;
  const target = (value as Record<string, unknown>)[targetKey];
  if (typeof target !== 'number' || !Number.isInteger(target) || target < 1) return null;
  const targetNation = nationTarget ? target : world.cities[target]?.nationId;
  if (targetNation === null || targetNation === undefined || !world.nations[targetNation] || targetNation === nationId)
    return null;
  const index = governanceRealmIndex(world, world.governance, actor.tick ?? 0);
  return index.root(nationId).nationId === index.root(targetNation).nationId
    ? fail('VASSAL_BOUND', '같은 봉신 계열의 국가를 공격하거나 선전포고할 수 없습니다.')
    : null;
}

export function createGovernanceCommandResolver(base: CommandResolver): CommandResolver {
  const definition = (key: string): CommandDef | undefined => {
    const original = base.get(key);
    if (!original) return undefined;
    return {
      ...original,
      check: (world, actor, args) =>
        governanceHostilityFailure(world, actor, key, args) ?? original.check(world, actor, args),
      precheck: (world, actor, args) =>
        governanceHostilityFailure(world, actor, key, args) ?? original.precheck(world, actor, args),
      execute(world, actor, args, rng) {
        if (!world.ruleFeatures?.includes('governance-v1')) return original.execute(world, actor, args, rng);
        const denied = governanceHostilityFailure(world, actor, key, args) ?? original.check(world, actor, args);
        if (denied) throw new Error(denied.message);
        const result = original.execute(world, actor, args, rng);
        const state = reconcileGovernance(applyEffects(world, result.effects), actor.tick ?? 0);
        return { ...result, effects: [{ kind: 'world', state }] };
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
      const prepared = prepare(actor, key, args);
      return 'failure' in prepared ? prepared.failure : prepared.def.precheck(world, actor, prepared.args);
    },
    run(world, actor, key, args, rng: Rng) {
      const prepared = prepare(actor, key, args);
      if ('failure' in prepared) return prepared.failure;
      return prepared.def.check(world, actor, prepared.args) ?? prepared.def.execute(world, actor, prepared.args, rng);
    },
  };
}
