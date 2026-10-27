// Eligibility and direct renown reuse the v1-derived hierarchy. See NOTICE.
import { rngFor } from '@opensamguk/shared';
import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import { cloneWorld } from '../model/clone';
import type { WorldState, WorldView } from '../model/world';
import { buildRetinueHierarchy, INITIAL_RENOWN_CAPACITY } from './retinue';
import { campaignPeople, readCampaignState, retinueRelationSchema, type CampaignState } from './state';

const integer = z.number().int().min(0).max(2_147_483_647),
  id = integer.min(1);
export const campaignRelationshipInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('offer'), targetId: id, relation: retinueRelationSchema, revision: integer }),
  z.strictObject({ type: z.literal('respond'), offerId: id, accept: z.boolean(), revision: integer }),
  z.strictObject({ type: z.literal('release'), personId: id, revision: integer }),
]);
export type CampaignRelationshipInput = z.infer<typeof campaignRelationshipInputSchema>;
export type CampaignRelationshipResult = {
  accepted: boolean | null;
  offerId: number | null;
  cost: number;
  chance: number | null;
  roll: number | null;
  revision: number;
};
type Outcome =
  | { ok: true; state: WorldState; campaign: CampaignState; result: CampaignRelationshipResult }
  | { ok: false; code: string; message: string };
const deny = (code: string, message: string): Extract<Outcome, { ok: false }> => ({ ok: false, code, message });

function eligible(
  world: WorldView,
  campaign: CampaignState,
  masterId: number,
  personId: number,
  relation: 'STAFF' | 'LIEUTENANT' | 'GUEST',
  tick: number,
) {
  const master = world.generals[masterId],
    person = world.generals[personId];
  if (
    !master ||
    !person ||
    master.id === person.id ||
    master.nationId === null ||
    !world.nations[master.nationId] ||
    (person.nationId !== null && person.nationId !== master.nationId) ||
    person.officerLevel === 12 ||
    person.activeFromYear > world.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH))
  )
    return deny('BAD_TARGET', '같은 국가 또는 재야의 군주 외 장수만 제안할 수 있습니다.');
  if (!world.cities[master.cityKey] || master.cityKey !== person.cityKey)
    return deny('MUST_ASSEMBLE', '같은 도시 또는 관문에 모여야 합니다.');
  if (campaign.links.some((link) => link.personId === personId))
    return deny('ALREADY_BOUND', '이미 직속 상관이 있습니다.');
  const subtree = buildRetinueHierarchy(campaignPeople(world, campaign), campaign.links).subtree(personId);
  if (subtree.includes(masterId)) return deny('RETINUE_CYCLE', '휘하 관계가 순환할 수 없습니다.');
  if (
    person.nationId !== master.nationId &&
    subtree.some((childId) => childId !== personId && world.generals[childId]!.userId !== null)
  )
    return deny('HUMAN_CONSENT_REQUIRED', '사람 휘하의 출사는 각자 수락해야 합니다.');
  const joined = { ...world, generals: { ...world.generals } };
  for (const childId of subtree) joined.generals[childId] = { ...world.generals[childId]!, nationId: master.nationId };
  const tree = buildRetinueHierarchy(campaignPeople(joined, campaign), [
    ...campaign.links,
    { masterId, personId, relation },
  ]);
  if (!tree.withinCapacity(masterId, INITIAL_RENOWN_CAPACITY))
    return deny('RENOWN_CAPACITY', '직속 휘하의 명망 수용량이 부족합니다.');
  return { ok: true as const, subtree };
}

