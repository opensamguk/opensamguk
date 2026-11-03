import { describe, expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { applyRecordedInput, type RecordedInput, type ReplayState } from '../replay';
import type { RuleRegistry } from '../ruleRegistry';
import { decideGovernanceAction } from './actions';
import { governanceFeature, governanceInputKind, validateGovernanceRecord } from './feature';
import { governanceFixture, governanceTestConfig } from './testFixture';

function fixture(): ReplayState {
  const state = governanceFixture();
  state.generals[1]!.userId = 'person-1';
  state.governance!.legitimacy['1'] = 60;
  return { state, turns: {}, revisions: {}, monthlyTick: 0 };
}
describe('AC-P2-31 황실 입력 재생과 후처리 경계', () => {
  it('실제 결정 결과를 재생하고 기록의 행동·tick·번호 변조를 거부한다', () => {
    const replay = fixture(),
      payload = { type: 'throne.ascend' };
    const outcome = decideGovernanceAction(replay.state, 1, payload, 1);
    if (!outcome.ok) throw new Error(outcome.code);
    const input: RecordedInput = {
      sequence: 1,
      tick: 1,
      generalId: 1,
      kind: 'governance.act',
      status: 'APPLIED',
      payload,
      result: outcome.result,
    };
    const registry: RuleRegistry = { features: [governanceFeature], inputKinds: [governanceInputKind] };
    expect(applyRecordedInput(replay, input, registry).state).toEqual(outcome.state);
    expect(() =>
      applyRecordedInput(replay, { ...input, result: { ...outcome.result, revision: 9 } }, registry),
    ).toThrow('재현');
    expect(() => validateGovernanceRecord({ ...input, result: { ...outcome.result, tick: 2 } })).toThrow('다릅니다');
    expect(() =>
      validateGovernanceRecord({ ...input, result: { ...outcome.result, action: 'throne.abdicate' } }),
    ).toThrow('다릅니다');
    expect(() => validateGovernanceRecord({ ...input, sequence: 0 })).toThrow();
    expect(() =>
      validateGovernanceRecord({ ...input, status: 'REJECTED', result: { code: 'NO_AUTHORITY', message: '거부' } }),
    ).not.toThrow();
    expect(() =>
      validateGovernanceRecord({
        ...input,
        status: 'REJECTED',
        result: { code: 'NO_AUTHORITY', message: '거부', secret: 1 },
      }),
    ).toThrow();
  });
  it.each(['direct', 'queued'] as const)(
    '재생에 등록된 %s 경로를 전달하고 queued 입력 뒤에만 황실을 정리한다',
    (route) => {
      const replay = fixture();
      replay.state.governance!.throne = { emperorGeneralId: 1, emperorNationId: 1, sinceTick: 0 };
      const registry: RuleRegistry = {
        features: [governanceFeature],
        inputKinds: [
          {
            kind: 'test.capture',
            feature: null,
            route,
            apply(before) {
              const state = structuredClone(before.state);
              state.cities[1]!.nationId = 2;
              return { ...before, state };
            },
          },
        ],
      };
      const result = applyRecordedInput(
        replay,
        { sequence: 1, tick: 1, generalId: 1, kind: 'test.capture', status: 'APPLIED', payload: {}, result: {} },
        registry,
      );
      expect(result.state.governance!.throne.emperorGeneralId).toBe(route === 'queued' ? null : 1);
      expect(replay.state.governance!.throne.emperorGeneralId).toBe(1);
    },
  );
  it('새 원생성에서만 초기화하고 설정 누락·이미 들어 있는 황실을 거부한다', () => {
    const initial = commandInitial();
    expect(() => governanceFeature.checkOrigin!({ initial, data: undefined })).toThrow();
    expect(() => governanceFeature.checkOrigin!({ initial, data: governanceTestConfig })).not.toThrow();
    const empty = fixture();
    delete empty.state.governance;
    const initialized = governanceFeature.initReplayState!(empty, { initial, data: governanceTestConfig });
    expect(initialized.state.governance!.throne.emperorGeneralId).toBeNull();
    expect(() => governanceFeature.initReplayState!(initialized, { initial, data: governanceTestConfig })).toThrow(
      '중복',
    );
    expect(
      governanceFeature.afterAppliedInput!(
        empty,
        initialized,
        { sequence: 1, tick: 1, generalId: 1, kind: 'turns.set', status: 'APPLIED', payload: {}, result: {} },
        { route: 'direct' },
      ),
    ).toBe(initialized);
  });
});
