import { applyEffects } from '../commands/effects';
import type { Rng } from '@opensamguk/shared';
import type { CommandResolver } from '../commands/resolve';
import type { Actor, CommandResult } from '../commands/types';
import type { WorldView } from '../model/world';
import { cloneWorld } from '../model/clone';
import { reconcileNationLifecycle } from './operations';
import { isWandering } from './state';

const lifecycleKeys = new Set(['abdicate', 'wander', 'resettle', 'disband']);

// 부곡의 사람 부장 이동 검사가 돌기 전에 승인된 방랑 국가의 동행을 반영한다.
export function createNationLifecycleResolver(base: CommandResolver): CommandResolver {
  function finish(world: WorldView, actor: Actor, key: string, result: CommandResult): CommandResult {
    const general = world.generals[actor.generalId];
    const following = key === 'move' && general?.officerLevel === 12 && isWandering(world, general.nationId);
    if (!lifecycleKeys.has(key) && !following) return result;
    const state = applyEffects(cloneWorld(world), result.effects);
    const reports = [...(result.reports ?? [])];
    if (following) {
      const destination = state.generals[actor.generalId]!.cityKey;
      if (destination !== general.cityKey)
        for (const member of Object.values(state.generals).sort((a, b) => a.id - b.id)) {
          if (member.nationId !== general.nationId || member.cityKey === destination) continue;
          member.cityKey = destination;
          reports.push({ generalId: member.id, text: `방랑 동행: ${state.cities[destination]!.name}` });
        }
    }
    return {
      ...result,
      effects: [{ kind: 'world', state: reconcileNationLifecycle(state, actor.tick ?? 0) }],
      ...(reports.length ? { reports } : {}),
    };
  }
  const definition = (key: string) => {
    const original = base.get(key);
    if (!original || (!lifecycleKeys.has(key) && key !== 'move')) return original;
    return {
      ...original,
      execute: (world: WorldView, actor: Actor, args: unknown, rng: Rng) =>
        finish(world, actor, key, original.execute(world, actor, args, rng)),
    };
  };
  return {
    get: definition,
    list: (target) => base.list(target).map((command) => definition(command.key)!),
    precheck: (world, actor, key, args) => base.precheck(world, actor, key, args),
    run(world, actor, key, args, rng) {
      const result = base.run(world, actor, key, args, rng);
      return 'code' in result ? result : finish(world, actor, key, result);
    },
  };
}
