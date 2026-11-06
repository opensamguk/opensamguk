import { readCampaignState } from '../campaign/state';
import { disbandCityGarrison } from '../cityResources/ownership';
import { removeNation } from '../commands/support';
import { reconcileGovernance } from '../governance/reconcile';
import { reconcileLineage } from '../lineage/reconcile';
import { cloneWorld } from '../model/clone';
import type { WorldState, WorldView } from '../model/world';
import { reconcileStratagemCards } from '../stratagemCards/state';
import { refreshSupply } from '../supply';
import { assertNationLifecycle, DISBAND_PERSONAL_LIMIT } from './state';

export interface NationLifecycleEffects {
  history: { nationId: number; text: string }[];
  reports: { generalId: number; text: string }[];
}

export class NationLifecycleRevisionLimitError extends Error {}

export function transferRulership(
  state: WorldState,
  nationId: number,
  fromId: number,
  toId: number,
): NationLifecycleEffects {
  const nation = state.nations[nationId]!,
    from = state.generals[fromId]!,
    to = state.generals[toId]!;
  from.officerLevel = 1;
  from.experience = Math.round(from.experience * 0.7);
  to.officerLevel = 12;
  nation.isNpc = to.userId === null;
  const text = `${from.name} → ${to.name} 선양`;
  return { history: [{ nationId, text }], reports: [{ generalId: toId, text }] };
}

// 명령 조건은 호출자가 검사하고 수동·월간·운영 해산은 같은 전이를 쓴다.
export function dissolveNation(state: WorldState, nationId: number): NationLifecycleEffects {
  const nation = state.nations[nationId];
  if (!nation) throw new Error('해산할 국가가 없습니다.');
  const members = Object.values(state.generals).filter((general) => general.nationId === nationId);
  const memberIds = new Set(members.map((general) => general.id));
  if (state.campaign) {
    const campaign = readCampaignState(state.campaign, state);
    let changed = false;
    for (const unit of campaign.units) {
      if (!memberIds.has(unit.ownerId)) continue;
      changed ||= unit.troops !== 0 || unit.train !== 0 || unit.atmos !== 0;
      unit.troops = unit.train = unit.atmos = 0;
    }
    if (changed) {
      if (campaign.revision === 2_147_483_647)
        throw new NationLifecycleRevisionLimitError('휘하 변경 번호 한도를 넘었습니다.');
      campaign.revision++;
    }
    state.campaign = campaign;
  }
  const cities = Object.values(state.cities).filter((city) => city.nationId === nationId);
  if (state.ruleFeatures?.includes('city-resources-v1'))
    for (const city of cities) {
      const ended = disbandCityGarrison(state, city.cityKey);
      state.cityResources = ended.state.cityResources!;
      city.population = ended.state.cities[city.cityKey]!.population;
    }
  removeNation(state, nationId);
  if (cities.length) refreshSupply(state);
  for (const general of members) {
    general.crew = general.train = general.atmos = 0;
    general.gold = Math.min(general.gold, DISBAND_PERSONAL_LIMIT);
    general.rice = Math.min(general.rice, DISBAND_PERSONAL_LIMIT);
  }
  if (state.nationLifecycle) delete state.nationLifecycle.nations[String(nationId)];
  if (state.campaign) readCampaignState(state.campaign, state);
  const text = `${nation.name} 해산`;
  return {
    history: [{ nationId, text }],
    reports: members.sort((a, b) => a.id - b.id).map((general) => ({ generalId: general.id, text })),
  };
}

export function reconcileNationLifecycle(world: WorldView, tick: number): WorldState {
  let state = cloneWorld(world);
  if (state.lineage) state = reconcileLineage(state, tick);
  if (state.governance) state = reconcileGovernance(state, tick);
  if (state.stratagemCards) state.stratagemCards = reconcileStratagemCards(state, state.stratagemCards, tick);
  assertNationLifecycle(state);
  return state;
}
