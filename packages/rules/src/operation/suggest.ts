import { commandRegistry } from '../commands/registry';
import type { Actor } from '../commands/types';
import { sameSlot, type PolicySlot } from '../policy';
import { calculateOperationForecast, type OperationForecastInput } from './forecast';
import { prepareOperationReadiness, type Readiness } from './timeline';

export type OperationNoopCode = 'NO_SLOT' | 'BEYOND_WINDOW' | 'NO_ROOM' | 'UNREACHABLE';
export interface OperationWarning {
  slot: number;
  code: string;
  reason: string;
}
export interface OperationSuggestion {
  slots: PolicySlot[];
  changed: number[];
  warnings: OperationWarning[];
  noop: { code: OperationNoopCode; reason: string } | null;
}
export interface OperationSuggestionInput extends OperationForecastInput {
  crewType: number;
  actor: Actor;
}

const directRest = (): PolicySlot => ({ commandKey: 'rest', args: {}, explicit: true });
const direct = (commandKey: string, args: unknown = {}): PolicySlot => ({ commandKey, args, explicit: true });
const isTarget = (turn: PolicySlot, cityKey: number) =>
  turn.commandKey === 'attack' &&
  turn.args !== null &&
  typeof turn.args === 'object' &&
  !Array.isArray(turn.args) &&
  (turn.args as Record<string, unknown>).cityKey === cityKey;

export function suggestOperationTurns(input: OperationSuggestionInput): OperationSuggestion {
  const current = structuredClone([...input.turns]);
  const noop = (code: OperationNoopCode, reason: string): OperationSuggestion => ({
    slots: structuredClone(current),
    changed: [],
    warnings: [],
    noop: { code, reason },
  });
  const timeline = calculateOperationForecast(input);
  if (timeline.cells[0]!.tick >= input.deadlineTick) return noop('NO_SLOT', '목표 전에 실행할 예턴 칸이 없습니다.');
  if (timeline.beyondWindow) return noop('BEYOND_WINDOW', '목표가 지금 예턴 30칸 밖에 있습니다.');
  if (input.min.train > 100 || input.min.atmos > 100)
    return noop('UNREACHABLE', '훈련과 사기 기준에 도달할 수 없습니다.');
  const k = timeline.cells.findLast((cell) => cell.tick < input.deadlineTick)!.slot;
  const cleaned = structuredClone(current);
  const moved: number[] = [];
  for (let i = 0; i < k; i++) {
    if (isTarget(cleaned[i]!, input.targetCityKey)) {
      cleaned[i] = directRest();
      moved.push(i);
    }
  }
  let invalidRecruit = false;
  for (let p = 0; p <= k; p++) {
    const s = k - p;
    const prefix = cleaned.map((turn, i) => (i < s ? turn : directRest()));
    const expected: Readiness = { ...calculateOperationForecast({ ...input, turns: prefix }).expected };
    const preparations: PolicySlot[] = [];
    const add = (turn: PolicySlot) => {
      preparations.push(turn);
      prepareOperationReadiness(expected, turn);
    };
    if (expected.crew < input.min.crew) {
      const turn = direct('recruit', { amount: input.min.crew - expected.crew, crewType: input.crewType });
      if (!commandRegistry.get('recruit')!.args.safeParse(turn.args).success) {
        invalidRecruit = true;
        continue;
      }
      add(turn);
    }
    while (expected.train < input.min.train && preparations.length <= p) add(direct('train'));
    while (expected.atmos < input.min.atmos && preparations.length <= p) add(direct('morale'));
    if (preparations.length > p) continue;
    const slots = structuredClone(cleaned);
    for (let i = s; i < k; i++) slots[i] = directRest();
    preparations.forEach((turn, i) => {
      slots[k - preparations.length + i] = turn;
    });
    slots[k] = direct('attack', { cityKey: input.targetCityKey });
    const check = calculateOperationForecast({ ...input, turns: slots });
    if (check.verdict !== 'READY' || check.sortie?.slot !== k) throw new Error('작전 제안의 예상값을 확인하세요.');
    const changed = slots.flatMap((turn, i) => (sameSlot(current[i]!, turn) ? [] : [i]));
    const warnings: OperationWarning[] = moved
      .filter((slot) => slot < s)
      .map((slot) => ({
        slot,
        code: 'SORTIE_MOVED',
        reason: '목표 도시 출병을 목표 전 마지막 칸으로 옮깁니다.',
      }));
    for (const slot of changed) {
      const turn = slots[slot]!;
      if (turn.commandKey === 'rest') continue;
      const failure = commandRegistry.get(turn.commandKey)!.check(input.view, input.actor, turn.args);
      if (failure) warnings.push({ slot, code: failure.code, reason: failure.message });
    }
    warnings.sort((a, b) => a.slot - b.slot);
    return { slots, changed, warnings, noop: null };
  }
  return invalidRecruit
    ? noop('UNREACHABLE', '지금 병종과 모병 인자로 기준 병력을 채울 수 없습니다.')
    : noop('NO_ROOM', '목표 전에 준비 명령을 넣을 칸이 부족합니다.');
}
