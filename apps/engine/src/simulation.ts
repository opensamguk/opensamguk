import { applySexLedger } from '@opensamguk/rules';
import { loadSexLedger } from './world/resources';
import { hashState } from '@opensamguk/shared/node';
import {
  monthlyDate,
  toGameDate,
  initialReplayState,
  runSimulationAction,
  nextGameAction,
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
  const normalized = {
    ...initial,
    generals: initial.generals.every((general) => general.sex !== undefined)
      ? structuredClone(initial.generals)
      : applySexLedger(initial, loadSexLedger()),
  };
  let replay = initialReplayState(normalized);
  let state = replay.state;
  let turns = 0;
  let date = { year: initial.startYear, month: 1 };
  let winner = unifiedNation(state);
  const commandCounts: Record<string, number> = {};
  const nationCommandCounts: Record<string, number> = {};
  while (winner === null) {
    const action = nextGameAction(replay);
    const result = runSimulationAction(replay, initial.seed, initial.unitSet, options.convergence ?? true);
    replay = result.replay;
    state = replay.state;
    date =
      action.kind === 'monthly'
        ? monthlyDate(initial.startYear, action.tick)
        : toGameDate(initial.startYear, action.tick);
    if (result.commandKey) {
      turns++;
      commandCounts[result.commandKey] = (commandCounts[result.commandKey] ?? 0) + 1;
      if (result.nationCommandKey)
        nationCommandCounts[result.nationCommandKey] = (nationCommandCounts[result.nationCommandKey] ?? 0) + 1;
    }
    if (action.kind === 'monthly' && date.month === 12) options.onYear?.(date.year, turns);
    const outcome = seasonOutcome(state, { endYear: maxYear, ...(action.kind === 'monthly' ? { settled: date } : {}) });
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
