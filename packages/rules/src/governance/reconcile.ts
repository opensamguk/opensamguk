import { CITY_RESOURCE_MAX } from '../cityResources/state';
import { TICKS_PER_MONTH } from '../clock/constants';
import { cloneWorld } from '../model/clone';
import type { DeepReadonly, WorldState, WorldView } from '../model/world';
import { GOVERNANCE_OFFICES, readGovernanceConfig } from './config';
import { governanceRealmIndex } from './realm';
import { readGovernanceState, type GovernanceOffer, type GovernanceState } from './state';

export class GovernanceRevisionLimitError extends Error {
  constructor() {
    super('황실 변경 번호 한도를 넘었습니다.');
  }
}

function activeGeneral(world: WorldView, id: number, tick: number) {
  const general = world.generals[id];
  return general && general.activeFromYear <= world.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH))
    ? general
    : null;
}

function currentOffer(
  world: WorldView,
  state: DeepReadonly<GovernanceState>,
  index: ReturnType<typeof governanceRealmIndex>,
  offer: DeepReadonly<GovernanceOffer>,
  tick: number,
): boolean {
  if (
    offer.expiresTick <= tick ||
    !index.alive.has(offer.fromNationId) ||
    index.rulers.get(offer.fromNationId) !== offer.sourceMonarchId ||
    !activeGeneral(world, offer.actorId, tick)
  )
    return false;
  const emperor = state.throne.emperorNationId;
  if (offer.kind === 'COURT') {
    const target = activeGeneral(world, offer.targetGeneralId, tick);
    return (
      emperor === offer.fromNationId &&
      state.throne.emperorGeneralId === offer.sourceMonarchId &&
      offer.actorId === offer.sourceMonarchId &&
      target !== null &&
      target.nationId !== null &&
      index.alive.has(target.nationId) &&
      index.root(target.nationId).nationId === index.root(emperor).nationId
    );
  }
  if (!index.alive.has(offer.targetNationId)) return false;
  return offer.authority === 'OWN'
    ? offer.actorId === offer.sourceMonarchId
    : offer.direction === 'DEMAND' &&
        emperor === offer.fromNationId &&
        state.throne.emperorGeneralId === offer.sourceMonarchId &&
        (offer.actorId === state.throne.emperorGeneralId || offer.actorId === state.court.chancellor?.generalId);
}

export function assertGovernanceFinal(world: WorldView, tick: number): void {
  const state = world.governance;
  if (!world.ruleFeatures?.includes('governance-v1')) {
    if (state !== undefined) throw new Error('꺼진 황실 기능의 상태가 있습니다.');
    return;
  }
  if (!state) throw new Error('황실 상태가 없습니다.');
  readGovernanceConfig(state.config, world);
  const index = governanceRealmIndex(world, state, tick);
  if (
    index.parents.size !== state.vassals.length ||
    Object.keys(state.legitimacy).length !== index.alive.size ||
    [...index.alive].some((id) => state.legitimacy[String(id)] === undefined)
  )
    throw new Error('정리하지 않은 국가·봉신 계약이 있습니다.');
  if (state.vassals.some((row) => row.goldBp > state.config.tribute.maxBp || row.riceBp > state.config.tribute.maxBp))
    throw new Error('봉신 공납 비율이 원생성 상한을 넘었습니다.');
  const emperor = state.throne.emperorNationId;
  if (
    emperor !== null &&
    (index.rulers.get(emperor) !== state.throne.emperorGeneralId ||
      index.parents.has(emperor) ||
      world.cities[state.config.seatCityKey]?.nationId !== emperor)
  )
    throw new Error('황위가 현재 군주·소재 거점과 다릅니다.');
  const holders = new Set<number>();
  for (const office of GOVERNANCE_OFFICES) {
    const holder = state.court[office];
    if (!holder) continue;
    const general = activeGeneral(world, holder.generalId, tick);
    if (
      emperor === null ||
      holder.generalId === state.throne.emperorGeneralId ||
      !general ||
      general.nationId === null ||
      !index.alive.has(general.nationId) ||
      index.root(general.nationId).nationId !== index.root(emperor).nationId ||
      holders.has(holder.generalId)
    )
      throw new Error('조정 직위가 현재 계열과 다르거나 중복됐습니다.');
    holders.add(holder.generalId);
  }
  const ids = new Set(state.vassals.map((row) => row.id));
  if (state.pendingRenounce.some((id) => !ids.has(id))) throw new Error('없는 계약의 봉신 이탈 요청입니다.');
  if (state.offers.length > state.config.limits.worldOffers) throw new Error('황실 제안의 월드 상한을 넘었습니다.');
  const sent = new Map<number, number>(),
    received = new Map<number, number>(),
    offices = new Set<string>();
  for (const offer of state.offers) {
    if (!currentOffer(world, state, index, offer, tick)) throw new Error('만료되거나 권한이 사라진 황실 제안입니다.');
    sent.set(offer.fromNationId, (sent.get(offer.fromNationId) ?? 0) + 1);
    if (offer.kind === 'VASSAL') {
      received.set(offer.targetNationId, (received.get(offer.targetNationId) ?? 0) + 1);
      if (offer.goldBp > state.config.tribute.maxBp || offer.riceBp > state.config.tribute.maxBp)
        throw new Error('제안 공납 비율이 원생성 상한을 넘었습니다.');
    } else {
      if (offices.has(offer.office)) throw new Error('같은 조정 직위에 제안이 중복됐습니다.');
      offices.add(offer.office);
    }
  }
  if (
    [...sent.values()].some((count) => count > state.config.limits.sentOffers) ||
    [...received.values()].some((count) => count > state.config.limits.receivedOffers)
  )
    throw new Error('황실 제안의 국가별 상한을 넘었습니다.');
}

