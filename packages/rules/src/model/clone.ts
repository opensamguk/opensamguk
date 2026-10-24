import type { PresetRules } from '../world/preset';
import { cloneExtStateWithRegistry, extSlices, extCommandBindings, type ExtStateRegistry } from '../commands/ext/state';
import type { WorldState, WorldView } from './world';

// 모든 가변 필드를 복제한다. 평평한 장수 수백 명을 매 턴 직렬화하지 않는다.
export function cloneWorld(view: WorldView): WorldState {
  return cloneWorldWithRegistry(view, { slices: extSlices, bindings: extCommandBindings });
}

export function cloneWorldWithRegistry(view: WorldView, registry: ExtStateRegistry): WorldState {
  const ext = Object.hasOwn(view, 'ext') ? cloneExtStateWithRegistry(view.ext, registry) : undefined;
  const cities: WorldState['cities'] = {};
  const nations: WorldState['nations'] = {};
  const generals: WorldState['generals'] = {};
  for (const key in view.cities) {
    const city = view.cities[key]!;
    cities[key] = { ...city, connections: [...city.connections] };
  }
  for (const key in view.nations) nations[key] = { ...view.nations[key]! };
  for (const key in view.generals) generals[key] = { ...view.generals[key]! };
  return {
    ...(ext ? { ext } : {}),
    ...(view.presetRules ? { presetRules: structuredClone(view.presetRules) as PresetRules } : {}),
    ...(view.ruleFeatures ? { ruleFeatures: [...view.ruleFeatures] } : {}),
    startYear: view.startYear,
    cities,
    nations,
    generals,
    diplomacies: view.diplomacies.map((d) => ({ ...d })),
    ...(view.commandMeta
      ? { commandMeta: { nextNationId: view.commandMeta.nextNationId, offers: { ...view.commandMeta.offers } } }
      : {}),
    ...(view.nationTurns
      ? { nationTurns: structuredClone(view.nationTurns) as NonNullable<WorldState['nationTurns']> }
      : {}),
  };
}
