import type { CommandResolver } from './resolve';
import { rngFor } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import type { WorldState } from '../model/world';
import type { Actor, CommandResult, Failure } from './types';
import { applyEffects } from './effects';
import { commandRegistry, runCommand } from './registry';
import { chooseGeneralTurn, chooseNationTurn, type NpcContext } from '../npc';

export function runGeneralTurn(
  state: WorldState,
  actor: Actor,
  command: { commandKey: string; args: unknown },
  seed: string,
  options: Pick<NpcContext, 'convergence'> = {},
  resolver?: CommandResolver,
) {
  const run = resolver ? resolver.run.bind(resolver) : runCommand;
  const general = state.generals[actor.generalId]!;
  const nationId = general.nationId;
  let next = state;
  let nation: { commandKey: string; result: CommandResult | Failure; nationId: number } | undefined;
  // 국가 예턴은 턴 시작 시 군주가 한 번만 실행한다. 국가 명령 뒤 장수 명령을 재검사한다.
  const npcNation = general.userId === null && nationId !== null && state.nations[nationId]?.isNpc;
  const context = { ...options, tick: actor.tick ?? 0, unitSet: actor.unitSet };
  if (
    nationId !== null &&
    general.officerLevel === BALANCE.RULER_LEVEL &&
    (state.nationTurns?.[nationId] || npcNation)
  ) {
    const queue = state.nationTurns?.[nationId];
    let slot = queue?.[0] ?? { commandKey: 'nation_rest', args: {} };
    if (
      npcNation &&
      slot.commandKey === 'nation_rest' &&
      commandRegistry.get('nation_rest')!.args.safeParse(slot.args).success
    ) {
      const decision = chooseNationTurn(next, general, rngFor(seed, 'npc-nation', actor.tick ?? 0, nationId), context);
      if (decision.chosen) slot = { commandKey: decision.chosen.key, args: decision.chosen.args };
    }
    const result = run(
      next,
      { ...actor, target: 'nation' },
      slot.commandKey,
      slot.args,
      rngFor(seed, 'nation-turn', actor.tick ?? 0, nationId),
    );
    next = applyEffects(next, 'code' in result ? [] : result.effects);
    if (queue && next.nations[nationId]) {
      next.nationTurns ??= {};
      next.nationTurns[nationId] = Array.from(
        { length: 30 },
        (_, slot) => queue[slot + 1] ?? { commandKey: 'nation_rest', args: {} },
      );
    }
    nation = { commandKey: slot.commandKey, result, nationId };
  }
  let selected = command;
  if (
    general.userId === null &&
    command.commandKey === 'rest' &&
    commandRegistry.get('rest')!.args.safeParse(command.args).success
  ) {
    const decision = chooseGeneralTurn(
      next,
      next.generals[actor.generalId]!,
      rngFor(seed, 'npc', actor.tick ?? 0, actor.generalId),
      context,
    );
    if (decision.chosen) selected = { commandKey: decision.chosen.key, args: decision.chosen.args };
  }
  const result = run(
    next,
    { ...actor, target: 'general' },
    selected.commandKey,
    selected.args,
    rngFor(seed, 'turn', actor.tick ?? 0, actor.generalId),
  );
  next = applyEffects(next, 'code' in result ? [] : result.effects);
  return { state: next, result, nation, commandKey: selected.commandKey };
}
