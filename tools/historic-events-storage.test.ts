import { hashState } from '../packages/shared/src/node/hashState';
import { describe, expect, it } from 'vitest';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { TICKS_PER_MONTH } from '../packages/rules/src/clock/constants';
import { checkReplayOrigin, type ReplayOriginV1, type ReplayOriginV3 } from '../packages/rules/src/ruleRegistry';
import { HISTORIC_EVENTS_FEATURE, readHistoricEventsStorage } from '../packages/rules/src/historicEvents/origin';
import {
  initialHistoricEvents,
  settleHistoricEvents,
  type HistoricEventsConfig,
} from '../packages/rules/src/historicEvents/state';

const base = commandInitial();
const initial = {
  ...base,
  scenarioKey: '1030',
  ruleFeatures: [HISTORIC_EVENTS_FEATURE],
  nations: [{ ...base.nations[0]!, name: '시험 국가' }, ...base.nations.slice(1)],
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
const featureData = { [HISTORIC_EVENTS_FEATURE]: config };
const origin: ReplayOriginV3 = {
  version: 3,
  initial,
  featureData,
  initialStateHash: hashState(initial),
  resourceHash: hashState({
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    featureData,
  }),
};
const record = () => ({
  replayFormat: 3,
  ruleFeatures: initial.ruleFeatures,
  replayOrigin: origin,
  initialStateHash: origin.initialStateHash,
  monthlyTick: 0,
  historicEventsState: initialHistoricEvents(),
});

function checkOrigin(value: unknown): asserts value is ReplayOriginV1 | ReplayOriginV3 {
  checkReplayOrigin(value, {
    features: [{ key: HISTORIC_EVENTS_FEATURE, requires: [], conflicts: [] }],
    inputKinds: [],
  });
}

const read = (world: Parameters<typeof readHistoricEventsStorage>[0]) =>
  readHistoricEventsStorage(world, checkOrigin, hashState);

describe('AC-P2-21 역사 사건의 생성 기록과 저장 상태', () => {
  it('현재 코드의 사건 표와 독립적으로 생성 기록에서 사건 사본을 복구한다', () => {
    const storage = read(record())!;
    expect(storage).toEqual({ config, state: initialHistoricEvents() });
    storage.config.events[0]!.title = '나중에 바꾼 제목';
    expect(read(record())!.config.events[0]!.title).toBe('생성 때의 제목');
  });

  it('켜진 기능의 원본·저장 상태 누락과 기능 목록 불일치를 거부한다', () => {
    const world = record();
    expect(() => read({ ...world, replayOrigin: null })).toThrow();
    expect(() => read({ ...world, historicEventsState: null })).toThrow();
    expect(() => read({ ...world, replayFormat: 1 })).toThrow('생성 기록');
    expect(() => read({ ...world, ruleFeatures: ['policy', HISTORIC_EVENTS_FEATURE] })).toThrow('생성 기록');
    expect(() => read({ ...world, replayOrigin: { ...world.replayOrigin, featureData: {} } })).toThrow();
  });

  it('형식에 맞는 기본 선택지나 생성 국가를 바꿔도 기존 해시로 복구할 수 없다', () => {
    const world = record();
    const changedData = structuredClone(featureData);
    changedData[HISTORIC_EVENTS_FEATURE].events[0]!.defaultOption = 0;
    expect(() => read({ ...world, replayOrigin: { ...origin, featureData: changedData } })).toThrow('해시');
    const changedInitial = structuredClone(initial);
    changedInitial.nations[0]!.name = '변경한 국가';
    expect(() => read({ ...world, replayOrigin: { ...origin, initial: changedInitial } })).toThrow('해시');
  });

  it('자체 해시가 맞는 다른 시드의 생성 기록도 원래 월드에 쓸 수 없다', () => {
    const otherInitial = { ...initial, seed: 'other-seed' };
    const otherOrigin = { ...origin, initial: otherInitial, initialStateHash: hashState(otherInitial) };
    expect(
      read({ ...record(), replayOrigin: otherOrigin, initialStateHash: otherOrigin.initialStateHash }),
    ).toBeDefined();
    expect(() => read({ ...record(), replayOrigin: otherOrigin })).toThrow('월드와 원생성 상태 해시');
  });

  it('꺼진 기존 월드는 저장 상태가 없고 켜진 월드는 월 정산과 일치한다', () => {
    const world = record();
    expect(read({ ...world, ruleFeatures: [], historicEventsState: null })).toBeUndefined();
    expect(() => read({ ...world, ruleFeatures: [] })).toThrow('기능을 끈');
    const monthlyTick = TICKS_PER_MONTH;
    const { state } = settleHistoricEvents(initialHistoricEvents(), config, {
      startYear: initial.startYear,
      tick: monthlyTick,
      nationExists: () => true,
    });
    expect(read({ ...world, monthlyTick, historicEventsState: state })?.state).toEqual(state);
    expect(() => read({ ...world, monthlyTick })).toThrow('월 정산 시점');
  });
});
