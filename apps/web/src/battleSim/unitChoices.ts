// 월드 병종표(resources.worldRules)에서 화면이 쓰는 값만 꺼낸다 (T4-86). @opensamguk/rules를 import하지 않는다.
// 모집 조건(requirements)은 보지 않는다. 지금 조건 실패는 turns.precheck가 경고하고 예약은 막지 않는다.
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { WALL_CREW_TYPE } from './request';

export type WorldUnitSet = inferRouterOutputs<AppRouter>['resources']['worldRules']['unitSet'];
export type UnitInfo = { readonly id: number; readonly armType: number; readonly name: string };
export type WorldUnits = {
  // 요청 검사용 전체 목록 (성벽 포함)
  all: readonly UnitInfo[];
  armTypes?: Readonly<Record<string, string>>;
  // 장수 병종 (armType > 0)
  generals: readonly UnitInfo[];
  // 월드 기본 병종이 장수 병종이면 그것, 아니면 첫 장수 병종
  defaultId: number | undefined;
  hasWall: boolean;
  name: (id: number) => string | undefined;
};

// 병종표가 아직 없거나(불러오는 중·오류) 받은 병종표에서 만든다. 없으면 모든 목록이 비어 있다.
export function worldUnits(unitSet: WorldUnitSet | undefined): WorldUnits {
  const all = (unitSet?.crewTypes ?? []).map((unit) => ({ id: unit.id, armType: unit.armType, name: unit.name }));
  const generals = all.filter((unit) => unit.armType > 0);
  const byId = new Map(all.map((unit) => [unit.id, unit.name]));
  return {
    all,
    ...(unitSet ? { armTypes: unitSet.armTypes } : {}),
    generals,
    defaultId: generals.find((unit) => unit.id === unitSet?.defaultCrewTypeId)?.id ?? generals[0]?.id,
    hasWall: byId.has(WALL_CREW_TYPE),
    name: (id) => byId.get(id),
  };
}
