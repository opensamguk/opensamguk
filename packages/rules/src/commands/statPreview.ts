import { BALANCE } from '../balance';
import type { WorldView } from '../model/world';
import { DOMESTIC_SPECS } from './domestic/investment';
import { recruitArgs } from './military';
import { domesticStatScore, drillGain, recruitCost } from './statScores';
import type { Actor } from './types';

export interface CommandStatPreview {
  goldCost: number;
  statScore?: number;
  gain?: number;
}

// 실제 성공량을 예언하지 않는다. 비용·능력치 입력·확정 훈련량만 실행과 같은 함수로 읽는다.
export function commandStatPreview(
  view: WorldView,
  actor: Actor,
  key: string,
  args: unknown,
): CommandStatPreview | null {
  if (!view.ruleFeatures?.includes('five-stats')) return null;
  const general = view.generals[actor.generalId];
  if (!general) return null;
  const spec = DOMESTIC_SPECS.find((row) => row.key === key);
  if (spec)
    return {
      statScore: domesticStatScore(view, general, key, spec.stat),
      goldCost: BALANCE.DEVEL_COST * (spec.costFactor ?? 1),
    };
  if (key === 'train' || key === 'morale')
    return {
      goldCost: BALANCE.DRILL_COST,
      gain: Math.max(
        0,
        Math.min(100 - general[key === 'morale' ? 'atmos' : 'train'], drillGain(view, general, key === 'morale')),
      ),
    };
  if (key === 'recruit' || key === 'conscript') {
    const parsed = recruitArgs.safeParse(args);
    if (!parsed.success) return null;
    const unit = actor.unitSet?.crewTypes.find((row) => row.id === parsed.data.crewType && row.armType > 0);
    if (!unit) return null;
    return { goldCost: recruitCost(view, general, parsed.data.amount, unit.cost, key === 'conscript') };
  }
  return null;
}
