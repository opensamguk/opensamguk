import { describe, expect, it } from 'vitest';
import { TICKS_PER_MONTH } from '../clock/constants';
import { HISTORIC_EVENTS_FEATURE, readHistoricEventsStorage } from './origin';
import { initialHistoricEvents, settleHistoricEvents, type HistoricEventsConfig } from './state';

const initial = {
  scenarioKey: '1030',
  startYear: 191,
  ruleFeatures: [HISTORIC_EVENTS_FEATURE],
  nations: [{ id: 1, name: '시험 국가' }],
};
const config: HistoricEventsConfig = {
  windowMonths: 1,
  events: [
    {
      id: 'A',
      year: 191,
      month: 1,
      chooser: { nationId: 1, name: '시험 국가' },
      counterpart: null,
      title: '생성 때의 제목',
      text: '시험 사건',
      options: [
        { label: '선택 A', effects: [] },
        { label: '선택 B', effects: [{ kind: 'gold', value: 7 }] },
      ],
      defaultOption: 1,
      ref: '시험 자료',
    },
  ],
};
const record = () => ({
  replayFormat: 3,
  ruleFeatures: initial.ruleFeatures,
  replayOrigin: { version: 3, initial, featureData: { [HISTORIC_EVENTS_FEATURE]: config } },
  monthlyTick: 0,
  historicEventsState: initialHistoricEvents(),
});

describe('AC-P2-21 역사 사건의 생성 기록과 저장 상태', () => {
  it('현재 코드의 사건 표와 독립적으로 생성 기록에서 사건 사본을 복구한다', () => {
    const storage = readHistoricEventsStorage(record())!;
    expect(storage).toEqual({ config, state: initialHistoricEvents() });
    storage.config.events[0]!.title = '나중에 바꾼 제목';
    expect(readHistoricEventsStorage(record())!.config.events[0]!.title).toBe('생성 때의 제목');
  });

  it('켜진 기능의 원본·저장 상태 누락과 기능 목록 불일치를 거부한다', () => {
    const world = record();
    expect(() => readHistoricEventsStorage({ ...world, replayOrigin: null })).toThrow();
    expect(() => readHistoricEventsStorage({ ...world, historicEventsState: null })).toThrow();
    expect(() => readHistoricEventsStorage({ ...world, replayFormat: 1 })).toThrow('생성 기록');
    expect(() => readHistoricEventsStorage({ ...world, ruleFeatures: ['policy', HISTORIC_EVENTS_FEATURE] })).toThrow(
      '생성 기록',
    );
    expect(() =>
      readHistoricEventsStorage({ ...world, replayOrigin: { ...world.replayOrigin, featureData: {} } }),
    ).toThrow();
  });

  it('꺼진 기존 월드는 저장 상태가 없고 켜진 월드는 월 정산과 일치한다', () => {
    const world = record();
    expect(readHistoricEventsStorage({ ...world, ruleFeatures: [], historicEventsState: null })).toBeUndefined();
    expect(() => readHistoricEventsStorage({ ...world, ruleFeatures: [] })).toThrow('기능을 끈');
    const monthlyTick = TICKS_PER_MONTH;
    const { state } = settleHistoricEvents(initialHistoricEvents(), config, {
      startYear: initial.startYear,
      tick: monthlyTick,
      nationExists: () => true,
    });
    expect(readHistoricEventsStorage({ ...world, monthlyTick, historicEventsState: state })?.state).toEqual(state);
    expect(() => readHistoricEventsStorage({ ...world, monthlyTick })).toThrow('월 정산 시점');
  });
});
