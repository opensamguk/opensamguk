import { canManagePersonnel, isAppointableOfficerLevel, officerTitle } from './permissions';
import { clonePersonnel, personnelFailure } from './types';
import type { AppointResult, PersonnelFailure, PersonnelResult, PersonnelView } from './types';

function checkRuler(view: PersonnelView, actorId: number): PersonnelFailure | null {
  const actor = view.generals[actorId];
  if (!actor) return personnelFailure('NO_ACTOR', '장수가 없습니다.');
  if (actor.nationId === null || !view.nations[actor.nationId])
    return personnelFailure('NOT_NATION', '국가에 소속되어야 합니다.');
  return canManagePersonnel(actor.officerLevel)
    ? null
    : personnelFailure('NOT_RULER', '군주만 임명·해임할 수 있습니다.');
}

function checkTarget(view: PersonnelView, actorId: number, generalId: number): PersonnelFailure | null {
  const target = view.generals[generalId];
  if (!target || target.nationId !== view.generals[actorId]!.nationId)
    return personnelFailure('BAD_TARGET', '자기 국가 장수만 가능합니다.');
  return canManagePersonnel(target.officerLevel)
    ? personnelFailure('BAD_TARGET', '군주의 직책은 바꿀 수 없습니다.')
    : null;
}

// 직책 칸 비우기와 U2 검사는 호출부가 step 끝에서 syncOffices 뒤에 적용한다.
export function appointOfficer(
  view: PersonnelView,
  actorId: number,
  generalId: number,
  officerLevel: number,
): PersonnelResult<AppointResult> {
  const failure = checkRuler(view, actorId);
  if (failure) return failure;
  if (!isAppointableOfficerLevel(officerLevel)) return personnelFailure('BAD_ARGS', '임명할 수 없는 직책입니다.');
  const targetFailure = checkTarget(view, actorId, generalId);
  if (targetFailure) return targetFailure;
  const nationId = view.generals[actorId]!.nationId;
  if (
    Object.values(view.generals).some(
      (general) => general.nationId === nationId && general.officerLevel === officerLevel,
    )
  )
    return personnelFailure('BAD_STATE', '먼저 해임하세요');
  const state = clonePersonnel(view);
  const target = state.generals[generalId]!;
  target.officerLevel = officerLevel;
  const title = officerTitle(officerLevel)!;
  return {
    ok: true,
    state,
    result: { generalId, officerLevel, title },
    closedOffers: [],
    logs: [{ generalId, commandKey: 'personnel.appoint', kind: 'success', text: `${target.name} ${title} 임명` }],
  };
}

export function dismissOfficer(
  view: PersonnelView,
  actorId: number,
  generalId: number,
): PersonnelResult<AppointResult> {
  const failure = checkRuler(view, actorId) ?? checkTarget(view, actorId, generalId);
  if (failure) return failure;
  if (!isAppointableOfficerLevel(view.generals[generalId]!.officerLevel))
    return personnelFailure('BAD_TARGET', '해임할 직책이 없습니다.');
  const state = clonePersonnel(view);
  const target = state.generals[generalId]!;
  target.officerLevel = 1;
  return {
    ok: true,
    state,
    result: { generalId, officerLevel: 1, title: officerTitle(1)! },
    closedOffers: [],
    logs: [{ generalId, commandKey: 'personnel.dismiss', kind: 'success', text: `${target.name} 해임` }],
  };
}
