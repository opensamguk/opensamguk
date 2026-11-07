import { lineageAlive } from '../lineage/eligibility';
import { cloneWorld } from '../model/clone';
import type { WorldState } from '../model/world';
import { monthlyDate } from '../monthly';
import type { HistoricEventsConfig, HistoricEventsState } from './state';

const MAX_STORED_RESOURCE = 2_147_483_647;

export function applyHistoricDomesticEffects(
  world: WorldState,
  config: HistoricEventsConfig,
  resolved: HistoricEventsState['done'],
): WorldState {
  let next = world;
  for (const { id, nationId, choice, resolvedTick } of resolved) {
    if (choice === null) continue;
    const row = config.events.find((event) => event.id === id);
    if (!row || row.chooser.nationId !== nationId || !next.nations[nationId])
      throw new Error('역사 사건의 효과 대상을 확인하세요.');
    const { year } = monthlyDate(world.startYear, resolvedTick);
    for (const effect of row.options[choice].effects) {
      if (effect.kind === 'nonAggression') continue;
      if (next === world) next = cloneWorld(world);
      if (effect.kind === 'atmos') {
        for (const general of Object.values(next.generals)) {
          if (general.nationId === nationId && general.activeFromYear <= year && lineageAlive(next, general.id)) {
            general.atmos = Math.max(0, Math.min(100, general.atmos + effect.value));
          }
        }
      } else {
        const nation = next.nations[nationId]!;
        const field = effect.kind;
        nation[field] = Math.max(0, Math.min(MAX_STORED_RESOURCE, nation[field] + effect.value));
      }
    }
  }
  return next;
}
