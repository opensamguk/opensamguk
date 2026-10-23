// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArgNames } from '../turns/args';
import { applyOps, SLOT_COUNT, toSaveSlots, toTurn, type Turn } from '../turns/draft';
import type { GameDate, InspectionRow, MemberTimeline, SlotView, Suggestion, TimelineCell } from './contract';
import { InspectionTable, officerName } from './InspectionPage';
import { MemberRow } from './OperationDetailPage';
import {
  beyondNote,
  cellFor,
  outsideWarnings,
  slotLabel,
  suggestionDiff,
  suggestionOps,
  VERDICT_VIEW,
  visibleMonths,
} from './timeline';

afterEach(cleanup);

// AppRouter 출력 모양의 고정값. 계약 타입에 맞춘 가짜 응답이라 실제 API 증거가 아니다.
const blank: SlotView = { commandKey: 'rest', args: {}, explicit: false, name: '휴식' };
const rest: SlotView = { commandKey: 'rest', args: {}, explicit: true, name: '휴식' };
const slot = (commandKey: string, name: string, args: Record<string, unknown> = {}): SlotView => ({
  commandKey,
  args,
  explicit: true,
  name,
});
const names: ArgNames = { city: (k) => (k === 12 ? '복양' : undefined), nation: () => undefined };
const date = (year: number, month: number): GameDate => ({ year, month });
const plus = (start: GameDate, n: number): GameDate => {
  const index = start.year * 12 + start.month - 1 + n;
  return date(Math.floor(index / 12), (index % 12) + 1);
};
const cell = (i: number, start: GameDate, turn: SlotView = blank): TimelineCell => ({
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

  it('목표가 30칸 밖이라 서버 열이 목표보다 일찍 끝나도 기본 열이 비지 않는다', () => {
    const visible = visibleMonths(months, date(195, 1), false);
    expect(visible[0]).toEqual(date(191, 11));
    expect(visible.at(-1)).toEqual(date(192, 5));
    expect(visibleMonths([], date(195, 1), false)).toEqual([]);
  });

  it('월마다 그 달에 실행되는 칸을 찾는다', () => {
    const m = member();
    expect(cellFor(m, date(192, 2))?.slot).toBe(2);
    expect(cellFor(m, date(190, 1))).toBeUndefined();
  });

  it('출병이 마지막 열보다 늦으면 인자와 연월을 붙이고, 30칸 밖이면 판정할 수 없다고 적는다', () => {
    const sortie = cell(7, date(191, 12), slot('attack', '출병', { cityKey: 12 }));
    expect(beyondNote(member({ verdict: 'LATE', sortie }), [date(192, 5), date(192, 6)], names)).toBe(
      '출병 복양(192.7)',
    );
    expect(beyondNote(member({ verdict: 'READY', sortie }), [date(192, 7), date(192, 8)], names)).toBeNull();
    // 열이 없어도 출병 칸 연월은 남긴다.
    expect(beyondNote(member({ verdict: 'LATE', sortie }), [], names)).toBe('출병 복양(192.7)');
    expect(beyondNote(member({ beyondWindow: true, verdict: 'MISSING' }), [date(192, 5)], names)).toContain(
      '아직 판정할 수 없습니다',
    );
  });

  it('판정 4종은 아이콘과 글자가 모두 다르다', () => {
    const views = Object.values(VERDICT_VIEW);
    expect(new Set(views.map((v) => v.icon)).size).toBe(4);
    expect(views.map((v) => v.text)).toEqual(['준비됨', '미흡', '늦음', '없음']);
  });

  it('비워 둔 칸, 직접 넣은 휴식, 인자가 있는 명령을 글자로 나눈다', () => {
    expect(slotLabel(blank, names)).toEqual({ kind: 'empty', text: '빈 칸' });
    expect(slotLabel(rest, names)).toEqual({ kind: 'rest', text: '휴식' });
    expect(slotLabel(slot('attack', '출병', { cityKey: 12 }), names)).toEqual({ kind: 'command', text: '출병 복양' });
    expect(slotLabel(slot('recruit', '모병', { amount: 1200 }), names).text).toBe('모병 수량 1200');
  });

  it('다른 참여자 줄도 명령과 인자를 보이고 시각이 없으면 다음 턴을 게임 연월로 적는다', () => {
    const cells = member().cells.map((c, i) =>
      i === 1 ? { ...c, turn: rest } : i === 2 ? { ...c, turn: slot('attack', '출병', { cityKey: 12 }) } : c,
    );
    render(
      <table>
        <tbody>
          <MemberRow
            member={member({ cells, sortie: cells[2]! })}
            months={[date(191, 12), date(192, 1), date(192, 2)]}
            target={date(192, 3)}
            min={{ crew: 3000, train: 80, atmos: 80 }}
            names={names}
          />
        </tbody>
      </table>,
    );
    const row = screen.getByRole('row');
    expect(row.textContent).toContain('다음 턴 191.12');
    const kinds = [...row.querySelectorAll('td[data-slot]')].map((td) => [
      td.getAttribute('data-kind'),
      td.textContent,
    ]);
    expect(kinds).toEqual([
      ['empty', '빈 칸'],
      ['rest', '휴식'],
      ['command', '출병 복양'],
    ]);
  });

  it('목표가 가까워 열이 짧아도 다른 참여자의 30칸 전부를 같은 줄에서 펼쳐 칸 번호·연월·명령과 인자로 본다', () => {
    const cells = member().cells.map((c, i) =>
      i === 1 ? { ...c, turn: rest } : i === 29 ? { ...c, turn: slot('recruit', '모병', { amount: 700 }) } : c,
    );
    render(
      <table>
        <tbody>
          <MemberRow
            member={member({ cells, isMe: false })}
            months={[date(191, 12), date(192, 1), date(192, 2)]}
            target={date(192, 1)}
            min={{ crew: 3000, train: 80, atmos: 80 }}
            names={names}
          />
        </tbody>
      </table>,
    );
    const row = screen.getByRole('row');
    // 처음에는 기존 표 그대로 서버 months 열만 있다.
    expect(row.querySelectorAll('td[data-slot]')).toHaveLength(3);
    expect(row.textContent).not.toContain('모병 수량 700');
    const toggle = screen.getByRole('button', { name: '조운의 예턴 30칸 모두 보기' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = within(row).getByRole('list', { name: '조운의 예턴 30칸' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(30);
    expect(items.map((li) => li.getAttribute('data-slot'))).toEqual(cells.map((c) => String(c.slot + 1)));
    expect(items[0]!.getAttribute('data-kind')).toBe('empty');
    expect(items[0]!.textContent).toContain('빈 칸');
    expect(items[1]!.getAttribute('data-kind')).toBe('rest');
    const last = items[29]!;
    expect(last.getAttribute('data-kind')).toBe('command');
    expect(last.textContent).toContain('30번 칸');
    expect(last.textContent).toContain('194.5');
    expect(last.textContent).toContain('모병 수량 700');
    // 펼쳐도 표 열은 그대로다. 다시 누르면 접는다.
    expect(row.querySelectorAll('td[data-slot]')).toHaveLength(3);
    fireEvent.click(toggle);
    expect(within(row).queryByRole('list')).toBeNull();
  });
});

describe('작전에 맞추기', () => {
  const current: SlotView[] = Array.from({ length: SLOT_COUNT }, () => blank);
  current[0] = slot('train', '훈련');
  const suggested = [...current];
  suggested[1] = slot('recruit', '모병', { amount: 1200, crewType: 1 });
  suggested[3] = rest;
  suggested[4] = slot('attack', '출병', { cityKey: 12 });
  const suggestion: Suggestion = {
    revision: 7,
    current,
    slots: suggested,
    changed: [1, 3, 4],
    warnings: [
      { slot: 0, code: 'SORTIE_MOVED', reason: '목표 도시 출병을 목표 전 마지막 칸으로 옮깁니다.' },
      { slot: 4, code: 'NO_CREW', reason: '병사가 없습니다.' },
      { slot: 4, code: 'NO_RICE', reason: '군량이 부족합니다.' },
    ],
    noop: null,
  };

  it('바뀌는 칸만 put으로 넣고 표시 이름은 버린다. 직접 넣은 휴식은 explicit 그대로다', () => {
    expect(suggestionOps(suggestion)).toEqual([
      { put: { indices: [1], turn: { commandKey: 'recruit', args: { amount: 1200, crewType: 1 }, explicit: true } } },
      { put: { indices: [3], turn: { commandKey: 'rest', args: {}, explicit: true } } },
      { put: { indices: [4], turn: { commandKey: 'attack', args: { cityKey: 12 }, explicit: true } } },
    ]);
    expect(
      suggestionOps({ ...suggestion, changed: [], noop: { code: 'NO_ROOM', reason: '칸이 부족합니다.' } }),
    ).toEqual([]);
  });

  it('고치던 초안 위에 넣으면 작전 밖 칸과 다른 편집은 그대로이고 저장 입력은 메인 편집기와 같다', () => {
    const draft: Turn[] = current.map(toTurn);
    draft[9] = { commandKey: 'farm', args: {}, explicit: true };
    const next = applyOps(draft, suggestionOps(suggestion));
    expect(next[0]).toEqual({ commandKey: 'train', args: {}, explicit: true });
    expect(next[9]).toEqual({ commandKey: 'farm', args: {}, explicit: true });
    expect(next[4]).toEqual({ commandKey: 'attack', args: { cityKey: 12 }, explicit: true });
    const saved = toSaveSlots(next);
    expect(saved[2]).toBeNull();
    expect(saved[3]).toEqual({ commandKey: 'rest', args: {} });
    expect(saved[4]).toEqual({ commandKey: 'attack', args: { cityKey: 12 } });
    expect(saved.every((s) => s === null || !('name' in s))).toBe(true);
  });

  it('미리보기는 칸마다 그 칸의 경고를 모두 붙이고 바뀌지 않는 칸의 경고는 따로 모은다', () => {
    expect(suggestionDiff(suggestion).map((row) => [row.slot, row.warnings.map((w) => w.code)])).toEqual([
      [1, []],
      [3, []],
      [4, ['NO_CREW', 'NO_RICE']],
    ]);
    expect(outsideWarnings(suggestion)).toEqual([suggestion.warnings[0]]);
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
    turns: [slot('train', '훈련'), blank, rest, slot('attack', '출병', { cityKey: 12 }), blank],
    nextTurnAt: null,
    lastActiveAt: null,
    idle: false,
    ...patch,
  });

  it('직책 이름은 T2-05 표를 따른다', () => {
    expect([12, 11, 10, 5, 4, 0].map(officerName)).toEqual(['군주', '참모', '수뇌', '수뇌', '일반', '일반']);
  });

  it('앞 5칸은 빈 칸과 직접 휴식을 나누고 인자를 붙이며 시각이 없으면 지어내지 않는다', () => {
    render(<InspectionTable rows={[row({})]} names={names} />);
    const tr = screen.getAllByRole('row')[1]!;
    const kinds = [...tr.querySelectorAll('li')].map((li) => [li.getAttribute('data-kind'), li.textContent]);
    expect(kinds).toEqual([
      ['command', '훈련'],
      ['empty', '빈 칸'],
      ['rest', '휴식'],
      ['command', '출병 복양'],
      ['empty', '빈 칸'],
    ]);
    expect(tr.textContent).toContain('시각 없음');
    expect(tr.textContent).toContain('기록 없음');
    expect(tr.getAttribute('data-idle')).toBe('false');
  });

  it('오래 접속 안 함은 서버 idle 값으로만 강조하고 NPC를 표시한다', () => {
    render(
      <InspectionTable
        rows={[
          row({ generalId: 2, name: '장비', idle: true, lastActiveAt: '2026-10-01T00:00:00.000Z' }),
          row({ generalId: 3, name: '전위', isHuman: false }),
        ]}
        names={names}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(rows[1]!.getAttribute('data-idle')).toBe('true');
    expect(rows[1]!.textContent).toContain('오래 접속 안 함');
    expect(rows[1]!.textContent).not.toContain('기록 없음');
    expect(rows[2]!.textContent).toContain('NPC');
    expect(rows[2]!.textContent).not.toContain('오래 접속 안 함');
  });
});
