import { describe, expect, it } from 'vitest';
import { TICKS_PER_MONTH } from '../clock/constants';
import { initialHistoricEvents, settleHistoricEvents, type HistoricEventsConfig } from './state';
import { historicEventsView } from './view';

const event: HistoricEventsConfig['events'][number] = {
  id: 'private-event',
  year: 191,
  month: 1,
  chooser: { nationId: 1, name: '한' },
  counterpart: { nationId: 2, name: '상대국' },
  title: '사건 제목',
  text: '소속 국가에만 공개할 내용',
  options: [
    { label: '지원', effects: [{ kind: 'gold', value: 1000 }] },
    { label: '거절', effects: [] },
  ],
  defaultOption: 0,
  ref: '원문',
};
const config = { events: [event], windowMonths: 2 };
const opened = settleHistoricEvents(initialHistoricEvents(), config, {
  startYear: 191,
  tick: TICKS_PER_MONTH,
  nationExists: () => true,
}).state;

describe('AC-P2-21 역사 사건 조회 공개 범위', () => {
  it('같은 국가의 장수만 진행 중인 사건과 선택지를 본다', () => {
    const runtime = { config, state: opened };
    expect(historicEventsView(runtime, 1)).toEqual({
      enabled: true,
      mine: [
        {
          id: event.id,
          title: event.title,
          text: event.text,
          counterpart: event.counterpart,
          options: event.options,
          defaultOption: 0,
          choice: null,
          closesAtMonth: 3,
        },
      ],
      done: [],
    });
    expect(historicEventsView(runtime, 2)).toEqual({ enabled: true, mine: [], done: [] });
    expect(historicEventsView(runtime, null)).toEqual({ enabled: true, mine: [], done: [] });
    expect(historicEventsView(undefined, 1)).toEqual({ enabled: false, mine: [], done: [] });
  });

  it('다른 국가에는 실제 적용된 선택의 요약만 보인다', () => {
    const state = settleHistoricEvents(opened, config, {
      startYear: 191,
      tick: TICKS_PER_MONTH * 3,
      nationExists: () => true,
    }).state;
    expect(historicEventsView({ config, state }, 2)).toEqual({
      enabled: true,
      mine: [],
      done: [
        {
          id: event.id,
          title: event.title,
          nation: event.chooser,
          choice: 0,
          choiceLabel: '지원',
          defaulted: true,
          resolvedTick: TICKS_PER_MONTH * 3,
        },
      ],
    });
  });

  it('국가가 사라져 취소된 사건의 선택지를 다른 국가에 공개하지 않는다', () => {
    const state = settleHistoricEvents(opened, config, {
      startYear: 191,
      tick: TICKS_PER_MONTH * 3,
      nationExists: () => false,
    }).state;
    expect(state.done[0]?.choice).toBeNull();
    expect(historicEventsView({ config, state }, 2)).toEqual({ enabled: true, mine: [], done: [] });
  });
});
