import { createRng } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from './effects';
import { commandRegistry } from './registry';
import { commandStatPreview } from './statPreview';
import { emptyCampaignState } from '../campaign/state';
import { applyCampaignPreparation } from '../campaign/preparation';

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

  it('부곡 미리보기는 실제 부장과 해당 부곡의 훈련·사기를 쓰고 비용은 소유자에게 계산한다', () => {
    const state = commandWorld();
    state.ruleFeatures = ['campaign-v1', 'five-stats'];
    for (const general of Object.values(state.generals)) Object.assign(general, { politics: 50, charm: 50, crew: 0 });
    Object.assign(state.generals[1]!, { leadership: 25, charm: 20, train: 0, atmos: 0 });
    Object.assign(state.generals[4]!, { nationId: 1, cityKey: 1, leadership: 100, charm: 100 });
    state.campaign = emptyCampaignState(state, 'campaign-preview', 'sourced-test');
    state.campaign.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    state.campaign.units = [{ id: 1, ownerId: 1, commanderId: 4, troops: 100, crewType: 1100, train: 98, atmos: 99 }];
    state.campaign.nextUnitId = 2;
    const before = structuredClone(state),
      actor = { generalId: 1, unitSet: testUnits };
    for (const key of ['train', 'morale', 'recruit', 'conscript'] as const) {
      const args = key === 'recruit' || key === 'conscript' ? { amount: 10, crewType: 1100, unitId: 1 } : { unitId: 1 };
      const preview = commandStatPreview(state, actor, key, args)!;
      const outcome = applyCampaignPreparation(state, actor, key, args);
      if (!outcome.ok) throw new Error(outcome.message);
      expect(preview.goldCost).toBe(state.generals[1]!.gold - outcome.state.generals[1]!.gold);
      if (key === 'train') expect(preview.gain).toBe(2);
      if (key === 'morale') expect(preview.gain).toBe(1);
      expect(outcome.state.generals[4]!.gold).toBe(state.generals[4]!.gold);
    }
    expect(commandStatPreview(state, actor, 'train', { unitId: 99 })).toBeNull();
    expect(state).toEqual(before);
  });
});
