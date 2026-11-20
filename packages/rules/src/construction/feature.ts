import type { RuleFeatureDefinition } from '../ruleRegistry';
import { cloneWorld } from '../model/clone';
import { monthlyDate } from '../monthly/index';
import { build, demolish, readCityLand, sumLandCity, facilityCapacity } from './land';
import { buildingSpec, type BuildingSpec } from './catalog';
import { BALANCE } from '../balance';
import { battleBusy } from '../tactical/world';

export const constructionFeature: RuleFeatureDefinition = {
  key: 'construction-v1',
  requires: ['campaign-v1', 'logistics-v1'],
  conflicts: [],
  commandBindings: [
    { definition: build, sliceKeys: [] },
    { definition: demolish, sliceKeys: [] },
  ],
  settleMonthly({ settled, tick }) {
    if (!settled.state.campaign?.land) return { replay: settled, effects: [] };
    const state = cloneWorld(settled.state);
    state.campaign!.land = readCityLand(state);
    const month = monthlyDate(state.startYear, tick).month;
    const january = month === 1;
    for (const [key, rows] of Object.entries(state.campaign!.land.cities)) {
      state.campaign!.land.cities[key] = rows.filter((row) => !(january && row.building === 'black_market'));
      for (const row of state.campaign!.land.cities[key]!) {
        if (row.remainingTurns > 0 && --row.remainingTurns === 0) {
          row.score = Math.floor(facilityCapacity(state, Number(key), row.slotId, row.building) / 2);
          state.cities[Number(key)]!.populationMax += buildingSpec(row.building).population ?? 0;
        }
      }
      const active = state.campaign!.land.cities[key]!.filter((row) => !row.remainingTurns);
      const bonus = (field: keyof NonNullable<BuildingSpec['monthly']>) =>
        active.reduce((sum, row) => {
          const spec = buildingSpec(row.building);
          const festival = spec.festival;
          return (
            sum +
            (spec.monthly?.[field] ?? 0) +
            (festival?.month === month && (field === 'trust' || field === 'atmos') ? (festival[field] ?? 0) : 0)
          );
        }, 0);
      const city = state.cities[Number(key)]!;
      city.trust = Math.min(BALANCE.MAX_TRUST, city.trust + bonus('trust'));
      if (city.nationId !== null)
        state.nations[city.nationId]!.tech = Math.min(
          BALANCE.MAX_TECH,
          state.nations[city.nationId]!.tech + bonus('tech'),
        );
      for (const general of Object.values(state.generals).filter(
        (general) =>
          general.cityKey === Number(key) && general.nationId === city.nationId && general.removedAt === undefined,
      )) {
        general.injury = Math.max(0, general.injury - bonus('healing'));
        general.experience += bonus('experience');
      }
      for (const unit of state.campaign!.units.filter(
        (unit) =>
          state.generals[unit.commanderId]?.cityKey === Number(key) &&
          state.generals[unit.commanderId]?.nationId === city.nationId &&
          !battleBusy(state, { unitIds: [unit.id] }),
      )) {
        unit.train = Math.min(100, unit.train + bonus('train'));
        unit.atmos = Math.min(100, unit.atmos + bonus('atmos'));
      }
      sumLandCity(state, Number(key));
    }
    return { replay: { ...settled, state }, effects: [] };
  },
};
