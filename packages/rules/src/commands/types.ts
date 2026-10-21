import type { z } from 'zod';
import type { Rng } from '@opensamguk/shared';
import type { WorldView } from '../model/world';
import type { Effect } from './effects';
export interface Actor {
  generalId: number;
}
export interface Failure {
  code:
    'NO_ACTOR' | 'NOT_NATION' | 'NOT_OWN_CITY' | 'NO_SUPPLY' | 'NO_GOLD' | 'AT_MAX' | 'BAD_ARGS' | 'UNKNOWN_COMMAND';
  message: string;
}
export interface LogEntry {
  kind: 'success';
  text: string;
}
export interface CommandResult {
  effects: Effect[];
  logs: LogEntry[];
}
export const COMMAND_CATEGORIES = ['domestic', 'military', 'strategy', 'personal', 'nation'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];
export interface CommandDef<Args = Record<string, never>> {
  key: string;
  name: string;
  category: CommandCategory;
  target: 'general' | 'nation';
  args: z.ZodType<Args>;
  precheck(view: WorldView, actor: Actor, args: Args): Failure | null;
  check(view: WorldView, actor: Actor, args: Args): Failure | null;
  execute(view: WorldView, actor: Actor, args: Args, rng: Rng): CommandResult;
}
