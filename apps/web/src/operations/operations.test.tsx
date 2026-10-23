// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOps, SLOT_COUNT, toSaveSlots, type Turn } from '../turns/draft';
import type { GameDate, InspectionRow, MemberTimeline, SlotView, Suggestion, TimelineCell } from './contract';
import { InspectionTable, officerName } from './InspectionPage';
import { beyondNote, cellFor, suggestionDiff, suggestionOps, VERDICT_VIEW, visibleMonths } from './timeline';

afterEach(cleanup);

const rest: SlotView = { commandKey: 'rest', args: {}, name: '휴식' };
const slot = (commandKey: string, name: string, args: Record<string, unknown> = {}): SlotView => ({
  commandKey,
  args,
  name,
});
const date = (year: number, month: number): GameDate => ({ year, month });
const plus = (start: GameDate, n: number): GameDate => {
  const index = start.year * 12 + start.month - 1 + n;
  return date(Math.floor(index / 12), (index % 12) + 1);
};
const cell = (i: number, start: GameDate, turn: SlotView = rest): TimelineCell => ({
  slot: i,
  tick: 10_000 * i,
  at: null,
  date: plus(start, i),
  turn,
});
const member = (patch: Partial<MemberTimeline> = {}): MemberTimeline => ({
  generalId: 1,
  name: '조운',
  cityKey: 3,
  cityName: '진류',
  isMe: false,
  verdict: 'READY',
  beyondWindow: false,
  sortie: null,
  expected: { crew: 3000, train: 80, atmos: 80 },
  cells: Array.from({ length: SLOT_COUNT }, (_, i) => cell(i, date(191, 12))),
  ...patch,
});

describe('작전 타임라인', () => {
  // 191년 8월부터 192년 5월까지. 목표 192년 4월의 다음 달까지가 열 머리다.
  const months = Array.from({ length: 10 }, (_, i) => plus(date(191, 8), i));

  it('목표 전 6개월부터 보여 주고 더 보기면 모든 열', () => {
    const target = date(192, 4);
    const visible = visibleMonths(months, target, false);
    expect(visible[0]).toEqual(date(191, 10));
    expect(visible.at(-1)).toEqual(date(192, 5));
    expect(visibleMonths(months, target, true)).toHaveLength(months.length);
  });

  it('월마다 그 달에 실행되는 칸을 찾는다', () => {
    const m = member();
    expect(cellFor(m, date(192, 2))?.slot).toBe(2);
    expect(cellFor(m, date(190, 1))).toBeUndefined();
  });

  it('출병이 마지막 열보다 늦으면 그 칸 연월을 붙이고, 30칸 밖이면 판정할 수 없다고 적는다', () => {
    const sortie = cell(7, date(191, 12), slot('attack', '출병', { cityKey: 5 }));
    expect(beyondNote(member({ verdict: 'LATE', sortie }), [date(192, 5), date(192, 6)])).toBe('출병(192.7)');
    expect(beyondNote(member({ verdict: 'READY', sortie }), [date(192, 7), date(192, 8)])).toBeNull();
    expect(beyondNote(member({ beyondWindow: true, verdict: 'MISSING' }), [date(192, 5)])).toContain(
      '아직 판정할 수 없습니다',
    );
  });

  it('판정 4종은 아이콘과 글자가 모두 다르다', () => {
    const views = Object.values(VERDICT_VIEW);
    expect(new Set(views.map((v) => v.icon)).size).toBe(4);
    expect(views.map((v) => v.text)).toEqual(['준비됨', '미흡', '늦음', '없음']);
  });
});

describe('작전에 맞추기', () => {
  const current = Array.from({ length: SLOT_COUNT }, () => rest);
  current[0] = slot('train', '훈련');
  const suggested = [...current];
  suggested[1] = slot('recruit', '모병', { amount: 1200, crewType: 1 });
  suggested[4] = slot('attack', '출병', { cityKey: 12 });
  const suggestion: Suggestion = {
    revision: 7,
    current,
    slots: suggested,
    changed: [1, 4],
    warnings: [{ slot: 4, reason: '병력이 없습니다.' }],
  };

  it('바뀌는 칸만 put으로 넣고 표시 이름은 버린다', () => {
    expect(suggestionOps(suggestion)).toEqual([
      { put: { indices: [1], turn: { commandKey: 'recruit', args: { amount: 1200, crewType: 1 } } } },
      { put: { indices: [4], turn: { commandKey: 'attack', args: { cityKey: 12 } } } },
    ]);
  });

  it('고치던 초안 위에 넣으면 작전 밖 칸과 다른 편집은 그대로이고 저장 입력은 메인 편집기와 같다', () => {
    const draft: Turn[] = current.map((s) => ({ commandKey: s.commandKey, args: { ...(s.args as object) } }));
    draft[9] = { commandKey: 'farm', args: {} };
    const next = applyOps(draft, suggestionOps(suggestion));
    expect(next[0]).toEqual({ commandKey: 'train', args: {} });
    expect(next[9]).toEqual({ commandKey: 'farm', args: {} });
    expect(next[4]).toEqual({ commandKey: 'attack', args: { cityKey: 12 } });
    const saved = toSaveSlots(next);
    expect(saved[2]).toBeNull();
    expect(saved[4]).toEqual({ commandKey: 'attack', args: { cityKey: 12 } });
    expect(saved.every((s) => s === null || !('name' in s))).toBe(true);
  });

  it('미리보기는 칸마다 지금과 제안과 경고를 나란히 둔다', () => {
    expect(suggestionDiff(suggestion)).toEqual([
      { slot: 1, before: rest, after: suggested[1], warning: null },
      { slot: 4, before: rest, after: suggested[4], warning: '병력이 없습니다.' },
    ]);
  });
});

describe('감찰 표', () => {
  const row = (patch: Partial<InspectionRow>): InspectionRow => ({
    generalId: 1,
    name: '관우',
    officerLevel: 11,
    cityKey: 3,
    cityName: '진류',
    isHuman: true,
    crew: 1200,
    train: 70,
    atmos: 60,
    turns: [slot('train', '훈련'), rest, rest, slot('attack', '출병'), rest],
    nextTurnAt: null,
    lastActiveAt: null,
    idle: false,
    ...patch,
  });

  it('직책 이름은 T2-05 표를 따른다', () => {
    expect([12, 11, 10, 5, 4, 0].map(officerName)).toEqual(['군주', '참모', '수뇌', '수뇌', '일반', '일반']);
  });

  it('오래 접속 안 한 장수는 글자와 함께 강조하고 NPC를 표시한다', () => {
    render(
      <InspectionTable
        rows={[
          row({}),
          row({ generalId: 2, name: '장비', idle: true }),
          row({ generalId: 3, name: '전위', isHuman: false }),
        ]}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(rows[1]!.textContent).toContain('훈련 → · → · → 출병 → ·');
    expect(rows[2]!.getAttribute('data-idle')).toBe('true');
    expect(rows[2]!.textContent).toContain('오래 접속 안 함');
    expect(rows[3]!.textContent).toContain('NPC');
  });
});
