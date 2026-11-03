import { TICKS_PER_MONTH } from '../clock/constants';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { decideGovernanceAction, type GovernanceInput } from './actions';
import { GOVERNANCE_OFFICES } from './config';
import { governanceRealmIndex } from './realm';

type AppliedAction = Extract<ReturnType<typeof decideGovernanceAction>, { ok: true }>;
export type GovernanceNpcAction = { actorId: number; payload: GovernanceInput; result: AppliedAction['result'] };

function npcContext(world: WorldView, tick: number) {
  if (!world.governance) throw new Error('NPC 황실 상태가 없습니다.');
  const index = governanceRealmIndex(world, world.governance, tick);
  const cities = new Map<number, number>();
  for (const city of Object.values(world.cities))
    if (city.nationId !== null && city.kind !== 'PASS') cities.set(city.nationId, (cities.get(city.nationId) ?? 0) + 1);
  const isNpc = (generalId: number | null | undefined) =>
    generalId !== null && generalId !== undefined && world.generals[generalId]?.userId === null;
  const stronger = (upper: number, lower: number) =>
    (cities.get(lower) ?? 0) > 0 &&
    (cities.get(upper) ?? 0) >= (cities.get(lower) ?? 0) * world.governance!.config.npc.cityRatio &&
    (world.governance!.legitimacy[String(upper)] ?? 0) >= (world.governance!.legitimacy[String(lower)] ?? 0);
  return { ...index, cities, isNpc, stronger };
}

export function respondGovernanceNpcOffers(world: WorldView, tick: number) {
  let state = cloneWorld(world);
  const actions: GovernanceNpcAction[] = [];
  const offers = [...state.governance!.offers].sort((a, b) => a.id - b.id);
  for (const offer of offers) {
    if (!state.governance!.offers.some((current) => current.id === offer.id)) continue;
    const context = npcContext(state, tick);
    const actorId = offer.kind === 'COURT' ? offer.targetGeneralId : context.rulers.get(offer.targetNationId);
    if (!actorId || !context.isNpc(actorId)) continue;
    const upper = offer.kind === 'VASSAL' && offer.direction === 'REQUEST' ? offer.targetNationId : offer.fromNationId;
    const lower =
      offer.kind === 'VASSAL' ? (offer.direction === 'REQUEST' ? offer.fromNationId : offer.targetNationId) : 0;
    const accept =
      offer.kind === 'COURT' ||
      (context.stronger(upper, lower) &&
        offer.goldBp <= state.governance!.config.npc.acceptMaxBp &&
        offer.riceBp <= state.governance!.config.npc.acceptMaxBp);
    let payload: Extract<GovernanceInput, { type: 'court.respond' | 'vassal.respond' }> = {
      type: offer.kind === 'COURT' ? 'court.respond' : 'vassal.respond',
      offerId: offer.id,
      accept,
    };
    let outcome = decideGovernanceAction(state, actorId, payload, tick);
    if (!outcome.ok && accept) {
      payload = { ...payload, accept: false };
      outcome = decideGovernanceAction(state, actorId, payload, tick);
    }
    if (outcome.ok) {
      state = outcome.state;
      actions.push({ actorId, payload, result: outcome.result });
    }
  }
  return { state, actions };
}

export function ascendGovernanceNpc(world: WorldView, tick: number) {
  const context = npcContext(world, tick);
  const owner = world.cities[world.governance!.config.seatCityKey]?.nationId;
  const actorId = owner === null || owner === undefined ? undefined : context.rulers.get(owner);
  const payload = { type: 'throne.ascend' } as const;
  const outcome = actorId && context.isNpc(actorId) ? decideGovernanceAction(world, actorId, payload, tick) : null;
  return outcome?.ok
    ? { state: outcome.state, actions: [{ actorId: actorId!, payload, result: outcome.result }] }
    : { state: cloneWorld(world), actions: [] };
}

// NPC는 공개 도시 수·정통성·고정 비율만 본다. 한 국가에서 월 제안은 하나다.
export function proposeGovernanceNpcOffers(world: WorldView, tick: number) {
  let state = cloneWorld(world);
  const actions: GovernanceNpcAction[] = [];
  const nationIds = [...npcContext(state, tick).alive].sort((a, b) => a - b);
  for (const nationId of nationIds) {
    const context = npcContext(state, tick),
      gov = state.governance!;
    const actorId = context.rulers.get(nationId);
    if (!actorId || !context.isNpc(actorId)) continue;
    if (
      gov.offers.length >= gov.config.limits.worldOffers ||
      gov.offers.filter((offer) => offer.fromNationId === nationId).length >= gov.config.limits.sentOffers
    )
      continue;
    const candidates: GovernanceInput[] = [];
    if (gov.throne.emperorGeneralId === actorId) {
      const office = GOVERNANCE_OFFICES.find(
        (key) => !gov.court[key] && !gov.offers.some((offer) => offer.kind === 'COURT' && offer.office === key),
      );
      const year = state.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
      const target = office
        ? Object.values(state.generals)
            .filter(
              (general) =>
                general.id !== actorId &&
                general.nationId === nationId &&
                general.userId === null &&
                general.activeFromYear <= year &&
                !GOVERNANCE_OFFICES.some((key) => gov.court[key]?.generalId === general.id) &&
                !gov.offers.some((offer) => offer.kind === 'COURT' && offer.targetGeneralId === general.id),
            )
            .sort((a, b) => b.officerLevel - a.officerLevel || a.id - b.id)[0]
        : undefined;
      if (office && target) candidates.push({ type: 'court.offer', office, generalId: target.id });
    }
    if (candidates.length === 0) {
      const targets = nationIds
        .filter(
          (id) =>
            id !== nationId &&
            context.rulers.get(id) &&
            context.root(id).nationId !== context.root(nationId).nationId &&
            !gov.offers.some(
              (offer) => offer.kind === 'VASSAL' && offer.fromNationId === nationId && offer.targetNationId === id,
            ) &&
            tick - (gov.npcOfferAt[`${nationId}:${id}`] ?? -Infinity) >=
              gov.config.npc.cooldownMonths * TICKS_PER_MONTH,
        )
        .sort((a, b) => (context.cities.get(b) ?? 0) - (context.cities.get(a) ?? 0) || a - b);
      for (const target of targets) {
        if (!context.stronger(nationId, target) && !context.stronger(target, nationId)) continue;
        candidates.push({
          type: 'vassal.offer',
          authority: 'OWN',
          targetNationId: target,
          direction: context.stronger(nationId, target) ? 'DEMAND' : 'REQUEST',
          goldBp: gov.config.npc.offerBp,
          riceBp: gov.config.npc.offerBp,
        });
      }
    }
    for (const payload of candidates) {
      const outcome = decideGovernanceAction(state, actorId, payload, tick);
      if (outcome.ok) {
        state = outcome.state;
        if (payload.type === 'vassal.offer')
          state.governance!.npcOfferAt[`${nationId}:${payload.targetNationId}`] = tick;
        actions.push({ actorId, payload, result: outcome.result });
        break;
      }
    }
  }
  return { state, actions };
}
