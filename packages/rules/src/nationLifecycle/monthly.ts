import { TICKS_PER_MONTH } from '../clock/constants';
import { cloneWorld } from '../model/clone';
import { settleTreaties } from '../diplomacy/treaty';
import type { WorldView } from '../model/world';
import { dissolveNation, reconcileNationLifecycle, type NationLifecycleEffects } from './operations';
import { assertNationLifecycle, WANDERING_MONTH_LIMIT } from './state';

export function settleNationLifecycleMonthly(world: WorldView, tick: number) {
  assertNationLifecycle(world);
  const state = cloneWorld(world);
  const effects: NationLifecycleEffects = { history: [], reports: [] };
  for (const nationId of Object.keys(state.nationLifecycle!.nations)
    .map(Number)
    .sort((a, b) => a - b)) {
    if (tick < state.nationLifecycle!.nations[String(nationId)]!.sinceTick + WANDERING_MONTH_LIMIT * TICKS_PER_MONTH)
      continue;
    const removed = dissolveNation(state, nationId);
    effects.history.push(...removed.history);
    effects.reports.push(...removed.reports);
  }
  const final = effects.history.length ? reconcileNationLifecycle(state, tick) : state;
  return {
    state: effects.history.length && world.ruleFeatures?.includes('treaty') ? settleTreaties(final, tick) : final,
    effects,
  };
}
