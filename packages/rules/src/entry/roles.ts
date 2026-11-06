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

export function recommendNations(world: WorldView, generalId: number, tick: number) {
  const general = world.generals[generalId];
  if (!general) return [];
  const cities = new Map<number, number>();
  for (const city of Object.values(world.cities))
    if (city.nationId !== null) cities.set(city.nationId, (cities.get(city.nationId) ?? 0) + 1);
  const rows = Object.values(world.nations).flatMap((nation) => {
    const ruler = Object.values(world.generals)
      .filter(
        (person) =>
          person.nationId === nation.id && person.officerLevel === 12 && lineageActive(world, person.id, tick),
      )
      .sort((a, b) => a.id - b.id)[0];
    if (!ruler) return [];
    const gap = Math.abs(general.affinity - ruler.affinity);
    return [
      {
        ...nation,
        cities: cities.get(nation.id) ?? 0,
        distance: general.affinity === 999 || ruler.affinity === 999 ? null : Math.min(gap, 150 - gap),
      },
    ];
  });
  // 상성 자료가 빠진 국가가 있으면 목록 전체를 도시 수로 정렬해 비교 순서를 일관되게 둔다.
  const affinity = rows.every((row) => row.distance !== null);
  return rows
    .sort((a, b) => (affinity ? a.distance! - b.distance! : 0) || b.cities - a.cities || a.id - b.id)
    .map(({ id, name, color, distance }) => ({
      id,
      name,
      color,
      reason: affinity ? `상성 거리가 ${distance}입니다.` : '상성 자료가 없어 도시 수로 골랐습니다.',
    }));
}
