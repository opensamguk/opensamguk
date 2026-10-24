import type { InitialGeneral } from './world/bootstrap';
import type { QueuedTurn, RecordedInput, ReplayState } from './replay';

export const emptyTurns = (): QueuedTurn[] => Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} }));

export function applyTurnsInput(replay: ReplayState, input: RecordedInput): ReplayState {
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
  return next;
}

export function applyCreationInput(replay: ReplayState, input: RecordedInput): ReplayState {
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
  next.state.generals[general.id] = structuredClone(general);
  next.turns[general.id] = emptyTurns();
  next.revisions[general.id] = 0;
  return next;
}
