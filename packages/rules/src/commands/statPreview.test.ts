import { createRng } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from './effects';
import { commandRegistry } from './registry';
import { commandStatPreview } from './statPreview';

describe('AC-INT-15 명령 미리보기', () => {
  it('구형 판과 알 수 없는 행위자·명령에는 새 계약을 추가하지 않는다', () => {
    const state = commandWorld();
    expect(commandStatPreview(state, { generalId: 1 }, 'farm', {})).toBeNull();
    state.ruleFeatures = ['five-stats'];
    expect(commandStatPreview(state, { generalId: 999 }, 'farm', {})).toBeNull();
    expect(commandStatPreview(state, { generalId: 1 }, 'rest', {})).toBeNull();
  });

  it('반복 미리보기는 상태를 바꾸지 않고 실제 차감·확정 훈련량과 같다', () => {
    const state = commandWorld();
    state.ruleFeatures = ['five-stats'];
    Object.assign(state.generals[1]!, { politics: 90, charm: 70, train: 95, atmos: 80, crew: 100 });
    const before = structuredClone(state);
    const actor = { generalId: 1, unitSet: testUnits };
    for (const key of ['farm', 'train', 'morale', 'recruit', 'conscript']) {
      const args = key === 'recruit' || key === 'conscript' ? { amount: 100, crewType: 1100 } : {};
      const preview = commandStatPreview(state, actor, key, args)!;
      expect(commandStatPreview(state, actor, key, args)).toEqual(preview);
      const after = applyEffects(
        state,
        commandRegistry.get(key)!.execute(state, actor, args, createRng('preview')).effects,
      );
      expect(state.generals[1]!.gold - after.generals[1]!.gold).toBe(preview.goldCost);
      if (key === 'farm') expect(preview).toHaveProperty('statScore', 90);
      if (key === 'train' || key === 'morale') {
        const stat = key === 'train' ? 'train' : 'atmos';
        expect(after.generals[1]![stat] - state.generals[1]![stat]).toBe(preview.gain);
      }
    }
    expect(state).toEqual(before);
  });

  it('잘못된 모병 인자·부대에는 비용을 꾸며 내지 않는다', () => {
    const state = commandWorld();
    state.ruleFeatures = ['five-stats'];
    Object.assign(state.generals[1]!, { politics: 50, charm: 50 });
    for (const args of [{}, { amount: -1, crewType: 1100 }, { amount: 10, crewType: 1000 }])
      expect(commandStatPreview(state, { generalId: 1, unitSet: testUnits }, 'recruit', args)).toBeNull();
  });
});
