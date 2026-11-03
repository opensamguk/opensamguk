import { z } from 'zod';
import { CITY_RESOURCE_MAX } from '../cityResources/state';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldView } from '../model/world';
import { GOVERNANCE_OFFICES, governanceId, governanceQuantity } from './config';
import { governanceRealmIndex, governanceUnionError } from './realm';
import { reconcileGovernance } from './reconcile';
import type { GovernanceOffer } from './state';

const office = z.enum(GOVERNANCE_OFFICES);
export const governanceInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('throne.ascend') }),
  z.strictObject({ type: z.literal('throne.abdicate') }),
  z.strictObject({
    type: z.literal('vassal.offer'),
    authority: z.enum(['OWN', 'EMPIRE']),
    targetNationId: governanceId,
    direction: z.enum(['DEMAND', 'REQUEST']),
    goldBp: governanceQuantity.max(10_000),
    riceBp: governanceQuantity.max(10_000),
  }),
  z.strictObject({ type: z.literal('vassal.respond'), offerId: governanceId, accept: z.boolean() }),
  z.strictObject({ type: z.literal('vassal.release'), vassalId: governanceId }),
  z.strictObject({ type: z.literal('vassal.renounce'), vassalId: governanceId }),
  z.strictObject({ type: z.literal('court.offer'), office, generalId: governanceId }),
  z.strictObject({ type: z.literal('court.respond'), offerId: governanceId, accept: z.boolean() }),
  z.strictObject({ type: z.literal('court.dismiss'), office }),
  z.strictObject({ type: z.literal('court.resign') }),
  z.strictObject({ type: z.literal('court.remit'), vassalId: governanceId, months: governanceId.max(12) }),
  z.strictObject({ type: z.literal('court.censure'), nationId: governanceId }),
]);
export type GovernanceInput = z.infer<typeof governanceInputSchema>;
const deny = (code: string, message: string) => ({ ok: false as const, code, message });

