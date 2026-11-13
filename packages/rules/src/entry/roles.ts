import type { InitialGeneral } from '../world/bootstrap';
import type { WorldView } from '../model/world';
import { lineageActive } from '../lineage/eligibility';

export type EntryRole = 'ruler' | 'core' | 'retainer' | 'free';
export function classifyRole(
  general: Pick<InitialGeneral, 'nationId' | 'officerLevel' | 'leadership' | 'strength' | 'intel'>,
): EntryRole {
  if (general.nationId === null) return 'free';
  if (general.officerLevel === 12) return 'ruler';
  return (general.officerLevel >= 2 && general.officerLevel <= 11) ||
    Math.max(general.leadership, general.strength, general.intel) >= 65
    ? 'core'
    : 'retainer';
}

export function nationRecommendations(world: WorldView, tick: number) {
  const cities = new Map<number, number>();
  for (const city of Object.values(world.cities))
    if (city.nationId !== null) cities.set(city.nationId, (cities.get(city.nationId) ?? 0) + 1);
  const rulers = new Map<number, WorldView['generals'][number]>();
  for (const general of Object.values(world.generals)) {
    if (general.nationId === null || general.officerLevel !== 12 || !lineageActive(world, general.id, tick)) continue;
    const existing = rulers.get(general.nationId);
    if (!existing || general.id < existing.id) rulers.set(general.nationId, general);
  }
  const candidates = Object.values(world.nations).flatMap((nation) => {
    const ruler = rulers.get(nation.id);
    return ruler ? [{ ...nation, cities: cities.get(nation.id) ?? 0, affinity: ruler.affinity }] : [];
  });
  return (generalId: number) => {
    const general = world.generals[generalId];
    if (!general) return [];
    const rows = candidates.map(({ affinity, ...nation }) => {
      const gap = Math.abs(general.affinity - affinity);
      return { ...nation, distance: general.affinity === 999 || affinity === 999 ? null : Math.min(gap, 150 - gap) };
    });
    // 상성 자료가 빠진 국가가 있으면 목록 전체를 도시 수로 정렬한다.
    const affinity = rows.every((row) => row.distance !== null);
    return rows
      .sort((a, b) => (affinity ? a.distance! - b.distance! : 0) || b.cities - a.cities || a.id - b.id)
      .map(({ id, name, color, distance }) => ({
        id,
        name,
        color,
        reason: affinity ? `상성 거리가 ${distance}입니다.` : '상성 자료가 없어 도시 수로 골랐습니다.',
      }));
  };
}

export function recommendNations(world: WorldView, generalId: number, tick: number) {
  return nationRecommendations(world, tick)(generalId);
}