// Session ownership and sanctions are supplied by the engine; this function changes no external state.
export function applyCampaignRelationship(
  world: WorldView,
  value: unknown,
  actorId: number,
  campaignValue: unknown,
  context: { tick: number; userId: string; userActive: boolean },
): Outcome {
  const campaign = readCampaignState(campaignValue, world);
  const parsed = campaignRelationshipInputSchema.safeParse(value);
  if (!parsed.success) return deny('BAD_INPUT', '휘하 입력을 확인하세요.');
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 || context.tick > 2_147_483_647)
    throw new Error('휘하 입력의 처리 tick을 확인하세요.');
  const actor = world.generals[actorId];
  if (!context.userActive || !actor || !context.userId || actor.userId !== context.userId)
    return deny('ACTOR_INACTIVE', '활성 계정의 자기 장수만 조작할 수 있습니다.');
  if (parsed.data.revision !== campaign.revision) return deny('STALE_REVISION', '휘하 현황을 다시 불러오세요.');
  if (campaign.revision === 2_147_483_647) return deny('REVISION_LIMIT', '휘하 변경 번호 한도를 넘었습니다.');
  const input = parsed.data,
    next = structuredClone(campaign),
    state = cloneWorld(world);
  let accepted: boolean | null = null,
    offerId: number | null = null,
    cost = 0,
    chance: number | null = null,
    roll: number | null = null;
  const attach = (
    masterId: number,
    personId: number,
    relation: 'STAFF' | 'LIEUTENANT' | 'GUEST',
    subtree: number[],
  ) => {
    const nationId = state.generals[masterId]!.nationId;
    for (const childId of subtree) {
      const child = state.generals[childId]!;
      if (child.nationId === null) {
        child.nationId = nationId;
        child.officerLevel = 1;
      }
    }
    next.links.push({ masterId, personId, relation });
    for (const offer of next.offers)
      if (offer.personId === personId && offer.status === 'PENDING') offer.status = 'CANCELLED';
  };
  if (input.type === 'offer') {
    const assessment = eligible(world, campaign, actorId, input.targetId, input.relation, context.tick);
    if (!assessment.ok) return assessment;
    const target = world.generals[input.targetId]!;
    if (target.userId !== null) {
      if (
        next.offers.some(
          (offer) => offer.masterId === actorId && offer.personId === target.id && offer.status === 'PENDING',
        )
      )
        return deny('OFFER_PENDING', '같은 인물의 응답을 기다리는 중입니다.');
      if (next.nextOfferId === 2_147_483_647) return deny('ID_LIMIT', '휘하 제안 번호 한도를 넘었습니다.');
      offerId = next.nextOfferId++;
      next.offers.push({
        id: offerId,
        masterId: actorId,
        personId: target.id,
        relation: input.relation,
        status: 'PENDING',
        createdTick: context.tick,
      });
    } else {
      const month = Math.floor(context.tick / TICKS_PER_MONTH);
      if (
        next.attempts.some(
          (attempt) => attempt.masterId === actorId && attempt.personId === target.id && attempt.month >= month,
        )
      )
        return deny('ALREADY_ATTEMPTED', '같은 NPC에게는 장수별 게임 월 1회만 서약할 수 있습니다.');
      if (actor.gold < 500) return deny('NO_GOLD', 'NPC 서약에 금500이 필요합니다.');
      cost = 500;
      chance = 25 + Math.floor(actor.charm! / 2);
      roll = rngFor(campaign.seed, 'campaign.pledge', month, actorId, target.id).int(1, 100);
      accepted = roll <= chance;
      state.generals[actorId]!.gold -= cost;
      next.attempts = next.attempts.filter((attempt) => attempt.masterId !== actorId || attempt.personId !== target.id);
      next.attempts.push({ masterId: actorId, personId: target.id, month });
      if (accepted) attach(actorId, target.id, input.relation, assessment.subtree);
    }
  } else if (input.type === 'respond') {
    const offer = next.offers.find((offer) => offer.id === input.offerId);
    if (!offer || offer.personId !== actorId) return deny('NOT_ALLOWED', '자신에게 온 제안만 응답할 수 있습니다.');
    if (offer.status !== 'PENDING') return deny('OFFER_CLOSED', '이미 처리한 휘하 제안입니다.');
    if (input.accept) {
      const assessment = eligible(world, campaign, offer.masterId, actorId, offer.relation, context.tick);
      if (!assessment.ok) return assessment;
      attach(offer.masterId, actorId, offer.relation, assessment.subtree);
    }
    offer.status = input.accept ? 'ACCEPTED' : 'REJECTED';
    accepted = input.accept;
    offerId = offer.id;
  } else {
    const link = next.links.find(
      (link) => link.personId === input.personId && (link.masterId === actorId || link.personId === actorId),
    );
    if (!link) return deny('NOT_ALLOWED', '자신의 직속 관계만 해제할 수 있습니다.');
    if (
      next.units.some((unit) => unit.ownerId === link.masterId && unit.commanderId === link.personId && unit.troops > 0)
    )
      return deny('COMMANDER_IN_USE', '먼저 지휘 중인 부곡을 본인에게 돌려야 합니다.');
    next.links = next.links.filter((row) => row.personId !== link.personId);
    for (const unit of next.units)
      if (unit.ownerId === link.masterId && unit.commanderId === link.personId) unit.commanderId = unit.ownerId;
  }
  next.revision++;
  readCampaignState(next, state, campaign.seed);
  return {
    ok: true,
    state,
    campaign: next,
    result: { accepted, offerId, cost, chance, roll, revision: next.revision },
  };
}
