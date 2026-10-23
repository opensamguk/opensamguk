import { rngFor } from '@opensamguk/shared';
import { hashState } from '@opensamguk/shared/node';
import {
  monthlyDate,
  runGeneralTurn,
  runMonthly,
  TICKS_PER_MONTH,
  toWorldState,
  unifiedNation,
  seasonOutcome,
  type WorldInit,
} from '@opensamguk/rules';

export const DEFAULT_SIMULATION_MAX_YEAR = 300;

export { unifiedNation } from '@opensamguk/rules';

export function simulateGame(
  initial: WorldInit,
  options: { maxYear?: number; convergence?: boolean; onYear?: (year: number, turns: number) => void } = {},
) {
  const maxYear = options.maxYear ?? DEFAULT_SIMULATION_MAX_YEAR;
  if (!Number.isSafeInteger(maxYear) || maxYear < initial.startYear || maxYear > 10000)
    throw new Error('종료 연도는 시작 연도 이상, 10000 이하여야 합니다.');
  if (initial.generals.some((general) => general.userId !== null))
    throw new Error('시뮬레이터는 NPC 전용 월드만 실행합니다.');
  const started = performance.now();
  let state = toWorldState(initial);
  let turns = 0;
  let date = { year: initial.startYear, month: 1 };
  let winner = unifiedNation(state);
  const commandCounts: Record<string, number> = {};
  const nationCommandCounts: Record<string, number> = {};
  // 장수는 달마다 한 번 실행한다. 월간 정산의 미등장 장수 offset 갱신도 그대로 적용한다.
  for (let boundary = TICKS_PER_MONTH; winner === null; boundary += TICKS_PER_MONTH) {
    date = monthlyDate(initial.startYear, boundary);
    const due = Object.values(state.generals)
      .filter((g) => g.activeFromYear <= date.year && g.nextTurnTick < boundary)
      .sort((a, b) => a.nextTurnTick - b.nextTurnTick || a.id - b.id);
    for (const general of due) {
      const tick = state.generals[general.id]!.nextTurnTick;
      const turn = runGeneralTurn(
        state,
        { generalId: general.id, tick, unitSet: initial.unitSet },
        { commandKey: 'rest', args: {} },
        initial.seed,
        { convergence: options.convergence ?? true },
      );
      if ('code' in turn.result)
        throw new Error(`시드 ${initial.seed}, tick ${tick}, 장수 ${general.id}: ${turn.result.code}`);
      if (turn.nation && 'code' in turn.nation.result)
        throw new Error(`시드 ${initial.seed}, 국가 명령: ${turn.nation.result.code}`);
      state = turn.state;
      state.generals[general.id]!.nextTurnTick = tick + TICKS_PER_MONTH;
      turns++;
      commandCounts[turn.commandKey] = (commandCounts[turn.commandKey] ?? 0) + 1;
      if (turn.nation)
        nationCommandCounts[turn.nation.commandKey] = (nationCommandCounts[turn.nation.commandKey] ?? 0) + 1;
      winner = seasonOutcome(state, { endYear: maxYear })?.winnerNationId ?? null;
      if (winner !== null) break;
    }
    if (winner !== null) break;
    state = runMonthly(state, boundary, rngFor(initial.seed, 'monthly', date.year, date.month)).state;
    if (date.month === 12) options.onYear?.(date.year, turns);
    const outcome = seasonOutcome(state, { endYear: maxYear, settled: date });
    winner = outcome?.winnerNationId ?? null;
    if (outcome) break;
  }
  const stateHash = hashState(state);
  return {
    seed: initial.seed,
    scenario: initial.scenarioKey,
    cities: initial.cities.length,
    generals: initial.generals.length,
    convergence: options.convergence ?? true,
    maxYear,
    outcome: winner === null ? '종료연도' : '통일',
    finalYear: date.year,
    finalMonth: date.month,
    winner: winner === null ? null : { id: winner, name: state.nations[winner]!.name },
    remainingNations: Object.keys(state.nations).length,
    turns,
    seconds: (performance.now() - started) / 1000,
    stateHash,
    commandCounts,
    nationCommandCounts,
  };
}
