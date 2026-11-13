import { BALANCE, campaignDefenders, canDefend, toGameDate, type WorldView } from '@opensamguk/rules';

type Garrison = {
  id: number;
  nationId: number | null;
  activeFromYear: number;
  crew: number;
  train: number;
  atmos: number;
};

export function cityDefense(
  city: { cityKey: number; nationId: number | null },
  generals: readonly Garrison[],
  startYear: number,
  tick: number,
  view?: WorldView,
) {
  const troopsByGeneral = new Map<number, number>();
  if (view?.campaign) {
    for (const unit of campaignDefenders(view, tick, city.cityKey)) {
      troopsByGeneral.set(unit.commanderId, (troopsByGeneral.get(unit.commanderId) ?? 0) + unit.troops);
    }
  } else if (city.nationId !== null) {
    const { year } = toGameDate(startYear, tick);
    for (const general of generals) {
      if (
        general.nationId === city.nationId &&
        general.activeFromYear <= year &&
        canDefend(general.crew, general.train, general.atmos)
      ) {
        troopsByGeneral.set(general.id, general.crew);
      }
    }
  }
  return {
    minimumTraining: BALANCE.DEFEND_TRAIN,
    minimumMorale: BALANCE.DEFEND_ATMOS,
    troops: [...troopsByGeneral.values()].reduce((sum, troops) => sum + troops, 0),
    generals: [...troopsByGeneral].sort(([a], [b]) => a - b).map(([generalId, troops]) => ({ generalId, troops })),
  };
}
