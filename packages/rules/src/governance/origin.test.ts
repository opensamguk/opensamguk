import { describe, expect, it } from 'vitest';
import { readStoredGovernance } from './origin';
import { governanceFixture, governanceTestConfig } from './testFixture';

function fixture() {
  const state = governanceFixture();

  return {
    state,
    record: {
      replayFormat: 3,

      monthlyTick: 0,
      governanceState: state.governance!,
      replayOrigin: {
        version: 3,
        initial: {},
        featureData: { 'governance-v1': governanceTestConfig },
      },
    },
  };
}
describe('AC-P2-31·35 저장 황실과 원생성 계약', () => {
  it('상시 제공 황실의 저장 상태 누락은 거부한다', () => {
    const { state, record } = fixture();
    expect(() => readStoredGovernance({ ...record, governanceState: null }, state)).toThrow();
  });
  it('의존 기능·원생성 설정·월 tick이 서로 맞아야 한다', () => {
    const { state, record } = fixture();
    expect(readStoredGovernance(record, state)).toEqual(state.governance);
    expect(() =>
      readStoredGovernance({ ...record, replayOrigin: { ...record.replayOrigin, featureData: {} } }, state),
    ).toThrow();
    expect(() => readStoredGovernance({ ...record, monthlyTick: 10_000 }, state)).toThrow('tick');
    record.governanceState.config.tribute.maxBp++;
    expect(() => readStoredGovernance(record, state)).toThrow('원생성');
  });
});
