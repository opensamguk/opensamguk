import type { Actor } from '../commands/types';
import type { WorldView } from '../model/world';
import { cloneWorld } from '../model/clone';
import { TICKS_PER_MONTH } from '../clock/constants';
import { campaignAttackingUnits } from '../campaign/attack';
import { readCampaignState } from '../campaign/state';
import { cardQuantity } from './config';
import { incrementCardsRevision, readStratagemCardsState } from './state';

// 호출자는 실제 출병 검사를 먼저 통과한다. 함정 계산에는 난수를 쓰지 않는다.
export function triggerStratagemTrap(view: WorldView, actor: Actor, cityKey: number) {
  const tick = cardQuantity.parse(actor.tick ?? 0),
    cards = readStratagemCardsState(view.stratagemCards, view),
    nationId = view.generals[actor.generalId]?.nationId,
    city = view.cities[cityKey],
    defenderNation = city?.nationId;
  if (
    nationId === null ||
    nationId === undefined ||
    defenderNation === null ||
    defenderNation === undefined ||
    nationId === defenderNation
  )
    return null;
  const index = cards.nations[defenderNation]!.traps.findIndex((trap) => trap.cityKey === cityKey);
  if (index < 0) return null;
  const trap = cards.nations[defenderNation]!.traps[index]!;
  if (trap.setTick > tick) return null;
  if (cards.config.trapExpiryMonths !== null && tick >= trap.setTick + cards.config.trapExpiryMonths * TICKS_PER_MONTH)
    return null;
  if (view.ruleFeatures?.includes('campaign-v1') && cards.config.campaignLoss !== 'eligibleAll')
    throw Error('첫 부곡만 피해를 입는 규칙은 아직 지원하지 않습니다.');
  const state = cloneWorld(view);
  cards.nations[defenderNation]!.traps.splice(index, 1);
  incrementCardsRevision(cards);
  state.stratagemCards = cards;
  let crewLoss = 0,
    atmosLoss = 0,
    cancelled: boolean;
  const damage = (troops: number, atmos: number) => {
    const remaining = Math.round((troops * (10_000 - cards.config.trap.lossBp)) / 10_000),
      morale = Math.max(0, atmos - cards.config.trap.atmosLoss);
    crewLoss += troops - remaining;
    atmosLoss += atmos - morale;
    return { remaining, morale };
  };
  if (state.ruleFeatures?.includes('campaign-v1')) {
    const ids = new Set(campaignAttackingUnits(view, actor).map((unit) => unit.id)),
      campaign = readCampaignState(state.campaign, state);
    for (const unit of campaign.units)
      if (ids.has(unit.id)) {
        const { remaining, morale } = damage(unit.troops, unit.atmos);
        unit.troops = remaining;
        unit.atmos = morale;
      }
    if (crewLoss || atmosLoss) {
      if (campaign.revision === 2_147_483_647) throw Error('휘하 변경 번호 한도를 넘었습니다.');
      campaign.revision++;
    }
    state.campaign = readCampaignState(campaign, state);
    cancelled = campaignAttackingUnits(state, actor).length === 0;
  } else {
    const general = state.generals[actor.generalId]!,
      { remaining, morale } = damage(general.crew, general.atmos);
    general.crew = remaining;
    general.atmos = morale;
    cancelled = remaining === 0 || morale === 0;
  }
  return {
    state,
    cancelled,
    text: `${city!.name}: 함정에 걸려 병력 ${crewLoss}명, 사기 합계 ${atmosLoss}를 잃었습니다.`,
    history: [
      { nationId, text: `${city!.name}: 함정 발동, 병력 ${crewLoss}명 손실${cancelled ? ', 점령 실패' : ''}` },
      { nationId: defenderNation, text: `${city!.name}: 함정 발동` },
    ],
  };
}