export function reconcileGovernance(world: WorldView, tick: number): WorldState {
  const next = cloneWorld(world);
  if (!world.ruleFeatures?.includes('governance-v1')) {
    assertGovernanceFinal(world, tick);
    return next;
  }
  const state = readGovernanceState(world.governance),
    original = JSON.stringify(state);
  next.governance = state;
  let index = governanceRealmIndex(next, state, tick);
  state.vassals = state.vassals.filter(
    (row) =>
      index.parents.get(row.vassalNationId) === row.overlordNationId &&
      index.rulers.get(row.vassalNationId) === row.vassalMonarchId &&
      index.rulers.get(row.overlordNationId) === row.overlordMonarchId,
  );
  // 계열 내부 전쟁은 가장 아래 간선부터 끊는다. 외교 자체를 평화로 바꾸지 않는다.
  const wars = world.diplomacies
    .filter((row) => row.state === 'WAR' || row.state === 'DECLARED')
    .sort(
      (a, b) =>
        Math.min(a.nationA, a.nationB) - Math.min(b.nationA, b.nationB) ||
        Math.max(a.nationA, a.nationB) - Math.max(b.nationA, b.nationB),
    );
  for (const war of wars) {
    index = governanceRealmIndex(next, state, tick);
    if (
      !index.alive.has(war.nationA) ||
      !index.alive.has(war.nationB) ||
      war.nationA === war.nationB ||
      index.root(war.nationA).nationId !== index.root(war.nationB).nationId
    )
      continue;
    const ancestors = (nationId: number) => {
      const path = [nationId];
      for (let current = nationId; index.parents.has(current);) {
        current = index.parents.get(current)!;
        path.push(current);
      }
      return path;
    };
    const left = ancestors(war.nationA),
      right = ancestors(war.nationB),
      common = left.find((id) => right.includes(id))!;
    const below = new Set([...left.slice(0, left.indexOf(common)), ...right.slice(0, right.indexOf(common))]);
    const cut = state.vassals
      .filter((row) => below.has(row.vassalNationId))
      .sort((a, b) => index.root(b.vassalNationId).depth - index.root(a.vassalNationId).depth || a.id - b.id)[0];
    if (!cut) throw new Error('계열 내 전쟁의 봉신 경로가 없습니다.');
    state.vassals = state.vassals.filter((row) => row.id !== cut.id);
  }
  index = governanceRealmIndex(next, state, tick);
  state.legitimacy = Object.fromEntries(
    [...index.alive].sort((a, b) => a - b).map((id) => [String(id), state.legitimacy[String(id)] ?? 0]),
  );
  const crown = state.throne;
  if (
    crown.emperorNationId !== null &&
    (index.rulers.get(crown.emperorNationId) !== crown.emperorGeneralId ||
      index.parents.has(crown.emperorNationId) ||
      world.cities[state.config.seatCityKey]?.nationId !== crown.emperorNationId)
  )
    state.throne = { emperorGeneralId: null, emperorNationId: null, sinceTick: tick };
  const emperor = state.throne.emperorNationId;
  for (const office of GOVERNANCE_OFFICES) {
    const holder = state.court[office];
    if (!holder) continue;
    const general = activeGeneral(next, holder.generalId, tick);
    if (
      emperor === null ||
      holder.generalId === state.throne.emperorGeneralId ||
      !general ||
      general.nationId === null ||
      !index.alive.has(general.nationId) ||
      index.root(general.nationId).nationId !== index.root(emperor).nationId
    )
      state.court[office] = null;
  }
  const ids = new Set(state.vassals.map((row) => row.id));
  state.pendingRenounce = state.pendingRenounce.filter((id) => ids.has(id));
  state.offers = state.offers.filter((offer) => currentOffer(next, state, index, offer, tick));
  state.censuredAt = Object.fromEntries(
    Object.entries(state.censuredAt).filter(
      ([id, at]) => index.alive.has(Number(id)) && tick - at < state.config.censureCooldownMonths * TICKS_PER_MONTH,
    ),
  );
  state.npcOfferAt = Object.fromEntries(
    Object.entries(state.npcOfferAt).filter(([key, at]) => {
      const [from, to] = key.split(':').map(Number);
      return (
        from !== to &&
        index.alive.has(from!) &&
        index.alive.has(to!) &&
        tick - at < state.config.npc.cooldownMonths * TICKS_PER_MONTH
      );
    }),
  );
  if (JSON.stringify(state) !== original) {
    if (state.revision === CITY_RESOURCE_MAX) throw new GovernanceRevisionLimitError();
    state.revision++;
  }
  assertGovernanceFinal(next, tick);
  return next;
}
