import type { Rng } from '@opensamguk/shared';
import type { WorldView } from '../model/world';
import { DOMESTIC_SPECS, makeInvestment } from './domestic/investment';
import { rest } from './rest';
import type { Actor, CommandDef, CommandResult, Failure } from './types';
export const commands: readonly CommandDef[] = [...DOMESTIC_SPECS.map(makeInvestment), rest];
export const commandRegistry = new Map(commands.map((command) => [command.key, command]));
export function runCommand(
  view: WorldView,
  actor: Actor,
  key: string,
  args: unknown,
  rng: Rng,
): CommandResult | Failure {
  const command = commandRegistry.get(key);
  if (!command) return { code: 'UNKNOWN_COMMAND', message: '없는 명령입니다.' };
  const parsed = command.args.safeParse(args);
  if (!parsed.success) return { code: 'BAD_ARGS', message: '명령 인자가 잘못되었습니다.' };
  return command.check(view, actor, parsed.data) ?? command.execute(view, actor, parsed.data, rng);
}
