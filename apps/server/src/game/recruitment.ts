import { crewContext, crewTypeFailure, type Actor, type UnitSetResource, type WorldView } from '@opensamguk/rules';

// 새 병종의 모집 조건만 알린다. 비용·권한·병력 수량은 사전 검사와 실행 때 판정한다.
export function recruitmentAvailability(
  unitSet: UnitSetResource,
  view: WorldView,
  actor: Pick<Actor, 'generalId' | 'tick'>,
) {
  if (!unitSet.crewTypes.some((unit) => unit.requirements?.length)) return {};
  const context = crewContext(view, actor);
  return {
    recruitment: {
      tick: actor.tick ?? 0,
      ...(context.atCity ? { cityKey: view.generals[actor.generalId]?.cityKey ?? null } : {}),
      byCrewType: Object.fromEntries(
        unitSet.crewTypes
          .filter((unit) => unit.armType > 0)
          .map((unit) => [String(unit.id), crewTypeFailure(unit, context)]),
      ),
    },
  };
}
