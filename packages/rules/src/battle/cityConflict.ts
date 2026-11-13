import { z } from 'zod';
import type { WorldView } from '../model/world';
import type { InitialCity } from '../world/bootstrap';

export const CITY_CONFLICT_FEATURE = 'city-conflict-v1';
const conflict = z.record(z.string().regex(/^[1-9]\d*$/), z.number().positive().finite());

export function storedCityConflict(value: unknown) {
  return value == null ? {} : { conflict: conflict.parse(value) };
}

// core2026 c81d304, war/units/city.ts. MIT (c) 2025 devsam.
export function recordSiegeContribution(
  view: Pick<WorldView, 'ruleFeatures'>,
  city: InitialCity,
  nationId: number,
  damage: number,
) {
  if (!view.ruleFeatures?.includes(CITY_CONFLICT_FEATURE)) return;
  const current = city.conflict ?? {};
  const bonus = Object.keys(current).length === 0 || city.wall === 0 ? 1.05 : 1;
  current[nationId] = (current[nationId] ?? 0) + Math.max(1, damage) * bonus;
  city.conflict = current;
}

export function publicCityConflict(
  value: unknown,
  nations: ReadonlyMap<number, { id: number; name: string; color: string }>,
) {
  const entries = Object.entries(storedCityConflict(value).conflict ?? {})
    .flatMap(([id, score]) => {
      const nation = nations.get(Number(id));
      return nation ? [{ nation, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.nation.id - b.nation.id);
  if (entries.length < 2) return [];
  const total = entries.reduce((sum, { score }) => sum + score, 0);
  return entries.map(({ nation, score }) => ({
    id: nation.id,
    name: nation.name,
    color: nation.color,
    percent: Math.round((score * 1000) / total) / 10,
  }));
}
