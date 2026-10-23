import { rngFor } from '@opensamguk/shared';
import { commandRegistry, runCommand } from '../commands/registry';
import type { CommandResolver } from '../commands/resolve';
import type { Actor, CommandResult } from '../commands/types';
import type { WorldView } from '../model/world';
import { choosePolicyCommand, policyOptions, type PolicyKey, type PolicySlot } from './index';

export function runPolicySlot(
  view: WorldView,
  actor: Actor,
  slot: PolicySlot,
  policy: PolicyKey,
  seed: string,
  resolver?: CommandResolver,
) {
  if (slot.explicit !== false || view.generals[actor.generalId]?.userId == null) return null;
  return runPolicyCommand(view, actor, policy, seed, resolver);
}

export function runPolicyCommand(
  view: WorldView,
  actor: Actor,
  policy: PolicyKey,
  seed: string,
  resolver?: CommandResolver,
): { commandKey: string; result: CommandResult } {
  const selected = choosePolicyCommand(view, actor.generalId, policy);
  if (!selected) throw new Error('기본 방침을 실행할 사람 장수가 없습니다.');
  const run = resolver ? resolver.run.bind(resolver) : runCommand;
  const result = run(
    view,
    actor,
    selected.commandKey,
    selected.args,
    rngFor(seed, 'turn', actor.tick ?? 0, actor.generalId),
  );
  if ('code' in result) {
    const rest = run(view, actor, 'rest', {}, rngFor(seed, 'turn', actor.tick ?? 0, actor.generalId));
    if ('code' in rest) throw new Error(rest.message);
    return {
      commandKey: 'rest',
      result: {
        ...rest,
        logs: [{ kind: 'success', text: `기본 방침 실패: ${result.message} → 휴식` }],
      },
    };
  }
  if (policy !== 'none')
    result.logs.unshift({
      kind: 'success',
      text: `기본 방침(${policyOptions().find((option) => option.key === policy)!.name})으로 ${commandRegistry.get(selected.commandKey)!.name}`,
    });
  return { commandKey: selected.commandKey, result };
}
