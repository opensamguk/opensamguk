import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { readCampaignState } from './state';

// 기존 이동·귀환·점령이 정한 거점만 쓴다. 별도 행군/거리/군량/중간 위치는 만들지 않는다.
// 함께 있던 실제 NPC 부장과 그가 지휘하는 병력만 따라가며 사람 휘하의 위치/예약은 바꾸지 않는다.
export function followCampaignCommanders(before: WorldView, after: WorldView) {
  const original = readCampaignState(before.campaign, before);
  const state = cloneWorld(after);
  state.campaign = readCampaignState(state.campaign, state, original.seed);
  const pending = Object.values(state.generals)
    .filter((general) => before.generals[general.id] && before.generals[general.id]!.cityKey !== general.cityKey)
    .map((general) => general.id);
  const queued = new Set(pending);
  for (let index = 0; index < pending.length; index++) {
    const owner = state.generals[pending[index]!]!;
    const previous = before.generals[owner.id]!;
    for (const unit of state.campaign.units) {
      if (unit.ownerId !== owner.id || unit.commanderId === owner.id || unit.troops <= 0) continue;
      const commander = state.generals[unit.commanderId]!,
        oldCommander = before.generals[unit.commanderId];
      if (!oldCommander || oldCommander.cityKey !== previous.cityKey || commander.cityKey !== oldCommander.cityKey)
        continue;
      if (commander.userId !== null) throw new Error('다른 사람의 위치를 부곡 이동으로 바꿀 수 없습니다.');
      commander.cityKey = owner.cityKey;
      if (!queued.has(commander.id)) {
        queued.add(commander.id);
        pending.push(commander.id);
      }
    }
  }
  readCampaignState(state.campaign, state, original.seed);
  return state;
}
