import { canManagePersonnel, isAppointableOfficerLevel, officerTitle } from './permissions';
import { hasCitySecretary, isLocalOffice, localOfficeAbility, localOfficeTitle } from './residentOffice';
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
  cityKey?: number,
  expectedHolderId?: number | null,
): PersonnelResult<AppointResult> {
  const failure = checkRuler(view, actorId);
  if (failure) return failure;
  const local = isLocalOffice(officerLevel);
  const officeEnabled = view.officeEffects && (officerLevel !== 2 || hasCitySecretary(view.officeEffects));
  if (
    (!local && !isAppointableOfficerLevel(officerLevel)) ||
    (local ? !officeEnabled || cityKey === undefined : cityKey !== undefined || expectedHolderId !== undefined)
  )
    return personnelFailure('BAD_ARGS', '직책과 담당 도시를 확인하세요.');
  const targetFailure = checkTarget(view, actorId, generalId);
  if (targetFailure) return targetFailure;
  const nationId = view.generals[actorId]!.nationId;
  if (local) {
    const city = view.cities[cityKey!];
    if (!city || city.nationId !== nationId || city.kind === 'PASS')
      return personnelFailure('BAD_TARGET', '자기 국가의 도시만 담당할 수 있습니다.');
    const candidate = view.generals[generalId]!;
    if (
      candidate.removedAt !== undefined ||
      !localOfficeAbility(candidate, officerLevel, view.officeEffects!.minimumAbility)
    )
      return personnelFailure('BAD_TARGET', '임명 자격을 갖춘 일반 장수만 가능합니다.');
    const state = clonePersonnel(view);
    const holder = Object.values(state.generals).find(
      (general) => general.officerLevel === officerLevel && general.officerCityKey === cityKey,
    );
    if (expectedHolderId !== undefined && expectedHolderId !== (holder?.id ?? null))
      return personnelFailure('BAD_STATE', '담당 장수가 바뀌었습니다. 다시 확인하세요.');
    const title = localOfficeTitle(officerLevel);
    const target = state.generals[generalId]!;
    target.officerLevel = officerLevel;
    target.officerCityKey = cityKey!;
    if (holder) {
      holder.officerLevel = 1;
      delete holder.officerCityKey;
    }
    return {
      ok: true,
      state,
      result: { generalId, officerLevel, title, officerCityKey: cityKey! },
      closedOffers: [],
      logs: [
        { generalId, commandKey: 'personnel.appoint', kind: 'success', text: `${city.name} ${title} 임명` },
        ...(holder
          ? [
              {
                generalId: holder.id,
                commandKey: 'personnel.dismiss' as const,
                kind: 'success' as const,
                text: `${city.name} ${title} 해임`,
              },
            ]
          : []),
      ],
    };
  }
  if (
    Object.values(view.generals).some(
      (general) => general.nationId === nationId && general.officerLevel === officerLevel,
    )
  )
    return personnelFailure('BAD_STATE', '먼저 해임하세요');
  const state = clonePersonnel(view);
  const target = state.generals[generalId]!;
  target.officerLevel = officerLevel;
  delete target.officerCityKey;
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
  const level = view.generals[generalId]!.officerLevel;
  if (
    !isAppointableOfficerLevel(level) &&
    !(view.officeEffects && isLocalOffice(level) && (level !== 2 || hasCitySecretary(view.officeEffects)))
  )
    return personnelFailure('BAD_TARGET', '해임할 직책이 없습니다.');
  const state = clonePersonnel(view);
  const target = state.generals[generalId]!;
  target.officerLevel = 1;
  delete target.officerCityKey;
  return {
    ok: true,
    state,
    result: { generalId, officerLevel: 1, title: officerTitle(1)! },
    closedOffers: [],
    logs: [{ generalId, commandKey: 'personnel.dismiss', kind: 'success', text: `${target.name} 해임` }],
  };
}