// 세션·제재 검사는 호출 경계에서 한다. 이 함수는 사람과 NPC에 같은 현재 권한을 적용한다.
export function decideGovernanceAction(world: WorldView, actorId: number, payload: unknown, tick: number) {
  if (!world.ruleFeatures?.includes('governance-v1'))
    return deny('FEATURE_DISABLED', '황실 기능을 켜지 않은 월드입니다.');
  if (!world.governance) throw new Error('황실 상태가 없습니다.');
  const parsed = governanceInputSchema.safeParse(payload);
  if (!parsed.success) return deny('BAD_ARGS', '황실 행동 인자가 잘못되었습니다.');
  if (
    !governanceQuantity.safeParse(tick).success ||
    tick < world.governance.monthlyTick ||
    tick >= world.governance.monthlyTick + TICKS_PER_MONTH
  )
    return deny('BAD_TICK', '현재 월의 입력이 아닙니다.');
  if (world.governance.revision === CITY_RESOURCE_MAX) return deny('LIMIT', '황실 변경 번호 한도에 닿았습니다.');
  let next = reconcileGovernance(world, tick);
  if (next.governance!.revision === CITY_RESOURCE_MAX) return deny('LIMIT', '황실 변경 번호 한도에 닿았습니다.');
  const state = next.governance!,
    actor = next.generals[actorId],
    index = governanceRealmIndex(next, state, tick);
  if (!actor || actor.activeFromYear > next.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH)))
    return deny('NO_ACTOR', '등장한 장수가 아닙니다.');
  const nationId = actor.nationId;
  if (nationId === null || !index.alive.has(nationId)) return deny('NOT_NATION', '살아 있는 국가에 소속되어야 합니다.');
  const monarch = index.rulers.get(nationId) === actorId;
  const emperor = state.throne.emperorGeneralId === actorId;
  const empireNation = state.throne.emperorNationId;
  const appointed = (key: (typeof GOVERNANCE_OFFICES)[number]) => state.court[key]?.generalId === actorId;
  const args = parsed.data;
  let reference: { offerId?: number; vassalId?: number } = {};
  const union = (upper: number, lower: number) => {
    if (lower === empireNation) return 'EMPEROR_BOUND';
    if (!index.rulers.get(upper) || !index.rulers.get(lower)) return 'NO_MONARCH';
    return governanceUnionError(next, state, upper, lower, tick);
  };
  const offerRoom = (from: number, target?: number) =>
    state.nextOfferId < CITY_RESOURCE_MAX &&
    state.offers.length < state.config.limits.worldOffers &&
    state.offers.filter((row) => row.fromNationId === from).length < state.config.limits.sentOffers &&
    (target === undefined ||
      state.offers.filter((row) => row.kind === 'VASSAL' && row.targetNationId === target).length <
        state.config.limits.receivedOffers) &&
    tick + state.config.offerMonths * TICKS_PER_MONTH <= CITY_RESOURCE_MAX;
  switch (args.type) {
    case 'throne.ascend':
      if (!monarch) return deny('NO_AUTHORITY', '군주만 즉위할 수 있습니다.');
      if (state.throne.emperorGeneralId !== null) return deny('THRONE_OCCUPIED', '이미 황제가 있습니다.');
      if (index.parents.has(nationId)) return deny('ALREADY_VASSAL', '봉신 국가는 즉위할 수 없습니다.');
      if (next.cities[state.config.seatCityKey]?.nationId !== nationId)
        return deny('NO_SEAT', '천자 소재 거점을 확보해야 합니다.');
      if ((state.legitimacy[String(nationId)] ?? 0) < state.config.legitimacy.ascendAt)
        return deny('NO_LEGITIMACY', '즉위할 정통성이 부족합니다.');
      state.throne = { emperorGeneralId: actorId, emperorNationId: nationId, sinceTick: tick };
      break;
    case 'throne.abdicate':
      if (!emperor) return deny('NO_AUTHORITY', '황제 본인만 퇴위할 수 있습니다.');
      state.throne = { emperorGeneralId: null, emperorNationId: null, sinceTick: tick };
      state.court = { chancellor: null, grandMarshal: null, minister: null };
      break;
    case 'vassal.offer': {
      const from = args.authority === 'OWN' ? nationId : empireNation;
      if (
        (args.authority === 'OWN' && !monarch) ||
        (args.authority === 'EMPIRE' && ((!emperor && !appointed('chancellor')) || args.direction !== 'DEMAND')) ||
        from === null
      )
        return deny('NO_AUTHORITY', '선택한 출처 국가를 대행할 권한이 없습니다.');
      if (args.goldBp > state.config.tribute.maxBp || args.riceBp > state.config.tribute.maxBp)
        return deny('BAD_RATE', '월드의 공납 상한을 넘었습니다.');
      const upper = args.direction === 'DEMAND' ? from : args.targetNationId;
      const lower = args.direction === 'DEMAND' ? args.targetNationId : from;
      const error = union(upper, lower);
      if (error) return deny(error, '현재 계열·외교 조건에서는 봉신 계약을 제안할 수 없습니다.');
      if (!offerRoom(from, args.targetNationId)) return deny('LIMIT', '미결 제안 한도에 닿았습니다.');
      const id = state.nextOfferId++;
      state.offers.push({
        id,
        kind: 'VASSAL',
        authority: args.authority,
        fromNationId: from,
        sourceMonarchId: index.rulers.get(from)!,
        actorId,
        targetNationId: args.targetNationId,
        direction: args.direction,
        goldBp: args.goldBp,
        riceBp: args.riceBp,
        expiresTick: tick + state.config.offerMonths * TICKS_PER_MONTH,
      });
      reference = { offerId: id };
      break;
    }
    case 'vassal.respond':
    case 'court.respond': {
      const offer = state.offers.find((row) => row.id === args.offerId);
      if (!offer || (offer.kind === 'VASSAL') !== (args.type === 'vassal.respond'))
        return deny('NOT_FOUND', '유효한 제안이 없습니다.');
      if (offer.kind === 'VASSAL' ? !monarch || nationId !== offer.targetNationId : actorId !== offer.targetGeneralId)
        return deny('NOT_PARTY', '제안을 받은 당사자만 응답할 수 있습니다.');
      if (args.accept && offer.kind === 'VASSAL') {
        const upper = offer.direction === 'DEMAND' ? offer.fromNationId : offer.targetNationId;
        const lower = offer.direction === 'DEMAND' ? offer.targetNationId : offer.fromNationId;
        const error = union(upper, lower);
        if (error) return deny(error, '현재 계열·외교 조건에서는 봉신 계약을 수락할 수 없습니다.');
        if (state.nextVassalId >= CITY_RESOURCE_MAX) return deny('LIMIT', '계약 번호 한도에 닿았습니다.');
        const id = state.nextVassalId++;
        state.vassals.push({
          id,
          vassalNationId: lower,
          overlordNationId: upper,
          vassalMonarchId: index.rulers.get(lower)!,
          overlordMonarchId: index.rulers.get(upper)!,
          goldBp: offer.goldBp,
          riceBp: offer.riceBp,
          sinceTick: tick,
          remitUntilTick: 0,
        });
        reference = { vassalId: id };
      } else if (args.accept && offer.kind === 'COURT') {
        if (
          actorId === state.throne.emperorGeneralId ||
          GOVERNANCE_OFFICES.some((key) => state.court[key]?.generalId === actorId)
        )
          return deny('ALREADY_OFFICE', '이미 황제 또는 조정 직위를 맡고 있습니다.');
        state.court[offer.office] = { generalId: actorId, appointedTick: tick };
      }
      state.offers = state.offers.filter((row) => row.id !== offer.id);
      reference = { ...reference, offerId: offer.id };
      break;
    }
    case 'vassal.release':
    case 'vassal.renounce':
    case 'court.remit': {
      const row = state.vassals.find((entry) => entry.id === args.vassalId);
      if (!row) return deny('NOT_FOUND', '봉신 계약이 없습니다.');
      let ownBranch = false;
      for (let current: number | undefined = nationId; current !== undefined; current = index.parents.get(current))
        if (current === row.vassalNationId) {
          ownBranch = true;
          break;
        }
      if (args.type === 'vassal.renounce') {
        if (!monarch || nationId !== row.vassalNationId)
          return deny('NOT_PARTY', '봉신 군주만 이탈을 요청할 수 있습니다.');
        if (state.pendingRenounce.includes(row.id)) return deny('ALREADY_PENDING', '이미 이탈을 요청했습니다.');
        state.pendingRenounce.push(row.id);
      } else if (args.type === 'vassal.release') {
        if (
          !(monarch && nationId === row.overlordNationId) &&
          !(appointed('chancellor') && row.overlordNationId === empireNation && !ownBranch)
        )
          return deny('NO_AUTHORITY', '이 계약을 해제할 권한이 없습니다.');
        state.vassals = state.vassals.filter((entry) => entry.id !== row.id);
      } else {
        if ((!emperor && (!appointed('minister') || ownBranch)) || row.overlordNationId !== empireNation)
          return deny('NO_AUTHORITY', '황제국의 직접 공납만 면제할 수 있습니다.');
        if (args.months > state.config.maxRemitMonths) return deny('BAD_ARGS', '공납 면제 기간 상한을 넘었습니다.');
        const until = tick + args.months * TICKS_PER_MONTH;
        if (until > CITY_RESOURCE_MAX) return deny('LIMIT', '공납 면제 기한 한도에 닿았습니다.');
        row.remitUntilTick = until;
      }
      reference = { vassalId: row.id };
      break;
    }
    case 'court.offer': {
      if (!emperor) return deny('NO_AUTHORITY', '황제만 조정 직위를 제안할 수 있습니다.');
      const target = next.generals[args.generalId];
      if (
        !target ||
        target.id === actorId ||
        target.nationId === null ||
        !index.alive.has(target.nationId) ||
        target.activeFromYear > next.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH)) ||
        index.root(target.nationId).nationId !== index.root(nationId).nationId
      )
        return deny('BAD_TARGET', '황제국 계열의 등장한 장수를 골라야 합니다.');
      if (GOVERNANCE_OFFICES.some((key) => state.court[key]?.generalId === target.id))
        return deny('ALREADY_OFFICE', '이미 조정 직위를 맡고 있습니다.');
      if (!offerRoom(nationId) || state.offers.some((row) => row.kind === 'COURT' && row.office === args.office))
        return deny('LIMIT', '해당 직위 또는 미결 제안 한도에 닿았습니다.');
      const id = state.nextOfferId++;
      const offer: GovernanceOffer = {
        id,
        kind: 'COURT',
        fromNationId: nationId,
        sourceMonarchId: actorId,
        actorId,
        targetGeneralId: target.id,
        office: args.office,
        expiresTick: tick + state.config.offerMonths * TICKS_PER_MONTH,
      };
      state.offers.push(offer);
      reference = { offerId: id };
      break;
    }
    case 'court.dismiss':
      if (!emperor) return deny('NO_AUTHORITY', '황제만 조정 직위를 해임할 수 있습니다.');
      if (!state.court[args.office]) return deny('NOT_FOUND', '비어 있는 직위입니다.');
      state.court[args.office] = null;
      break;
    case 'court.resign': {
      const key = GOVERNANCE_OFFICES.find(appointed);
      if (!key) return deny('NOT_PARTY', '맡고 있는 조정 직위가 없습니다.');
      state.court[key] = null;
      break;
    }
    case 'court.censure': {
      if (!emperor && !appointed('grandMarshal')) return deny('NO_AUTHORITY', '황제 또는 대장군만 견책할 수 있습니다.');
      if (!index.alive.has(args.nationId) || index.root(args.nationId).nationId === index.root(nationId).nationId)
        return deny('BAD_TARGET', '황제국 계열 밖의 국가만 견책할 수 있습니다.');
      const last = state.censuredAt[String(args.nationId)];
      if (last !== undefined && tick - last < state.config.censureCooldownMonths * TICKS_PER_MONTH)
        return deny('COOLDOWN', '아직 같은 국가를 다시 견책할 수 없습니다.');
      state.legitimacy[String(args.nationId)] = Math.max(
        0,
        state.legitimacy[String(args.nationId)]! - state.config.legitimacy.censureLoss,
      );
      state.censuredAt[String(args.nationId)] = tick;
      break;
    }
  }
  next = reconcileGovernance(next, tick);
  if (next.governance!.revision === CITY_RESOURCE_MAX) return deny('LIMIT', '황실 변경 번호 한도에 닿았습니다.');
  next.governance!.revision++;
  return {
    ok: true as const,
    state: next,
    result: { action: args.type, revision: next.governance!.revision, tick, ...reference },
  };
}
