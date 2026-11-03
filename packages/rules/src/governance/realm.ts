import { TICKS_PER_MONTH } from '../clock/constants';
import type { DeepReadonly, WorldView } from '../model/world';
import type { GovernanceState } from './state';

export function governanceMonarchs(world: WorldView, tick: number): Map<number, number | null> {
  const year = world.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
  const rulers = new Map<number, number | null>();
  for (const general of Object.values(world.generals)) {
    if (general.nationId === null || general.officerLevel !== 12 || general.activeFromYear > year) continue;
    rulers.set(general.nationId, rulers.has(general.nationId) ? null : general.id);
  }
  return rulers;
}

// 서명한 군주가 바뀐 계약은 효력이 없다. 저장 구조는 월·입력 뒤 reconcile이 정리한다.
export function governanceRealmIndex(world: WorldView, state: DeepReadonly<GovernanceState>, tick: number) {
  const rulers = governanceMonarchs(world, tick),
    alive = new Set<number>();
  for (const city of Object.values(world.cities))
    if (city.nationId !== null && world.nations[city.nationId]) alive.add(city.nationId);
  const parents = new Map<number, number>();
  for (const row of state.vassals) {
    if (
      !alive.has(row.vassalNationId) ||
      !alive.has(row.overlordNationId) ||
      rulers.get(row.vassalNationId) !== row.vassalMonarchId ||
      rulers.get(row.overlordNationId) !== row.overlordMonarchId
    )
      continue;
    if (row.vassalNationId === row.overlordNationId || parents.has(row.vassalNationId))
      throw new Error('봉신 계약에 자기 종속 또는 중복 상위 국가가 있습니다.');
    parents.set(row.vassalNationId, row.overlordNationId);
  }
  const root = (nationId: number) => {
    const seen = new Set<number>();
    let current = nationId,
      depth = 0;
    for (;;) {
      if (seen.has(current)) throw new Error('봉신 계약에 순환 종속이 있습니다.');
      seen.add(current);
      const parent = parents.get(current);
      if (parent === undefined) return { nationId: current, depth };
      if (depth >= state.config.maxDepth) throw new Error('봉신 계약이 월드의 깊이 상한을 넘었습니다.');
      current = parent;
      depth++;
    }
  };
  // 손상된 다른 계열을 조회 순서에 따라 허용하지 않는다.
  for (const id of alive) root(id);
  return { alive, rulers, parents, root };
}

export function governanceUnionError(
  world: WorldView,
  state: DeepReadonly<GovernanceState>,
  overlordNationId: number,
  vassalNationId: number,
  tick: number,
): string | null {
  const index = governanceRealmIndex(world, state, tick);
  if (!index.alive.has(overlordNationId) || !index.alive.has(vassalNationId) || overlordNationId === vassalNationId)
    return 'BAD_TARGET';
  if (index.parents.has(vassalNationId)) return 'ALREADY_VASSAL';
  const upper = index.root(overlordNationId),
    lower = index.root(vassalNationId);
  if (upper.nationId === lower.nationId) return 'CYCLE';
  let height = 0;
  for (const id of index.alive) {
    const branch = index.root(id);
    if (branch.nationId === lower.nationId) height = Math.max(height, branch.depth);
  }
  if (upper.depth + 1 + height > state.config.maxDepth) return 'DEPTH_LIMIT';
  const upperMembers = new Set<number>(),
    lowerMembers = new Set<number>();
  for (const id of index.alive) {
    const root = index.root(id).nationId;
    if (root === upper.nationId) upperMembers.add(id);
    if (root === lower.nationId) lowerMembers.add(id);
  }
  for (const row of world.diplomacies) {
    if (row.state !== 'WAR' && row.state !== 'DECLARED') continue;
    if (
      (upperMembers.has(row.nationA) && lowerMembers.has(row.nationB)) ||
      (lowerMembers.has(row.nationA) && upperMembers.has(row.nationB))
    )
      return 'REALM_AT_WAR';
  }
  return null;
}
