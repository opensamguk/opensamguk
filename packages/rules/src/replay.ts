import type { CommandResolver } from './commands/resolve';
import { rngFor } from '@opensamguk/shared';
import { runGeneralTurn } from './commands/turn';
import type { UnitSetResource } from './world/resources';
import { TICKS_PER_MONTH } from './clock/constants';
import { toWorldState, type WorldState, type OfficeRevisions } from './model/world';
import { monthlyDate, runMonthly } from './monthly/index';
import type { InitialGeneral, WorldInit } from './world/bootstrap';
import { emptyTurn, emptyQueue } from './policy';
import { type ReplayPolicy, validatePolicyRecordedInput } from './policy/replay';

export interface QueuedTurn {
  commandKey: string;
  args: unknown;
  explicit?: boolean;
}
export interface ReplayState {
  state: WorldState;
  turns: Record<number, QueuedTurn[]>;
  revisions: Record<number, number>;
  monthlyTick: number;
  policy?: ReplayPolicy;
  offices?: OfficeRevisions;
}
export interface RecordedInput {
  sequence: number;
  generalId: number | null;
  kind: string;
  status: 'APPLIED' | 'REJECTED';
  payload: unknown;
  result: unknown;
}
export const emptyTurns = (): QueuedTurn[] => Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} }));

export function initialReplayState(initial: WorldInit): ReplayState {
  return {
    state: toWorldState(initial),
    turns: Object.fromEntries(initial.generals.map(({ id }) => [id, emptyTurns()])),
    revisions: Object.fromEntries(initial.generals.map(({ id }) => [id, 0])),
    monthlyTick: 0,
  };
}

export function nextGameAction(replay: ReplayState) {
  const boundary = replay.monthlyTick + TICKS_PER_MONTH;
  const year = monthlyDate(replay.state.startYear, boundary).year;
  const due = Object.values(replay.state.generals)
    .filter((general) => general.activeFromYear <= year)
    .sort((a, b) => a.nextTurnTick - b.nextTurnTick || a.id - b.id)[0];
  return due && due.nextTurnTick < boundary
    ? { kind: 'turn' as const, tick: due.nextTurnTick, generalId: due.id }
    : { kind: 'monthly' as const, tick: boundary };
}

export function runReplayAction(
  replay: ReplayState,
  seed: string,
  unitSet?: UnitSetResource,
  resolver?: CommandResolver,
): ReplayState {
  const action = nextGameAction(replay);
  if (action.kind === 'monthly') {
    const date = monthlyDate(replay.state.startYear, action.tick);
    const result = runMonthly(replay.state, action.tick, rngFor(seed, 'monthly', date.year, date.month));
    return { ...replay, state: result.state, monthlyTick: action.tick };
  }
  const next = structuredClone(replay);
  const turns = next.turns[action.generalId] ?? emptyTurns();
  const command = turns[0]!;
  const result = runGeneralTurn(
    next.state,
    { generalId: action.generalId, tick: action.tick, unitSet },
    command,
    seed,
    next.policy ? { policy: next.policy.policies[action.generalId]! } : {},
    resolver,
  );
  next.state = result.state;
  next.state.generals[action.generalId]!.nextTurnTick += TICKS_PER_MONTH;
  next.turns[action.generalId] = [...turns.slice(1), next.policy ? emptyTurn() : { commandKey: 'rest', args: {} }];
  next.revisions[action.generalId] = (next.revisions[action.generalId] ?? 0) + 1;
  return next;
}

export function applyRecordedInput(replay: ReplayState, input: RecordedInput): ReplayState {
  if (replay.policy) validatePolicyRecordedInput(input, true);
  if (input.status === 'REJECTED') return replay;
  const next = structuredClone(replay);
  if (input.kind === 'turns.set') {
    const payload = input.payload as { turns?: QueuedTurn[]; revision?: number };
    const result = input.result as { revision?: number; activeTick?: number };
    const id = input.generalId;
    if (
      id === null ||
      !next.state.generals[id] ||
      payload.revision !== next.revisions[id] ||
      result.revision !== payload.revision! + 1 ||
      !Array.isArray(payload.turns) ||
      payload.turns.length !== 30 ||
      payload.turns.some((turn) => !turn || typeof turn.commandKey !== 'string' || !Object.hasOwn(turn, 'args'))
    ) {
      throw new Error('예턴 입력 기록의 장수·revision·30칸을 확인하세요.');
    }
    next.turns[id] = structuredClone(payload.turns);
    next.revisions[id] = result.revision!;
    if (next.policy && next.state.generals[id]!.userId !== null)
      next.policy.lastActiveTicks[id] = Math.max(next.policy.lastActiveTicks[id]!, result.activeTick!);
  } else if (input.kind === 'general.create') {
    const general = (input.result as { general?: InitialGeneral }).general;
    if (
      !general ||
      !Number.isSafeInteger(general.id) ||
      general.id !== input.generalId ||
      next.state.generals[general.id] ||
      !next.state.cities[general.cityKey] ||
      !Number.isSafeInteger(general.nextTurnTick) ||
      general.nextTurnTick < next.monthlyTick
    ) {
      throw new Error('장수 생성 결과가 올바르지 않습니다.');
    }
    next.state.generals[general.id] = structuredClone(general);
    next.turns[general.id] = next.policy ? emptyQueue() : emptyTurns();
    next.revisions[general.id] = 0;
    if (next.policy) {
      if (typeof general.userId !== 'string') throw new Error('생성한 사람 장수의 사용자가 없습니다.');
      next.policy.policies[general.id] = 'none';
      next.policy.lastActiveTicks[general.id] = (input.result as { activeTick: number }).activeTick;
    }
  } else if (next.policy && (input.kind === 'general.setPolicy' || input.kind === 'general.active')) {
    const id = input.generalId;
    if (id === null || !next.state.generals[id] || next.state.generals[id]!.userId === null)
      throw new Error('활동 입력의 사람 장수가 없습니다.');
    const result = input.result as { activeTick: number; policy?: import('./policy').PolicyKey };
    if (input.kind === 'general.setPolicy') next.policy.policies[id] = result.policy!;
    next.policy.lastActiveTicks[id] = Math.max(next.policy.lastActiveTicks[id]!, result.activeTick);
  } else {
    throw new Error(`재생할 수 없는 입력 종류입니다: ${input.kind}`);
  }
  return next;
}
