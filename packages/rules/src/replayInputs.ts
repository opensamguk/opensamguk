import type { InitialGeneral } from './world/bootstrap';
import type { QueuedTurn, RecordedInput, ReplayState } from './replay';
import { emptyQueue } from './policy';
import { validatePolicyRecordedInput } from './policy/replay';
import { assertGeneralStatProfile, FIVE_STAT_KEYS, FIVE_STAT_RULES } from './general/fiveStats';
import { validateGeneralCreation } from './general/create';

export function validatePolicyInput(input: RecordedInput, five = false): void {
  const { tick, ...legacy } = input;
  void tick;
  validatePolicyRecordedInput(legacy, true, five);
  if (input.status === 'APPLIED' && input.kind !== 'turns.set' && input.tick !== undefined && input.tick !== null) {
    if ((input.result as { activeTick?: number }).activeTick !== input.tick)
      throw new Error('활동 tick이 처리 tick과 다릅니다.');
  }
}

export const emptyTurns = (): QueuedTurn[] => Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} }));

export function applyTurnsInput(replay: ReplayState, input: RecordedInput): ReplayState {
  if (replay.policy) validatePolicyInput(input, replay.state.ruleFeatures?.includes('five-stats'));
  const next = structuredClone(replay);
  const payload = input.payload as { turns?: QueuedTurn[]; revision?: number };
  const result = input.result as { revision?: number };
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
    next.policy.lastActiveTicks[id] = Math.max(
      next.policy.lastActiveTicks[id]!,
      (input.result as { activeTick: number }).activeTick,
    );
  return next;
}

export function applyCreationInput(replay: ReplayState, input: RecordedInput): ReplayState {
  if (replay.policy) validatePolicyInput(input, replay.state.ruleFeatures?.includes('five-stats'));
  const next = structuredClone(replay);
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
  const five = next.state.ruleFeatures?.includes('five-stats') ?? false;
  assertGeneralStatProfile(general, five);
  if (five) {
    const creation = validateGeneralCreation(input.payload, FIVE_STAT_RULES);
    if (!creation.ok || FIVE_STAT_KEYS.some((key) => creation.value[key] !== general[key]))
      throw new Error('5능력치 생성 입력과 결과가 다릅니다.');
  }
  next.state.generals[general.id] = structuredClone(general);
  next.turns[general.id] = next.policy ? emptyQueue() : emptyTurns();
  next.revisions[general.id] = 0;
  if (next.policy) {
    if (typeof general.userId !== 'string') throw new Error('생성한 사람 장수의 사용자가 없습니다.');
    next.policy.policies[general.id] = 'none';
    next.policy.lastActiveTicks[general.id] = (input.result as { activeTick: number }).activeTick;
  }
  return next;
}

export function applyPolicyInput(replay: ReplayState, input: RecordedInput): ReplayState {
  validatePolicyInput(input, replay.state.ruleFeatures?.includes('five-stats'));
  const next = structuredClone(replay);
  const id = input.generalId;
  if (!next.policy || id === null || !next.state.generals[id] || next.state.generals[id]!.userId === null)
    throw new Error('활동 입력의 사람 장수가 없습니다.');
  const result = input.result as { activeTick: number; policy?: import('./policy').PolicyKey };
  if (input.kind === 'general.setPolicy') next.policy.policies[id] = result.policy!;
  next.policy.lastActiveTicks[id] = Math.max(next.policy.lastActiveTicks[id]!, result.activeTick);
  return next;
}
