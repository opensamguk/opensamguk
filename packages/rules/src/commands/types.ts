import type { z } from 'zod';
import type { Rng } from '@opensamguk/shared';
import type { WorldView } from '../model/world';
import type { Effect } from './effects';
import type { UnitSetResource } from '../world/resources';
import type { DeepReadonly } from '../model/world';
export interface Actor {
  generalId: number;
  target?: 'general' | 'nation';
  tick?: number;
  unitSet?: DeepReadonly<UnitSetResource> | undefined;
  authority?: 'office';
  campaignOrderId?: number;
  recordBattleStats?: true;
}
export interface Failure {
  code:
    | 'NO_ACTOR'
    | 'NOT_NATION'
    | 'NOT_OWN_CITY'
    | 'NO_SUPPLY'
    | 'NO_GOLD'
    | 'NO_GOODS'
    | 'NO_SCHEME_CARD'
    | 'AT_MAX'
    | 'BAD_ARGS'
    | 'UNKNOWN_COMMAND'
    | 'NO_RICE'
    | 'NO_CREW'
    | 'NOT_RULER'
    | 'BAD_TARGET'
    | 'NOT_ADJACENT'
    | 'NOT_WAR'
    | 'BAD_STATE'
    | 'NO_POPULATION'
    | 'NO_OFFER'
    | 'NO_UNIT_SET'
    | 'COMMAND_DISABLED'
    | 'VASSAL_BOUND'
    | 'PROTECTED';
  message: string;
}
export interface LogEntry {
  kind: 'success';
  text: string;
}
export interface CommandResult {
  effects: Effect[];
  logs: LogEntry[];
  reports?: { generalId: number; text: string }[];
  // 실제로 해결한 공격의 점령 전 대상이다. 알림·보고용이며 상태에는 넣지 않는다.
  attackTarget?: { cityKey: number; defendingNationId: number | null };
  history?: { nationId: number; text: string; kind?: 'intel' }[];
  // 순위용 집계 이벤트이며 재생 상태에는 넣지 않는다.
  battleAwards?: { generalId: number; wins: number; captures: number }[];
  stratagemSucceeded?: true;
  battleOutcomes?: { winnerId: number; loserId: number }[];
  generalEngagements?: {
    attackerId: number;
    defenderId: number;
    attackerLoss: number;
    defenderLoss: number;
    winnerId: number | null;
  }[];
}
export const COMMAND_CATEGORIES = ['domestic', 'military', 'strategy', 'personal', 'nation'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];
export interface CommandDef<Args = unknown> {
  key: string;
  name: string;
  category: CommandCategory;
  target: 'general' | 'nation';
  args: z.ZodType<Args>;
  precheck(view: WorldView, actor: Actor, args: Args): Failure | null;
  check(view: WorldView, actor: Actor, args: Args): Failure | null;
  execute(view: WorldView, actor: Actor, args: Args, rng: Rng): CommandResult;
}
