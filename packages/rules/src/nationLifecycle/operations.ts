import { readCampaignState } from '../campaign/state';
import { removeNation } from '../commands/support';
import { reconcileGovernance } from '../governance/reconcile';
import { reconcileLineage } from '../lineage/reconcile';
import { cloneWorld } from '../model/clone';
import type { WorldState, WorldView } from '../model/world';
import { reconcileStratagemCards } from '../stratagemCards/state';
import { assertNationLifecycle, DISBAND_PERSONAL_LIMIT } from './state';

export interface NationLifecycleEffects {
  history: { nationId: number; text: string }[];
  reports: { generalId: number; text: string }[];
}

// 수동·월간 해산은 같은 상태 전이를 쓰고 저장은 엔진에 맡긴다.
export function dissolveNation(state: WorldState, nationId: number): NationLifecycleEffects {
  const nation = state.nations[nationId];
  if (!nation || !state.nationLifecycle?.nations[String(nationId)]) throw new Error('해산할 방랑 국가가 없습니다.');
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
      if (campaign.revision === 2_147_483_647) throw new Error('휘하 변경 번호 한도를 넘었습니다.');
      campaign.revision++;
    }
    state.campaign = campaign;
  }
  removeNation(state, nationId);
  for (const general of members) {
    general.crew = general.train = general.atmos = 0;
    general.gold = Math.min(general.gold, DISBAND_PERSONAL_LIMIT);
    general.rice = Math.min(general.rice, DISBAND_PERSONAL_LIMIT);
  }
  delete state.nationLifecycle.nations[String(nationId)];
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
