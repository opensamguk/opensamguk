import { describe, expect, it } from 'vitest';
import { TICKS_PER_MONTH } from '../clock/constants';
import {
  chooseHistoricEvent,
  historicEventChoiceSchema,
  initialHistoricEvents,
  readHistoricEventsConfig,
  readHistoricEventsState,
  settleHistoricEvents,
  type HistoricEventsConfig,
} from './state';

const initial = {
  startYear: 191,
  nations: [
    { id: 1, name: '첫 국가' },
    { id: 2, name: '둘째 국가' },
  ],
};
const chooser = { nationId: 1, name: '첫 국가' };
const counterpart = { nationId: 2, name: '둘째 국가' };
function row(id: string, year: number, month: number): HistoricEventsConfig['events'][number] {
  return {
    id,
    year,
    month,
    chooser,
    counterpart,
    title: '시험 사건',
    text: '시험 사건 설명',
    options: [
      { label: '첫 선택', effects: [{ kind: 'gold', value: -1 }] },
      { label: '둘째 선택', effects: [{ kind: 'nonAggression', months: 2 }] },
    ],
    defaultOption: 0,
    ref: '시험 자료',
  };
}
const december = 12 * TICKS_PER_MONTH;
const january = 13 * TICKS_PER_MONTH;
const decemberEvents = readHistoricEventsConfig(initial, {
  events: [
    row('B', 191, 12),
    row('A', 191, 12),
    { ...row('D', 192, 1), chooser: counterpart, counterpart: chooser },
    { ...row('C', 192, 1), chooser: counterpart, counterpart: chooser },
  ],
  windowMonths: 1,
});
const context = (tick: number, nationExists: (id: number) => boolean = () => true) => ({
  startYear: initial.startYear,
  tick,
  nationExists,
});
const actor = { generalId: 9, nationId: 1 };

