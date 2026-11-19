import { BALANCE } from '../balance';
import { toGameDate } from '../clock/clock';
import { TICKS_PER_MONTH } from '../clock/constants';
import { campaignDrillArgs, campaignRecruitArgs } from '../campaign/preparation';
import { drillGain } from '../commands/statScores';
import type { WorldView, WorldState } from '../model/world';
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
  view?: WorldView;
  generalId?: number;
}

export interface OperationTimeline {
  cells: OperationCell[];
  sortie: OperationCell | null;
  expected: Readiness;
  verdict: OperationVerdict;
  beyondWindow: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 명령 인자만 검사한다. 자원·경로·보급과 방침 실행은 이 예상에 넣지 않는다.
function prepare(expected: Readiness, turn: QueuedTurn, context?: Pick<OperationTimelineInput, 'view' | 'generalId'>) {
  const recruiting = turn.commandKey === 'recruit' || turn.commandKey === 'conscript';
  if (!recruiting && turn.commandKey !== 'train' && turn.commandKey !== 'morale') return;
  const parsed = (recruiting ? campaignRecruitArgs : campaignDrillArgs).safeParse(turn.args);
  if (!parsed.success) return;
  if (recruiting && parsed.data.unitId === undefined) return;
  if (turn.commandKey === 'recruit' || turn.commandKey === 'conscript') {
    const amount = (parsed.data as { amount: number }).amount;
    const crew = expected.crew + amount;
    expected.train = Math.floor((expected.train * expected.crew) / crew);
    expected.atmos = Math.floor((expected.atmos * expected.crew) / crew);
    expected.crew = crew;
  } else if (turn.commandKey === 'train' || turn.commandKey === 'morale') {
    const morale = turn.commandKey === 'morale';
    const field = morale ? 'atmos' : 'train';
    const view = context?.view;
    const general = view?.generals[context?.generalId ?? -1];
    if (view && !general) throw new Error('작전 예상의 장수가 없습니다.');
    const gain = view && general ? drillGain(view, general, morale) : morale ? BALANCE.ATMOS_GAIN : BALANCE.TRAIN_GAIN;
    expected[field] = Math.min(100, expected[field] + gain);
  }
}

export { prepare as prepareOperationReadiness };

// 자원·경로 검사는 제외하되 부곡 선택과 지휘관별 훈련 증가량은 실제 명령과 같다.
export function operationPreparation(expected: Readiness, input: Pick<OperationTimelineInput, 'view' | 'generalId'>) {
  const view = input.view ? (structuredClone(input.view) as WorldState) : undefined;
  const campaign = view?.campaign;
  const owned = () => campaign?.units.filter((unit) => unit.ownerId === input.generalId) ?? [];
  const update = () => {
    const units = owned();
    expected.crew = units.reduce((sum, unit) => sum + unit.troops, 0);
    for (const field of ['train', 'atmos'] as const)
      expected[field] = expected.crew
        ? Math.floor(units.reduce((sum, unit) => sum + unit.troops * unit[field], 0) / expected.crew)
        : 0;
  };
  return {
    view,
    apply(turn: QueuedTurn) {
      if (!campaign || input.generalId === undefined) return prepare(expected, turn, input);
      const recruiting = turn.commandKey === 'recruit' || turn.commandKey === 'conscript';
      if (!recruiting && turn.commandKey !== 'train' && turn.commandKey !== 'morale') return;
      const parsed = (recruiting ? campaignRecruitArgs : campaignDrillArgs).safeParse(turn.args);
      if (!parsed.success || (recruiting && parsed.data.unitId === undefined)) return;
      const id = parsed.data.unitId;
      let unit = owned()
        .sort((a, b) => a.id - b.id)
        .find((row) => (id === undefined ? row.troops > 0 : row.id === id));
      if (recruiting) {
        const args = campaignRecruitArgs.parse(turn.args);
        if (id === 'new') {
          unit = {
            id: campaign.nextUnitId++,
            ownerId: input.generalId,
            commanderId: input.generalId,
            troops: 0,
            crewType: args.crewType,
            train: 0,
            atmos: 0,
          };
          campaign.units.push(unit);
        }
        if (!unit || (unit.troops > 0 && unit.crewType !== args.crewType)) return;
        for (const field of ['train', 'atmos'] as const)
          unit[field] = Math.floor((unit[field] * unit.troops) / (unit.troops + args.amount));
        unit.troops += args.amount;
      } else {
        if (!unit || unit.troops <= 0) return;
        const commander = view!.generals[unit.commanderId];
        if (!commander) throw Error('작전 예상의 지휘관이 없습니다.');
        const field = turn.commandKey === 'morale' ? 'atmos' : 'train';
        unit[field] = Math.min(100, unit[field] + drillGain(view!, commander, field === 'atmos'));
      }
      update();
    },
  };
}

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
  const preparation = operationPreparation(expected, input);
  for (const cell of cells) {
    if (cell === sortie) break;
    preparation.apply(cell.turn);
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
