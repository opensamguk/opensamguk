import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldState, WorldView } from '../model/world';
import { refreshSupply } from '../supply';
import type { TreatyClause } from './treatyTypes';

export const EXPANDED_TREATY_FEATURE = 'treaty-expanded';

export function isExpandedTreatyClause(clause: TreatyClause): boolean {
  return clause.kind === 'passage' || clause.kind === 'tribute' || clause.kind === 'cityTransfer';
}

export function validTreatyTargets(
  state: WorldView,
  from: number,
  to: number,
  clauses: readonly TreatyClause[],
): boolean {
  const isParty = (nationId: number | null) => nationId === from || nationId === to;
  return clauses.every((clause) => {
    if (clause.kind === 'passage')
      return clause.cityKeys.every((key) => {
        const city = state.cities[key];
        return city && city.kind !== 'PASS' && isParty(city.nationId);
      });
    if (clause.kind === 'tribute') return isParty(clause.payerNationId);
    if (clause.kind !== 'cityTransfer') return true;
    const giver = state.nations[clause.giverNationId];
    const city = state.cities[clause.cityKey];
    const capital = giver?.capitalCityKey == null ? undefined : state.cities[giver.capitalCityKey];
    return (
      isParty(clause.giverNationId) &&
      city?.nationId === clause.giverNationId &&
      city.kind !== 'PASS' &&
      city.cityKey !== giver?.capitalCityKey &&
      capital?.nationId === clause.giverNationId
    );
  });
}

export function hasTreatyPassage(state: WorldView, nationId: number, cityKey: number, tick: number): boolean {
  if (!state.ruleFeatures?.includes(EXPANDED_TREATY_FEATURE)) return false;
  const owner = state.cities[cityKey]?.nationId;
  if (owner == null || owner === nationId) return false;
  const lower = Math.min(nationId, owner);
  const higher = Math.max(nationId, owner);
  const relation = state.diplomacies.find((row) => row.nationA === lower && row.nationB === higher);
  if (relation?.state === 'WAR' || relation?.state === 'DECLARED') return false;
  return (state.treaties ?? []).some(
    (row) =>
      row.status === 'ACTIVE' &&
      row.startTick !== null &&
      row.startTick <= tick &&
      Math.min(row.fromNationId, row.toNationId) === lower &&
      Math.max(row.fromNationId, row.toNationId) === higher &&
      row.clauses.some(
        (clause) =>
          clause.kind === 'passage' &&
          clause.months !== undefined &&
          tick < row.startTick! + clause.months * TICKS_PER_MONTH &&
          clause.cityKeys.includes(cityKey),
      ),
  );
}

export function returnExpiredVisitors(before: WorldView, state: WorldState, tick: number): void {
  for (const treaty of before.treaties ?? []) {
    if (treaty.status !== 'ACTIVE' || treaty.startTick === null) continue;
    const passage = treaty.clauses.find((clause) => clause.kind === 'passage');
    if (passage?.months === undefined) continue;
    const end = treaty.startTick + passage.months * TICKS_PER_MONTH;
    if (end <= tick - TICKS_PER_MONTH) continue;
    if (end > tick && state.treaties?.some((row) => row.id === treaty.id)) continue;
    for (const general of Object.values(state.generals)) {
      const owner = state.cities[general.cityKey]?.nationId;
      const visitor = general.nationId;
      if (
        general.removedAt !== undefined ||
        visitor === null ||
        !passage.cityKeys.includes(general.cityKey) ||
        !(
          (owner === treaty.fromNationId && visitor === treaty.toNationId) ||
          (owner === treaty.toNationId && visitor === treaty.fromNationId)
        ) ||
        hasTreatyPassage(state, visitor, general.cityKey, tick)
      )
        continue;
      const capital = state.nations[visitor]?.capitalCityKey;
      if (capital != null && state.cities[capital]?.nationId === visitor) general.cityKey = capital;
    }
  }
}

export function executeCityTransfer(
  state: WorldState,
  from: number,
  to: number,
  clauses: readonly TreatyClause[],
): void {
  const transfer = clauses.find((clause) => clause.kind === 'cityTransfer');
  if (!transfer) return;
  const { cityKey, giverNationId } = transfer;
  const capital = state.nations[giverNationId]!.capitalCityKey!;
  state.cities[cityKey]!.nationId = giverNationId === from ? to : from;
  for (const general of Object.values(state.generals)) {
    if (general.removedAt === undefined && general.nationId === giverNationId && general.cityKey === cityKey)
      general.cityKey = capital;
  }
  refreshSupply(state);
}

// 월간 정산에서만 부른다. 수락 이후 첫 월 경계부터 지정된 개월 수만큼 이체한다.
export function payMonthlyTribute(state: WorldState, tick: number): void {
  for (const treaty of state.treaties ?? []) {
    if (treaty.status !== 'ACTIVE' || treaty.startTick === null || tick <= treaty.startTick) continue;
    const tribute = treaty.clauses.find((clause) => clause.kind === 'tribute');
    if (!tribute || tick > treaty.startTick + tribute.months * TICKS_PER_MONTH) continue;
    const payer = state.nations[tribute.payerNationId];
    const receiver =
      state.nations[tribute.payerNationId === treaty.fromNationId ? treaty.toNationId : treaty.fromNationId];
    if (!payer || !receiver) continue;
    for (const resource of ['gold', 'rice'] as const) {
      const amount = tribute[resource];
      if (payer[resource] < amount || receiver[resource] > 2_147_483_647 - amount) continue;
      payer[resource] -= amount;
      receiver[resource] += amount;
    }
  }
}
