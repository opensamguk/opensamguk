import type { WorldView, WorldState } from './model/world';
import { countyUndefended } from './cityAffiliation';
import { hasTreatyPassage } from './diplomacy/treatyClauses';

export interface CommandPath {
  cityKey: number;
  path: number[];
  turns: number;
  sweptCounties: number[];
  blockedBy: number | null;
}
function shortestPath(world: WorldView, from: number, to: number, allowed: (key: number) => boolean) {
  const queue = [[from]],
    visited = new Set([from]);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    for (const next of [...(world.cities[path.at(-1)!]?.connections ?? [])].sort((a, b) => a - b)) {
      if (visited.has(next) || !world.cities[next] || !allowed(next)) continue;
      const candidate = [...path, next];
      if (next === to) return candidate;
      visited.add(next);
      queue.push(candidate);
    }
  }
  return null;
}
export function commandMoveTargets(world: WorldView, generalId: number, tick = 0): CommandPath[] {
  const general = world.generals[generalId];
  if (!general || general.removedAt !== undefined) return [];
  const from = world.cities[general.cityKey];
  if (!from) return [];
  if (general.movePath?.length) {
    const path = [from.cityKey, ...general.movePath];
    return [
      {
        cityKey: path.at(-1)!,
        path,
        turns: Math.ceil(general.movePath.length / 2),
        sweptCounties: [],
        blockedBy: general.movePath.find((key) => world.cities[key]?.nationId !== general.nationId) ?? null,
      },
    ];
  }
  return Object.values(world.cities)
    .sort((a, b) => a.cityKey - b.cityKey)
    .flatMap((city) => {
      if (city.cityKey === from.cityKey) return [];
      const own = general.nationId !== null && city.nationId === general.nationId && from.nationId === general.nationId;
      const path =
        own && from.state != null
          ? shortestPath(world, from.cityKey, city.cityKey, (key) => world.cities[key]!.nationId === general.nationId)
          : from.connections.includes(city.cityKey) &&
              (city.nationId === null ||
                city.nationId === general.nationId ||
                (general.nationId !== null && hasTreatyPassage(world, general.nationId, city.cityKey, tick)))
            ? [from.cityKey, city.cityKey]
            : null;
      return path
        ? [{ cityKey: city.cityKey, path, turns: Math.ceil((path.length - 1) / 2), sweptCounties: [], blockedBy: null }]
        : [];
    });
}
export function commandAttackTargets(world: WorldView, generalId: number): CommandPath[] {
  const general = world.generals[generalId];
  if (!general || general.removedAt !== undefined || general.nationId === null) return [];
  const from = world.cities[general.cityKey];
  if (!from || from.nationId !== general.nationId) return [];
  return Object.values(world.cities)
    .sort((a, b) => a.cityKey - b.cityKey)
    .flatMap((city) => {
      if (city.nationId === general.nationId) return [];
      if (from.connections.includes(city.cityKey))
        return [
          { cityKey: city.cityKey, path: [from.cityKey, city.cityKey], turns: 1, sweptCounties: [], blockedBy: null },
        ];
      if (city.state == null || city.kind !== 'CITY' || city.level < 5 || city.nationId === null) return [];
      const eligible = (key: number) =>
        key === city.cityKey ||
        (world.cities[key]!.parentCityKey === city.cityKey && world.cities[key]!.nationId === city.nationId);
      const path =
        shortestPath(
          world,
          from.cityKey,
          city.cityKey,
          (key) => eligible(key) && (key === city.cityKey || countyUndefended(world, key)),
        ) ?? shortestPath(world, from.cityKey, city.cityKey, eligible);
      if (!path) return [];
      const counties = path.slice(1, -1);
      const blockedBy = counties.find((key) => !countyUndefended(world, key)) ?? null;
      return [{ cityKey: city.cityKey, path, turns: 1, sweptCounties: counties, blockedBy }];
    });
}

export function moveStep(world: WorldView, generalId: number, cityKey: number, tick: number) {
  const general = world.generals[generalId]!;
  const pending = general.movePath?.length
    ? [general.cityKey, ...general.movePath]
    : commandMoveTargets(world, generalId, tick).find((target) => target.cityKey === cityKey)?.path;
  if (!pending) return null;
  let index = 1;
  while (index < pending.length && index <= 2) {
    const next = world.cities[pending[index]!]!;
    if (!world.cities[pending[index - 1]!]!.connections.includes(next.cityKey)) break;
    if (
      (general.movePath?.length || pending.length > 2) &&
      (general.nationId === null || next.nationId !== general.nationId)
    )
      break;
    index++;
  }
  return {
    blocked: index < pending.length && index <= 2,
    path: pending.slice(0, index),
    destination: pending[index - 1]!,
    remaining: index === 3 ? pending.slice(index) : [],
  };
}
export function applyMoveStep(world: WorldState, generalId: number, cityKey: number, tick: number) {
  const step = moveStep(world, generalId, cityKey, tick);
  if (!step) throw new Error('이동 경로가 없습니다.');
  const general = world.generals[generalId]!;
  general.cityKey = step.destination;
  if (step.remaining.length) general.movePath = step.remaining;
  else delete general.movePath;
  return step;
}
