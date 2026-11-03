import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldState, WorldView } from '../model/world';
import { LINEAGE_MAX, lineageId, lineageQuantity } from './config';
import {
  heirEligibility,
  lineageActive,
  lineageFail,
  marriageEligibility,
  marriageProposalEligibility,
  type LineageFailure,
} from './eligibility';
import { reconcileLineage } from './reconcile';
import { emptyLineagePerson } from './state';
import { successionPreview, successionPreviewSchema } from './preview';
import { applySuccession } from './succession';
export type LineageInput = z.infer<typeof lineageInputSchema>;

export const lineageInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('succession.confirm'),
    heirGeneralId: lineageId,
    expected: successionPreviewSchema,
  }),
  z.strictObject({ type: z.literal('marriage.propose'), targetGeneralId: lineageId }),
  z.strictObject({ type: z.literal('marriage.respond'), offerId: lineageId, accept: z.boolean() }),
  z.strictObject({ type: z.literal('heir.designate'), heirGeneralId: lineageId.nullable() }),
  z.strictObject({ type: z.literal('ruler.claim'), nationId: lineageId }),
]);
export type LineageAction = z.infer<typeof lineageInputSchema>;
export type LineageResult = {
  action: LineageAction['type'];
  revision: number;
  tick: number;
  offerId?: number;
  marriageId?: number;
  householdGeneralId?: number;
  successorId?: number;
  nationId?: number;
};
export type LineageDecision = LineageFailure | { ok: true; world: WorldState; result: LineageResult };

export function decideLineageAction(
  world: WorldView,
  actorId: number,
  payload: unknown,
  tick: number,
): LineageDecision {
  if (!world.ruleFeatures?.includes('lineage-v1'))
    return lineageFail('FEATURE_DISABLED', '가문 기능을 켜지 않은 월드입니다.');
  if (!world.lineage) throw new Error('가문 상태가 없습니다.');
  const parsed = lineageInputSchema.safeParse(payload);
  if (!parsed.success) return lineageFail('BAD_ARGS', '가문 행동 인자가 잘못되었습니다.');
  if (
    !lineageQuantity.safeParse(tick).success ||
    tick < world.lineage.monthlyTick ||
    tick >= world.lineage.monthlyTick + TICKS_PER_MONTH
  )
    return lineageFail('BAD_TICK', '현재 월의 입력이 아닙니다.');
  if (world.lineage.revision === LINEAGE_MAX) return lineageFail('LIMIT', '가문 변경 번호 한도에 닿았습니다.');
  const next = reconcileLineage(world, tick),
    state = next.lineage!,
    actor = next.generals[actorId];
  if (state.revision === LINEAGE_MAX) return lineageFail('LIMIT', '가문 변경 번호 한도에 닿았습니다.');
  if (!lineageActive(next, actorId, tick) || actor!.userId === null)
    return lineageFail('NOT_OWNER', '등장한 생존 장수 본인만 행동할 수 있습니다.');
  const input = parsed.data;
  let offerId: number | undefined, marriageId: number | undefined, householdGeneralId: number | undefined;
  let successorId: number | undefined, nationId: number | undefined;
  const marry = (fromId: number, toId: number) => {
    const id = state.nextMarriageId++;
    state.marriages.push({
      id,
      a: Math.min(fromId, toId),
      b: Math.max(fromId, toId),
      householdGeneralId: fromId,
      sinceTick: tick,
    });
    marriageId = id;
    householdGeneralId = fromId;
  };
  switch (input.type) {
    case 'succession.confirm': {
      if (world.lineage!.persons[String(actorId)]?.heirId !== input.heirGeneralId)
        return lineageFail('NOT_DESIGNATED', '현재 지정한 후계자를 확인하세요.');
      const preview = successionPreview(next, actorId, input.heirGeneralId, tick);
      if (!preview.ok) return preview;
      if (JSON.stringify(preview.value) !== JSON.stringify(input.expected))
        return lineageFail('PREVIEW_CHANGED', '계승 미리보기가 바뀌었습니다. 다시 확인하세요.');
      const applied = applySuccession(next, actorId, input.heirGeneralId, 'HUMAN', tick);
      if (!applied.ok) return applied;
      applied.world.lineage!.revision = state.revision + 1;
      return {
        ok: true as const,
        world: applied.world,
        result: {
          action: input.type,
          revision: applied.world.lineage!.revision,
          tick,
          successorId: input.heirGeneralId,
        },
      };
    }
    case 'marriage.propose': {
      const targetId = input.targetGeneralId;
      const denied = marriageProposalEligibility(next, actorId, targetId, tick);
      if (denied) return denied;
      const target = next.generals[targetId]!;
      if (target.userId === null) {
        marry(actorId, targetId);
      } else {
        const expiresTick = tick + state.config.marriage.offerMonths * TICKS_PER_MONTH;
        offerId = state.nextOfferId++;
        state.offers.push({ id: offerId, fromId: actorId, toId: targetId, expiresTick });
      }
      break;
    }
    case 'marriage.respond': {
      const offer = state.offers.find((row) => row.id === input.offerId);
      if (!offer) return lineageFail('OFFER_CLOSED', '닫힌 혼인 제안입니다.');
      if (offer.toId !== actorId) return lineageFail('NOT_PARTY', '받은 제안에만 응답할 수 있습니다.');
      if (input.accept) {
        const denied = marriageEligibility(next, offer.fromId, offer.toId, tick);
        if (denied) return denied;
        if (state.nextMarriageId === LINEAGE_MAX) return lineageFail('LIMIT', '혼인 번호 한도에 닿았습니다.');
        marry(offer.fromId, offer.toId);
      }
      offerId = offer.id;
      state.offers = state.offers.filter((row) => row.id !== offer.id);
      break;
    }
    case 'heir.designate': {
      if (input.heirGeneralId !== null) {
        const denied = heirEligibility(next, actorId, input.heirGeneralId, tick);
        if (denied) return denied;
        successorId = input.heirGeneralId;
      }
      const person = state.persons[String(actorId)] ?? emptyLineagePerson();
      person.heirId = input.heirGeneralId;
      state.persons[String(actorId)] = person;
      break;
    }
    case 'ruler.claim': {
      nationId = input.nationId;
      if (actor!.nationId !== nationId) return lineageFail('NOT_MEMBER', '소속 국가의 공석에만 청구할 수 있습니다.');
      if (
        !next.nations[nationId] ||
        !Object.values(next.cities).some((city) => city.nationId === nationId && city.kind !== 'PASS')
      )
        return lineageFail('BAD_TARGET', '살아 있는 국가를 고르세요.');
      if (
        Object.values(next.generals).some(
          (general) =>
            general.nationId === nationId && general.officerLevel === 12 && lineageActive(next, general.id, tick),
        )
      )
        return lineageFail('NOT_VACANT', '현재 군주가 있습니다.');
      actor!.officerLevel = 12;
      next.nations[nationId]!.isNpc = false;
      break;
    }
  }
  state.revision++;
  return {
    ok: true as const,
    world: next,
    result: {
      action: input.type,
      revision: state.revision,
      tick,
      ...(offerId === undefined ? {} : { offerId }),
      ...(marriageId === undefined ? {} : { marriageId }),
      ...(householdGeneralId === undefined ? {} : { householdGeneralId }),
      ...(successorId === undefined ? {} : { successorId }),
      ...(nationId === undefined ? {} : { nationId }),
    },
  };
}
