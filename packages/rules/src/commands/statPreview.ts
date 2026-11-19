import { BALANCE } from '../balance';
import { applyCampaignPreparation } from '../campaign/preparation';
import type { WorldView } from '../model/world';
import { DOMESTIC_SPECS } from './domestic/investment';
import { applyCityPreparation, applyCityUnitRecruitment } from '../cityResources/preparation';
import { domesticStatScore } from './statScores';
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
  const general = view.generals[actor.generalId];
  if (!general) return null;
  if (key === 'recruit' || key === 'conscript' || key === 'train' || key === 'morale') {
    const recruiting = key === 'recruit' || key === 'conscript';
    const value = args && typeof args === 'object' ? args : {};
    const city = !!view.cityResources && (recruiting || 'target' in value);
    const outcome = city
      ? recruiting && 'unitId' in value
        ? applyCityUnitRecruitment(view, actor, key, args)
        : applyCityPreparation(view, actor, key, args)
      : applyCampaignPreparation(view, actor, key, args);
    if (!outcome.ok) return null;
    const gold = (state: WorldView) =>
      city ? state.cityResources!.cities[String(general.cityKey)]!.gold : state.generals[general.id]!.gold;
    if (recruiting) return { goldCost: gold(view) - gold(outcome.state) };
    const field = key === 'morale' ? 'atmos' : 'train';
    const readiness = (state: WorldView) =>
      city
        ? state.cityResources!.cities[String(general.cityKey)]!.garrison.find(
            (row) => row.crewType === (value as { crewType: number }).crewType,
          )![field]
        : state.campaign!.units.find((unit) => 'unitId' in outcome && unit.id === outcome.unitId)![field];
    return { goldCost: gold(view) - gold(outcome.state), gain: readiness(outcome.state) - readiness(view) };
  }
  const spec = DOMESTIC_SPECS.find((row) => row.key === key);
  if (spec)
    return {
      statScore: domesticStatScore(view, general, key, spec.stat),
      goldCost: BALANCE.DEVEL_COST * (spec.costFactor ?? 1),
    };
  return null;
}
