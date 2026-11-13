import { z } from 'zod';
import type { WorldView } from '../model/world';
import type { InitialCity } from '../world/bootstrap';

export const CITY_CONFLICT_FEATURE = 'city-conflict-v1';
export const CITY_CONFLICT_AWARD_FEATURE = 'city-conflict-award-v1';
const conflict = z.record(z.string().regex(/^[1-9]\d*$/), z.number().positive().finite());

const conflictOrder = z.array(z.number().int().positive());

export function storedCityConflict(value: unknown, order?: unknown) {
  return {
    ...(value == null ? {} : { conflict: conflict.parse(value) }),
    ...(order == null ? {} : { conflictOrder: conflictOrder.parse(order) }),
  };
}

function rankedContributors(scores: Readonly<Record<string, number>>, order: readonly number[] = []) {
  const preferred = new Map(order.map((id, index) => [id, index]));
  return Object.keys(scores)
    .map(Number)
    .sort(
      (a, b) => scores[b]! - scores[a]! || (preferred.get(a) ?? Infinity) - (preferred.get(b) ?? Infinity) || a - b,
    );
}

// core2026 c81d304, war/units/city.ts. MIT (c) 2025 devsam.
export function recordSiegeContribution(
  view: Pick<WorldView, 'ruleFeatures'>,
  city: InitialCity,
  nationId: number,
  damage: number,
) {
  if (!view.ruleFeatures?.includes(CITY_CONFLICT_FEATURE)) return;
  const current = { ...city.conflict };
  const bonus = Object.keys(current).length === 0 || city.wall === 0 ? 1.05 : 1;
  current[nationId] = (current[nationId] ?? 0) + Math.max(1, damage) * bonus;
  city.conflict = current;
  if (view.ruleFeatures.includes(CITY_CONFLICT_AWARD_FEATURE))
    city.conflictOrder = rankedContributors(current, city.conflictOrder);
}

// core2026 c81d304, war/aftermath.ts and war/utils.ts. MIT (c) 2025 devsam.
export function settleCityConflict(
  view: Pick<WorldView, 'ruleFeatures' | 'nations'>,
  city: InitialCity,
  attackerNationId: number,
  history: { nationId: number; text: string }[],
) {
  const recipient = view.ruleFeatures?.includes(CITY_CONFLICT_AWARD_FEATURE)
    ? (rankedContributors(city.conflict ?? {}, city.conflictOrder).find(
        (id) => id !== city.nationId && view.nations[id],
      ) ?? attackerNationId)
    : attackerNationId;
  if (city.conflict) city.conflict = {};
  if (city.conflictOrder) city.conflictOrder = [];
  if (recipient !== attackerNationId) {
    const source = view.nations[attackerNationId]!.name;
    const target = view.nations[recipient]!.name;
    const text = `${city.name} 영토 분쟁에서 공성 기여가 앞선 ${target}에 양도 (${source} 공략)`;
    history.push({ nationId: attackerNationId, text }, { nationId: recipient, text });
  }
  return recipient;
}

export function publicCityConflict(
  value: unknown,
  nations: ReadonlyMap<number, { id: number; name: string; color: string }>,
  order?: unknown,
) {
  const stored = storedCityConflict(value, order);
  const scores = stored.conflict ?? {};
  const entries = rankedContributors(scores, stored.conflictOrder).flatMap((id) => {
    const nation = nations.get(id);
    return nation ? [{ nation, score: scores[id]! }] : [];
  });
  if (entries.length < 2) return [];
  const total = entries.reduce((sum, { score }) => sum + score, 0);
  return entries.map(({ nation, score }) => ({
    id: nation.id,
    name: nation.name,
    color: nation.color,
    percent: Math.round((score * 1000) / total) / 10,
  }));
}
