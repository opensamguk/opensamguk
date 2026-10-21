import { rngFor } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import type { WorldState } from '../model/world';
import type { Actor, CommandResult, Failure } from './types';
import { applyEffects } from './effects';
import { runCommand } from './registry';

export function runGeneralTurn(
  state: WorldState,
  actor: Actor,
  command: { commandKey: string; args: unknown },
  seed: string,
) {
  const general = state.generals[actor.generalId]!;
  const nationId = general.nationId;
  let next = state;
  let nation: { commandKey: string; result: CommandResult | Failure; nationId: number } | undefined;
  // 국가 예턴은 턴 시작 시 군주가 한 번만 실행한다. 국가 명령 뒤 장수 명령을 재검사한다.
  if (nationId !== null && general.officerLevel === BALANCE.RULER_LEVEL && state.nationTurns?.[nationId]) {
    const queue = state.nationTurns?.[nationId];
    const slot = queue?.[0] ?? { commandKey: 'nation_rest', args: {} };
    const result = runCommand(
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
  const result = runCommand(
    next,
    { ...actor, target: 'general' },
    command.commandKey,
    command.args,
    rngFor(seed, 'turn', actor.tick ?? 0, actor.generalId),
  );
  next = applyEffects(next, 'code' in result ? [] : result.effects);
  return { state: next, result, nation };
}