describe('T4-43 AC-P2-21 역사 사건의 공통 규칙', () => {
  it('생성 국가, 중복 ID, 정산 가능 기한과 효과 형태를 검사한다', () => {
    const valid = row('A', 191, 12);
    expect(readHistoricEventsConfig(initial, { events: [valid], windowMonths: 1 }).events).toEqual([valid]);
    expect(() => readHistoricEventsConfig(initial, { events: [valid, valid], windowMonths: 1 })).toThrow('ID');
    expect(() => readHistoricEventsConfig(initial, { events: [{ ...valid, year: 190 }], windowMonths: 1 })).toThrow(
      '발생',
    );
    expect(() =>
      readHistoricEventsConfig(initial, {
        events: [{ ...valid, chooser: { ...chooser, name: '다른 국가' } }],
        windowMonths: 1,
      }),
    ).toThrow('생성 자료');
    expect(() =>
      readHistoricEventsConfig(initial, { events: [{ ...valid, counterpart: null }], windowMonths: 1 }),
    ).toThrow('상대 국가');
    expect(() =>
      readHistoricEventsConfig(initial, { events: [{ ...valid, counterpart: undefined }], windowMonths: 1 }),
    ).toThrow();
    expect(() =>
      readHistoricEventsConfig(initial, {
        events: [{ ...valid, options: [{ label: '하나', effects: [] }] }],
        windowMonths: 1,
      }),
    ).toThrow();
    expect(() =>
      readHistoricEventsConfig(initial, {
        events: [
          { ...valid, options: [{ label: '하나', effects: [{ kind: 'unknown', value: 1 }] }, valid.options[1]] },
        ],
        windowMonths: 1,
      }),
    ).toThrow();
    expect(historicEventChoiceSchema.safeParse({ eventId: 'A', option: 2 }).success).toBe(false);
    expect(historicEventChoiceSchema.safeParse({ eventId: 'A', option: 1, nationId: 1 }).success).toBe(false);
  });

  it('12월 사건은 한 달 뒤 닫히고 같은 정산에서 만료 처리 뒤 새 사건을 ID 순으로 연다', () => {
    const initialState = initialHistoricEvents();
    expect(settleHistoricEvents(initialState, decemberEvents, context(december - TICKS_PER_MONTH)).state).toEqual(
      initialState,
    );
    const decemberResult = settleHistoricEvents(initialState, decemberEvents, context(december));
    expect(decemberResult.opened.map(({ id }) => id)).toEqual(['A', 'B']);
    expect(decemberResult.opened[0]).toMatchObject({ firedTick: december, closesAtMonth: 13, choice: null });
    expect(decemberResult.resolved).toEqual([]);
    expect(initialState).toEqual({ pending: [], done: [], skipped: [] });
    const selected = chooseHistoricEvent(
      decemberResult.state,
      { eventId: 'A', option: 1 },
      actor,
      january - 1,
      () => true,
    );
    if (!('state' in selected)) throw new Error(selected.code);
    const sequence: number[] = [];
    const januaryResult = settleHistoricEvents(
      selected.state,
      decemberEvents,
      context(january, (id) => {
        sequence.push(id);
        return true;
      }),
    );
    expect(januaryResult.resolved).toEqual([
      { id: 'A', nationId: 1, choice: 1, defaulted: false, resolvedTick: january },
      { id: 'B', nationId: 1, choice: 0, defaulted: true, resolvedTick: january },
    ]);
    expect(januaryResult.opened.map(({ id }) => id)).toEqual(['C', 'D']);
    expect(sequence).toEqual([1, 1, 2, 2]);
    expect(decemberResult.state.pending[0]!.choice).toBeNull();
    expect(readHistoricEventsState(januaryResult.state, decemberEvents, 191)).toEqual(januaryResult.state);
    const repeated = settleHistoricEvents(januaryResult.state, decemberEvents, context(january));
    expect(repeated).toEqual({ state: januaryResult.state, resolved: [], opened: [] });
  });

  it('선택 자격과 기한을 재검사하고 같은 사건을 두 번 고르지 못한다', () => {
    const { state } = settleHistoricEvents(initialHistoricEvents(), decemberEvents, context(december));
    const choose = { eventId: 'A', option: 1 as const };
    const allowed = () => true;
    const justBefore = january - 1;
    expect(chooseHistoricEvent(undefined, choose, actor, justBefore, allowed)).toEqual({ code: 'FEATURE_DISABLED' });
    expect(chooseHistoricEvent(state, choose, null, justBefore, allowed)).toEqual({ code: 'NO_GENERAL' });
    expect(chooseHistoricEvent(state, { ...choose, eventId: 'X' }, actor, justBefore, allowed)).toEqual({
      code: 'EVENT_CLOSED',
    });
    expect(chooseHistoricEvent(state, choose, actor, january, allowed)).toEqual({ code: 'EVENT_CLOSED' });
    expect(chooseHistoricEvent(state, choose, actor, december - 1, allowed)).toEqual({ code: 'EVENT_CLOSED' });
    expect(chooseHistoricEvent(state, choose, { ...actor, nationId: 2 }, justBefore, allowed)).toEqual({
      code: 'NOT_YOUR_EVENT',
    });
    expect(chooseHistoricEvent(state, choose, actor, justBefore, () => false)).toEqual({ code: 'NOT_CHOOSER' });
    const first = chooseHistoricEvent(state, choose, actor, justBefore, allowed);
    if (!('state' in first)) throw new Error(first.code);
    expect(chooseHistoricEvent(first.state, choose, actor, justBefore, allowed)).toEqual({ code: 'ALREADY_CHOSEN' });
  });

  it('사건 전에 사라진 국가는 건너뛰고 선택 뒤 사라진 국가는 효과 없이 닫는다', () => {
    const { state: skipped } = settleHistoricEvents(
      initialHistoricEvents(),
      decemberEvents,
      context(december, () => false),
    );
    expect(skipped).toEqual({ pending: [], done: [], skipped: ['A', 'B'] });
    const { state } = settleHistoricEvents(initialHistoricEvents(), decemberEvents, context(december));
    const selected = chooseHistoricEvent(state, { eventId: 'A', option: 1 }, actor, january - 1, () => true);
    if (!('state' in selected)) throw new Error(selected.code);
    const result = settleHistoricEvents(
      selected.state,
      decemberEvents,
      context(january, () => false),
    );
    expect(result.resolved).toEqual(
      ['A', 'B'].map((id) => ({
        id,
        nationId: 1,
        choice: null,
        defaulted: true,
        resolvedTick: january,
      })),
    );
    expect(result.state.skipped).toEqual(['C', 'D']);
  });

  it('서로 겹치거나 없는 사건과 잘못된 기한이 기록된 상태를 거부한다', () => {
    const { state } = settleHistoricEvents(initialHistoricEvents(), decemberEvents, context(december));
    expect(() => readHistoricEventsState({ ...state, skipped: ['A'] }, decemberEvents, 191)).toThrow('ID');
    expect(() => readHistoricEventsState({ ...state, skipped: ['X'] }, decemberEvents, 191)).toThrow('ID');
    const [first, ...rest] = state.pending;
    expect(() =>
      readHistoricEventsState(
        {
          ...state,
          pending: [{ ...first!, closesAtMonth: 14 }, ...rest],
        },
        decemberEvents,
        191,
      ),
    ).toThrow('기한');
    expect(() =>
      readHistoricEventsState(
        {
          ...state,
          pending: [{ ...first!, firedTick: december - TICKS_PER_MONTH }, ...rest],
        },
        decemberEvents,
        191,
      ),
    ).toThrow('발생');
  });

  it('엔진이 처리할 수 있는 마지막 월 경계까지만 설정·상태·정산을 받는다', () => {
    const lastTick = 2_147_470_000;
    const nextTick = lastTick + TICKS_PER_MONTH;
    const windowMonths = (lastTick - december) / TICKS_PER_MONTH;
    const events = [row('A', 191, 12)];
    const config = readHistoricEventsConfig(initial, { events, windowMonths });
    expect(() => readHistoricEventsConfig(initial, { events, windowMonths: windowMonths + 1 })).toThrow('기한');

    const { state: opened } = settleHistoricEvents(initialHistoricEvents(), config, context(december));
    const { state: finished } = settleHistoricEvents(opened, config, context(lastTick));
    expect(readHistoricEventsState(finished, config, 191).done[0]?.resolvedTick).toBe(lastTick);
    expect(() =>
      readHistoricEventsState({ ...finished, done: [{ ...finished.done[0]!, resolvedTick: nextTick }] }, config, 191),
    ).toThrow();
    expect(() => settleHistoricEvents(opened, config, context(nextTick))).toThrow('실행 범위');
  });
});
