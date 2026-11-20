import { expect, it, vi } from 'vitest';
import { initialReplayStateWithRegistry, providedRuleData, ruleRegistry } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { reconcileGovernanceOrder } from './governance/service';
import { reconcileLineageOrder } from './lineage/service';

it('AC-INT-22 전술 후처리의 같은 잠금 사본도 황실·혼인 정리와 저장을 그대로 실행한다', async () => {
  const initial = await monthlyFixture();
  const state = initialReplayStateWithRegistry(initial, ruleRegistry, providedRuleData(initial, 60)).state;
  state.governance!.legitimacy['999999'] = 1;
  state.lineage!.offers.push({ id: 1, fromId: 1, toId: 2, expiresTick: 1 });
  state.lineage!.nextOfferId = 2;
  const original = structuredClone(state);
  const at = { tick: 2, sequence: 1 };
  for (const reconcile of [reconcileGovernanceOrder, reconcileLineageOrder]) {
    const load = vi.fn(async () => state);
    const save = vi.fn(async () => undefined);
    const repository = {
      load,
      save,
      isUserActive: vi.fn(),
      isSanctioned: vi.fn(),
      loadForGeneral: vi.fn(),
      saveControl: vi.fn(),
    };
    const expected = await reconcile(repository, 'world', at);
    expect(save).toHaveBeenCalledOnce();
    load.mockClear();
    save.mockClear();
    const actual = await reconcile(repository, 'world', at, state);
    expect(actual).toEqual(expected);
    expect(save).toHaveBeenCalledExactlyOnceWith('world', state, expected, at);
    expect(load).not.toHaveBeenCalled();
    expect(state).toEqual(original);
  }
});
