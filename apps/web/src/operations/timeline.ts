import type { TagTone } from '../ui/Tag';
import { toTurn, type EditOp } from '../turns/draft';
import type { GameDate, MemberTimeline, SlotView, Suggestion, TimelineCell, Verdict } from './contract';

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

// 목표 전 6개월만 먼저 보여 준다. 열 머리는 서버가 이번 달부터 목표 다음 달까지 준다.
export const DEFAULT_MONTHS_BEFORE = 6;
export function visibleMonths(months: readonly GameDate[], target: GameDate, expanded: boolean): GameDate[] {
  if (expanded) return [...months];
  const from = monthIndex(target) - DEFAULT_MONTHS_BEFORE;
  return months.filter((m) => monthIndex(m) >= from);
}

export function cellFor(member: MemberTimeline, month: GameDate): TimelineCell | undefined {
  return member.cells.find((cell) => sameMonth(cell.date, month));
}

// 출병이 마지막 열보다 늦으면 그 칸의 연월을 열 밖에 붙여 늦음으로 보인다. 30칸 밖이면 아직 판정할 수 없다고 적는다.
export function beyondNote(member: MemberTimeline, months: readonly GameDate[]): string | null {
  if (member.beyondWindow) return '예턴 30칸이 목표에 닿지 않아 아직 판정할 수 없습니다';
  const last = months.at(-1);
  if (member.sortie && last && monthIndex(member.sortie.date) > monthIndex(last))
    return `${member.sortie.turn.name}(${shortDate(member.sortie.date)})`;
  return null;
}

// 제안을 메인 초안에 넣는 편집. changed 칸마다 그 칸 하나를 put으로 넣는다. STALE 뒤 다시 적용해도 같은 편집이 된다.
export function suggestionOps(suggestion: Suggestion): EditOp[] {
  return suggestion.changed
    .filter((slot) => suggestion.slots[slot] !== undefined)
    .map((slot) => ({ put: { indices: [slot], turn: toTurn(suggestion.slots[slot]!) } }));
}

const REST_VIEW: SlotView = { commandKey: 'rest', args: {}, name: '휴식' };

export interface DiffRow {
  slot: number;
  before: SlotView;
  after: SlotView;
  warning: string | null;
}

// 바뀌는 칸 미리보기. 지금과 뒤를 나란히 둔다.
export function suggestionDiff(suggestion: Suggestion): DiffRow[] {
  return suggestion.changed.map((slot) => ({
    slot,
    before: suggestion.current[slot] ?? REST_VIEW,
    after: suggestion.slots[slot] ?? REST_VIEW,
    warning: suggestion.warnings.find((w) => w.slot === slot)?.reason ?? null,
  }));
}
