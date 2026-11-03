import type { WorldView } from '../model/world';
import { monthlyDate } from '../monthly';
import { emptyLineagePerson } from './state';
import { reconcileLineage } from './reconcile';
import {
  heirEligibility,
  lineageActive,
  lineageAlive,
  lineageYear,
  lineageDescendants,
  marriageProposalEligibility,
} from './eligibility';
import { successionPreview } from './preview';
import { decideLineageAction } from './actions';

export function lineageView(
  world: WorldView,
  actorId: number | null,
  tick: number,
  focusId?: number,
  detailsVisible: (general: { id: number; nationId: number | null }) => boolean = () => false,
) {
  const current = reconcileLineage(world, tick),
    state = current.lineage!;
  const failureView = <T extends { code: string; message: string; reason?: string } | null>(
    failure: T,
    visible: boolean,
  ) =>
    failure && (!visible || failure.reason === 'HEIR_RESERVED')
      ? { ok: false as const, code: 'UNAVAILABLE', message: '지금은 이 요청을 할 수 없습니다.' }
      : failure;
  if (!state) throw Error('가문 조회 상태가 없습니다.');
  const people = Object.values(current.generals)
    .sort((a, b) => a.id - b.id)
    .map((general) => {
      const person = state.persons[String(general.id)] ?? emptyLineagePerson();
      const year = person.exit
        ? person.exit.cause === 'DIED'
          ? monthlyDate(world.startYear, person.exit.tick).year
          : lineageYear(world, person.exit.tick)
        : lineageYear(world, tick);
      return {
        id: general.id,
        name: general.name,
        nationId: general.nationId,
        sex: general.sex!,
        active: lineageActive(current, general.id, tick),
        ...(detailsVisible(general)
          ? {
              portraitId: general.portraitId,
              cityKey: general.cityKey,
              isHuman: general.userId !== null,
              activeFromYear: person.exit ? null : general.activeFromYear,
              age: Math.max(0, year - general.birthYear),
              officerLevel: general.officerLevel,
            }
          : {}),
        parents: [...person.parents],
        bornTick: person.bornTick,
        successorId: person.successorId,
        exit: person.exit ? { tick: person.exit.tick, cause: person.exit.cause } : null,
      };
    });
  const nations = Object.values(current.nations)
    .sort((a, b) => a.id - b.id)
    .map((nation) => ({
      id: nation.id,
      name: nation.name,
      color: nation.color,
      vacant: !Object.values(current.generals).some(
        (g) => g.nationId === nation.id && g.officerLevel === 12 && lineageAlive(current, g.id),
      ),
    }));
  const actor = actorId === null ? null : current.generals[actorId];
  const mine =
    actor?.userId != null
      ? (() => {
          const id = actor.id,
            heirId = state.persons[String(id)]?.heirId ?? null;
          const preview = heirId === null ? null : successionPreview(current, id, heirId, tick);
          const canClaim =
            actor.nationId !== null &&
            decideLineageAction(current, id, { type: 'ruler.claim', nationId: actor.nationId }, tick).ok;
          return {
            generalId: id,
            active: lineageActive(current, id, tick),
            heirId,
            marriageCandidates: Object.values(current.generals)
              .filter((g) => g.id !== id && lineageAlive(current, g.id))
              .map((g) => ({
                generalId: g.id,
                failure: failureView(marriageProposalEligibility(current, id, g.id, tick), detailsVisible(g)),
              }))
              .sort((a, b) => Number(a.failure !== null) - Number(b.failure !== null) || a.generalId - b.generalId),
            heirCandidates: lineageDescendants(current, id, state.config.heir.depth).map((generalId) => ({
              generalId,
              failure: failureView(
                heirEligibility(current, id, generalId, tick),
                detailsVisible(current.generals[generalId]!),
              ),
            })),
            offers: state.offers
              .filter((row) => row.fromId === id || row.toId === id)
              .map((row) => ({
                ...row,
                householdGeneralId: row.fromId,
                householdCityKey: current.generals[row.fromId]!.cityKey,
              })),
            preview: preview?.ok ? preview.value : null,
            previewFailure: preview && !preview.ok ? preview : null,
            claim: canClaim ? { nationId: actor.nationId!, currentOfficerLevel: actor.officerLevel } : null,
          };
        })()
      : null;
  return {
    actorId: mine?.generalId ?? null,
    focusId: focusId ?? mine?.generalId ?? null,
    year: lineageYear(current, tick),
    startYear: current.startYear,
    cities: Object.values(current.cities)
      .sort((a, b) => a.cityKey - b.cityKey)
      .map((city) => ({ cityKey: city.cityKey, name: city.name })),
    people,
    nations,
    marriages: state.marriages.map((row) => ({ ...row })),
    mine,
  };
}
