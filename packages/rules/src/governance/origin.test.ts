import { describe, expect, it } from 'vitest';
import { readStoredGovernance } from './origin';
import { governanceFixture, governanceTestConfig } from './testFixture';

function fixture() {
  const state = governanceFixture();
  const features = ['city-resources-v1', 'governance-v1', 'personnel', 'treaty'];
  return {
    state,
    record: {
      replayFormat: 3,
      ruleFeatures: features,
      monthlyTick: 0,
      governanceState: state.governance!,
      replayOrigin: {
        version: 3,
        initial: { ruleFeatures: features },
        featureData: { 'governance-v1': governanceTestConfig },
      },
    },
  };
}
describe('AC-P2-31·35 저장 황실과 원생성 계약', () => {
  it('기능을 끈 기존 판은 null 칸을 상태에 추가하지 않고 남은 데이터는 거부한다', () => {
    const { state, record } = fixture();
    expect(readStoredGovernance({ ...record, ruleFeatures: [], governanceState: null }, state)).toBeUndefined();
    expect(() => readStoredGovernance({ ...record, ruleFeatures: [] }, state)).toThrow('끈');
  });
  it('의존 기능·원생성 설정·월 tick이 서로 맞아야 한다', () => {
    const { state, record } = fixture();
    expect(readStoredGovernance(record, state)).toEqual(state.governance);
    expect(() => readStoredGovernance({ ...record, ruleFeatures: ['governance-v1'] }, state)).toThrow('의존');
    expect(() => readStoredGovernance({ ...record, monthlyTick: 10_000 }, state)).toThrow('tick');
    record.governanceState.config.tribute.maxBp++;
    expect(() => readStoredGovernance(record, state)).toThrow('원생성');
  });
});
