import type { TagTone } from '../ui/Tag';
import { describeArgs, type ArgNames } from '../turns/args';
import { toTurn, type EditOp } from '../turns/draft';
import type {
  GameDate,
  MemberTimeline,
  SlotView,
  Suggestion,
  SuggestionWarning,
  TimelineCell,
  Verdict,
} from './contract';

// 작전 타임라인의 순수 계산 (T2-12). 판정은 서버가 tick으로 한 값(verdict·sortie·beyondWindow)만 쓴다.

export const monthIndex = (date: GameDate) => date.year * 12 + (date.month - 1);
export const sameMonth = (a: GameDate, b: GameDate) => monthIndex(a) === monthIndex(b);
export const shortDate = (date: GameDate) => `${date.year}.${date.month}`;

// 판정은 아이콘·글자·색을 함께 쓴다. 색만으로 구분하지 않는다. 모두 예턴만 본 예상이다.
export const VERDICT_VIEW: Record<Verdict, { icon: string; text: string; tone: TagTone }> = {
  READY: { icon: '○', text: '준비됨', tone: 'accent' },
  WEAK: { icon: '△', text: '미흡', tone: 'warning' },
  LATE: { icon: '!', text: '늦음', tone: 'danger' },
  MISSING: { icon: '✕', text: '없음', tone: 'muted' },
};

// 기준 달 전 6개월만 먼저 보여 준다. 열 머리는 서버가 이번 달부터 준 순서 그대로다.
// 목표가 30칸 밖이면 서버 months가 목표보다 일찍 끝난다. 기준 달은 목표와 months 마지막 달 중 이른 쪽이다.
export const DEFAULT_MONTHS_BEFORE = 6;
export function visibleMonths(months: readonly GameDate[], target: GameDate, expanded: boolean): GameDate[] {
  const last = months.at(-1);
  if (expanded || !last) return [...months];
  const anchor = Math.min(monthIndex(target), monthIndex(last));
  return months.filter((m) => monthIndex(m) >= anchor - DEFAULT_MONTHS_BEFORE);
}

export function cellFor(member: MemberTimeline, month: GameDate): TimelineCell | undefined {
  return member.cells.find((cell) => sameMonth(cell.date, month));
}

// 칸 한 개의 표시. 비워 둔 칸(explicit false)과 직접 넣은 휴식을 글자로 나눈다.
// 비워 둔 칸이 실행할 방침 명령은 그 장수의 방침이라 여기서 짐작하지 않는다.
export type SlotLabel = { kind: 'empty' | 'rest' | 'command'; text: string };
export const EMPTY_SLOT_TEXT = '빈 칸';
export const EMPTY_SLOT_TITLE = '비워 둔 칸입니다. 그 장수의 기본 방침대로 실행합니다.';
export function slotLabel(slot: SlotView, names: ArgNames): SlotLabel {
  if (!slot.explicit) return { kind: 'empty', text: EMPTY_SLOT_TEXT };
  const args = describeArgs(toTurn(slot).args, names);
  const text = args ? `${slot.name} ${args}` : slot.name;
  return { kind: slot.commandKey === 'rest' ? 'rest' : 'command', text };
}

// 출병이 마지막 열보다 늦으면 그 칸의 연월을 열 밖에 붙여 늦음으로 보인다. 30칸 밖이면 아직 판정할 수 없다고 적는다.
export function beyondNote(member: MemberTimeline, months: readonly GameDate[], names: ArgNames): string | null {
  if (member.beyondWindow) return '예턴 30칸이 목표에 닿지 않아 아직 판정할 수 없습니다';
  const last = months.at(-1);
  if (member.sortie && (!last || monthIndex(member.sortie.date) > monthIndex(last)))
    return `${slotLabel(member.sortie.turn, names).text}(${shortDate(member.sortie.date)})`;
  return null;
}

// 제안을 메인 초안에 넣는 편집. changed 칸마다 그 칸 하나를 put으로 넣는다. STALE 뒤 다시 적용해도 같은 편집이 된다.
// noop이면 서버가 changed를 비워 보내므로 넣을 편집도 없다.
export function suggestionOps(suggestion: Suggestion): EditOp[] {
  if (suggestion.noop !== null) return [];
  return suggestion.changed.flatMap((slot) => {
    const turn = suggestion.slots[slot];
    return turn ? [{ put: { indices: [slot], turn: toTurn(turn) } }] : [];
  });
}

export interface DiffRow {
  slot: number;
  before: SlotView;
  after: SlotView;
  warnings: SuggestionWarning[];
}

// 바뀌는 칸 미리보기. 지금과 뒤를 나란히 두고 그 칸의 경고를 모두 붙인다. 서버가 칸을 주지 않은 번호는 뺀다.
export function suggestionDiff(suggestion: Suggestion): DiffRow[] {
  return suggestion.changed.flatMap((slot) => {
    const before = suggestion.current[slot];
    const after = suggestion.slots[slot];
    if (!before || !after) return [];
    return [{ slot, before, after, warnings: suggestion.warnings.filter((w) => w.slot === slot) }];
  });
}

// 바뀌는 칸 행에 없는 칸의 경고. 서버 순서 그대로 둔다.
export function outsideWarnings(suggestion: Suggestion): SuggestionWarning[] {
  const shown = new Set(suggestionDiff(suggestion).map((row) => row.slot));
  return suggestion.warnings.filter((w) => !shown.has(w.slot));
}
