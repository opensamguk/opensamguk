import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldView } from '../model/world';
import { LINEAGE_EXITED_YEAR, LINEAGE_MAX } from './config';

export function marriageProposalEligibility(
  world: WorldView,
  fromId: number,
  toId: number,
  tick: number,
): LineageFailure | null {
  const denied = marriageEligibility(world, fromId, toId, tick);
  if (denied) return denied;
  const state = world.lineage!,
    from = world.generals[fromId]!,
    to = world.generals[toId]!;
  if (
    state.offers.some(
      (row) => (row.fromId === fromId && row.toId === toId) || (row.toId === fromId && row.fromId === toId),
    )
  )
    return lineageFail('OFFER_PENDING', '이 상대와의 제안에 먼저 응답하세요.');
  if (to.userId === null) {
    if (to.nationId !== from.nationId || Math.abs(to.affinity - from.affinity) > state.config.marriage.npc.affinityGap)
      return lineageFail('NPC_REFUSED', 'NPC의 소속·친화 조건에 맞지 않습니다.');
    if (state.nextMarriageId === LINEAGE_MAX) return lineageFail('LIMIT', '혼인 번호 한도에 닿았습니다.');
  } else {
    const limits = state.config.limits;
    if (
      state.nextOfferId === LINEAGE_MAX ||
      tick + state.config.marriage.offerMonths * TICKS_PER_MONTH > LINEAGE_MAX ||
      state.offers.length >= limits.worldOffers ||
      state.offers.filter((row) => row.fromId === fromId).length >= limits.sentOffers ||
      state.offers.filter((row) => row.toId === toId).length >= limits.receivedOffers
    )
      return lineageFail('LIMIT', '혼인 제안 상한에 닿았습니다.');
  }
  return null;
}

export type LineageFailure = { ok: false; code: string; message: string; reason?: string };
export const lineageFail = (code: string, message: string): LineageFailure => ({ ok: false, code, message });
export const lineageYear = (world: WorldView, tick: number) =>
  world.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
export const lineageAge = (world: WorldView, id: number, tick: number) =>
  Math.max(0, lineageYear(world, tick) - world.generals[id]!.birthYear);
export const lineageAlive = (world: WorldView, id: number) =>
  !!world.generals[id] &&
  world.generals[id]!.activeFromYear !== LINEAGE_EXITED_YEAR &&
  !world.lineage?.persons[String(id)]?.exit;
export const lineageActive = (world: WorldView, id: number, tick: number) =>
  lineageAlive(world, id) && world.generals[id]!.activeFromYear <= lineageYear(world, tick);

export function lineageDescendants(world: WorldView, id: number, depth: number): number[] {
  const seen = new Set<number>([id]),
    result: number[] = [];
  let generation = [id];
  for (let level = 0; level < depth && generation.length; level++) {
    const parents = new Set(generation);
    generation = Object.entries(world.lineage?.persons ?? {})
      .filter(([key, value]) => !seen.has(Number(key)) && value.parents.some((parent) => parents.has(parent)))
      .map(([key]) => Number(key))
      .sort((a, b) => a - b);
    for (const child of generation) {
      seen.add(child);
      result.push(child);
    }
  }
  return result;
}

function ancestors(world: WorldView, id: number, depth: number) {
  const found = new Set<number>([id]);
  let generation = [id];
  for (let level = 0; level < depth; level++) {
    generation = generation
      .flatMap((current) => [...(world.lineage?.persons[String(current)]?.parents ?? [])])
      .filter((parent) => !found.has(parent));
    for (const parent of generation) found.add(parent);
  }
  return found;
}

export function marriageEligibility(world: WorldView, a: number, b: number, tick: number): LineageFailure | null {
  const state = world.lineage;
  if (!state) return lineageFail('FEATURE_DISABLED', '가문 기능을 사용하는 판이 아닙니다.');
  if (a === b) return lineageFail('SELF', '자기 자신과 혼인할 수 없습니다.');
  if (!lineageActive(world, a, tick) || !lineageActive(world, b, tick))
    return lineageFail('BAD_TARGET', '등장한 생존 장수를 고르세요.');
  const { minAge, maxAge, kinDepth, maxSpouses } = state.config.marriage;
  const sexes = [world.generals[a]!.sex, world.generals[b]!.sex];
  if (sexes.some((sex) => sex === undefined || sex === 'UNKNOWN'))
    return lineageFail('SEX_UNKNOWN', '성별 자료가 확인된 장수끼리 혼인할 수 있습니다.');
  if (sexes[0] === sexes[1]) return lineageFail('SEX_PAIR', '남녀 장수끼리 혼인할 수 있습니다.');
  if ([a, b].some((id) => lineageAge(world, id, tick) < minAge || lineageAge(world, id, tick) > maxAge))
    return lineageFail('AGE', '월드의 혼인 나이 조건에 맞지 않습니다.');
  const left = ancestors(world, a, kinDepth),
    right = ancestors(world, b, kinDepth);
  if ([...left].some((id) => right.has(id))) return lineageFail('KIN', '가까운 혈연끼리는 혼인할 수 없습니다.');
  if (state.marriages.some((row) => [row.a, row.b].includes(a) && [row.a, row.b].includes(b)))
    return lineageFail('ALREADY_MARRIED', '이미 혼인한 상대입니다.');
  if ([a, b].some((id) => state.marriages.filter((row) => row.a === id || row.b === id).length >= maxSpouses))
    return lineageFail('ALREADY_MARRIED', '배우자 수 상한에 닿았습니다.');
  return null;
}

export function heirEligibility(world: WorldView, fromId: number, heirId: number, tick: number): LineageFailure | null {
  const deny = (reason: string, message: string): LineageFailure => ({
    ...lineageFail('HEIR_INELIGIBLE', message),
    reason,
  });
  const state = world.lineage;
  if (!state) return lineageFail('FEATURE_DISABLED', '가문 기능을 사용하는 판이 아닙니다.');
  if (fromId === heirId || !lineageActive(world, fromId, tick) || !lineageActive(world, heirId, tick))
    return deny('BAD_HEIR', '등장한 생존 후계자를 고르세요.');
  if (!lineageDescendants(world, fromId, state.config.heir.depth).includes(heirId))
    return deny('NOT_DESCENDANT', '월드의 범위 안에 있는 직계 자손을 고르세요.');
  if (world.generals[heirId]!.userId !== null) return deny('HEIR_CONTROLLED', '다른 사람이 조작하는 장수입니다.');
  if (world.generals[fromId]!.nationId !== world.generals[heirId]!.nationId)
    return deny('HEIR_NATION', '같은 국가의 후계자를 고르세요.');
  if (
    Object.entries(state.persons).some(
      ([id, person]) => Number(id) !== fromId && !person.exit && person.heirId === heirId,
    )
  )
    return deny('HEIR_RESERVED', '이미 다른 장수가 지정한 후계자입니다.');
  return null;
}
