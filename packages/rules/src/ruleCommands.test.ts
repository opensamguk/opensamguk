import { describe, expect, it } from 'vitest';
import { commandInitial } from '../test/commandFixture';
import { commands } from './commands/registry';
import { extensionCommands } from './commands/ext/registry';
import { extCommandBindings } from './commands/ext/state';
import { applyTreatyInput } from './diplomacy/treaty';
import { applyRecordedInput, emptyTurns, initialReplayState, runReplayAction } from './replay';
import { resolverForRuleFeatures } from './ruleCommands';
import { checkRuleFeatures, ruleRegistry } from './ruleRegistry';

describe('교역의 형식 3 무상태 명령 등록', () => {
  it('기본37개와 기존확장4개는 그대로이고 교역은 같은 기능표의 빈 sliceKeys binding이다', () => {
    expect(commands).toHaveLength(37);
    expect(commands.some((definition) => definition.key === 'trade')).toBe(false);
    expect(extensionCommands.map((definition) => definition.key)).toEqual([
      'fire_attack',
      'sabotage',
      'incite',
      'plunder',
    ]);
    expect(extCommandBindings).toHaveLength(4);
    expect(
      ruleRegistry.features
        .find((feature) => feature.key === 'treaty-trade')
        ?.commandBindings?.map((binding) => ({ key: binding.definition.key, sliceKeys: binding.sliceKeys })),
    ).toEqual([{ key: 'trade', sliceKeys: [] }]);
  });
  it('조약 없이 교역만 선택할 수 없고 끈 기능은 명령을 내지 않는다', () => {
    expect(() => checkRuleFeatures(['treaty-trade'])).toThrow('의존');
    expect(resolverForRuleFeatures({})).toBeUndefined();
    expect(resolverForRuleFeatures({ ruleFeatures: ['treaty'] })).toBeUndefined();
    const resolver = resolverForRuleFeatures({ ruleFeatures: ['treaty', 'treaty-trade'] })!;
    expect(resolver.get('trade')?.name).toBe('교역');
    expect(resolver.list('general').length + resolver.list('nation').length).toBe(38);
    expect(resolver.get('fire_attack')).toBeUndefined();
  });
  it('실제 조약 입력을 재현한 뒤 명시 교역 예턴을 같은 기능표 resolver로 실행한다', () => {
    const initial = commandInitial();
    initial.ruleFeatures = ['treaty', 'treaty-trade'];
    initial.generals[0]!.userId = 'human';
    initial.generals[1]!.userId = 'other-human';
    initial.nations[1]!.isNpc = false;
    const before = initialReplayState(initial);
    const payload = { toNationId: 2, clauses: [{ kind: 'peace' as const }, { kind: 'trade' as const, months: 3 }] };
    const domain = applyTreatyInput(
      before.state,
      { kind: 'treaty.propose', generalId: 1, payload },
      { tick: 50, sequence: 1, tradeEnabled: true },
    );
    if (!domain.ok || domain.result.outcome !== 'PROPOSED') throw new Error('교역 조약을 제안하지 못했습니다.');
    const proposed = applyRecordedInput(before, {
      sequence: 1,
      tick: 50,
      kind: 'treaty.propose',
      generalId: 1,
      status: 'APPLIED',
      payload,
      result: domain.result,
    });
    expect(proposed.state).toEqual(domain.state);
    const responsePayload = { treatyId: '1', accept: true };
    const response = applyTreatyInput(
      proposed.state,
      { kind: 'treaty.respond', generalId: 2, payload: responsePayload },
      { tick: 60, sequence: 2, tradeEnabled: true },
    );
    if (!response.ok || response.result.outcome !== 'ACCEPTED') throw new Error('교역 조약을 수락하지 못했습니다.');
    const accepted = applyRecordedInput(proposed, {
      sequence: 2,
      tick: 60,
      kind: 'treaty.respond',
      generalId: 2,
      status: 'APPLIED',
      payload: responsePayload,
      result: response.result,
    });
    const turns = emptyTurns();
    turns[0] = { commandKey: 'trade', args: { cityKey: 2 } };
    const queued = applyRecordedInput(accepted, {
      sequence: 3,
      tick: null,
      kind: 'turns.set',
      generalId: 1,
      status: 'APPLIED',
      payload: { turns, revision: 0 },
      result: { revision: 1 },
    });
    const after = runReplayAction(queued, initial.seed, initial.unitSet);
    expect(after.state.generals[1]!.experience).toBe(queued.state.generals[1]!.experience + 10);
    expect(after.state.generals[1]!.dedication).toBe(queued.state.generals[1]!.dedication + 15);
    expect(after.state.nations[1]!.gold).toBeGreaterThan(queued.state.nations[1]!.gold);
    expect(after.state.generals[1]!.nextTurnTick).toBe(10100);
    expect(before.state.treaties).toBeUndefined();
  });
});
