import { BALANCE } from '../balance';
import { toGameDate } from '../clock/clock';
import { TICKS_PER_MONTH } from '../clock/constants';
import { militaryCommands } from '../commands/military';
import type { QueuedTurn } from '../replay';

export interface Readiness {
  crew: number;
  train: number;
  atmos: number;
}

export type OperationVerdict = 'READY' | 'WEAK' | 'LATE' | 'MISSING';

export interface OperationCell {
  slot: number;
  tick: number;
  date: ReturnType<typeof toGameDate>;
  turn: QueuedTurn;
}

export interface OperationTimelineInput {
  startYear: number;
  nextTurnTick: number;
  deadlineTick: number;
  targetCityKey: number;
  current: Readonly<Readiness>;
  min: Readonly<Readiness>;
  turns: readonly (QueuedTurn | null)[];
}

export interface OperationTimeline {
  cells: OperationCell[];
  sortie: OperationCell | null;
  expected: Readiness;
  verdict: OperationVerdict;
  beyondWindow: boolean;
}

const preparationCommands = new Map(
  militaryCommands
    .filter(({ key }) => ['recruit', 'conscript', 'train', 'morale'].includes(key))
    .map((command) => [command.key, command]),
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 명령 인자만 검사한다. 자원·경로·보급과 방침 실행은 이 예상에 넣지 않는다.
function prepare(expected: Readiness, turn: QueuedTurn) {
  const command = preparationCommands.get(turn.commandKey);
  if (!command) return;
  const parsed = command.args.safeParse(turn.args);
  if (!parsed.success) return;
  if (turn.commandKey === 'recruit' || turn.commandKey === 'conscript') {
    const amount = (parsed.data as { amount: number }).amount;
    const crew = expected.crew + amount;
    expected.train = Math.floor((expected.train * expected.crew) / crew);
    expected.atmos = Math.floor((expected.atmos * expected.crew) / crew);
    expected.crew = crew;
  } else if (turn.commandKey === 'train') {
    expected.train = Math.min(100, expected.train + BALANCE.TRAIN_GAIN);
  } else if (turn.commandKey === 'morale') {
    expected.atmos = Math.min(100, expected.atmos + BALANCE.ATMOS_GAIN);
  }
}

export { prepare as prepareOperationReadiness };

export function calculateOperationTimeline(input: OperationTimelineInput): OperationTimeline {
  if (input.turns.length !== 30) throw new Error('예턴은 30칸이어야 합니다.');
  if (!Number.isSafeInteger(input.deadlineTick) || input.deadlineTick < 0)
    throw new Error('잘못된 작전 마감 tick입니다.');

  const cells = input.turns.map((turn, slot): OperationCell => {
    const tick = input.nextTurnTick + slot * TICKS_PER_MONTH;
    return {
      slot,
      tick,
      date: toGameDate(input.startYear, tick),
      turn: turn === null ? { commandKey: 'rest', args: {} } : structuredClone(turn),
    };
  });
  const sortie =
    cells.find(
      ({ turn }) => turn.commandKey === 'attack' && record(turn.args) && turn.args.cityKey === input.targetCityKey,
    ) ?? null;
  const expected = { ...input.current };
  for (const cell of cells) {
    if (cell === sortie) break;
    prepare(expected, cell.turn);
  }
  const ready =
    expected.crew >= input.min.crew && expected.train >= input.min.train && expected.atmos >= input.min.atmos;
  const verdict = sortie === null ? 'MISSING' : sortie.tick >= input.deadlineTick ? 'LATE' : ready ? 'READY' : 'WEAK';
  return {
    cells,
    sortie,
    expected,
    verdict,
    beyondWindow: cells[29]!.tick < input.deadlineTick,
  };
}
