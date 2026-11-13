import type { ReplayState } from '../replay';
import { hasRareEquipment } from '../equipment/config';
import { readCampaignState } from '../campaign/state';
import { reconcileLineage, LineageRevisionLimitError } from '../lineage/reconcile';
import { reconcileGovernance, GovernanceRevisionLimitError } from '../governance/reconcile';

// 기록 참조는 남기고 활동·조작권·소속과 지휘 관계만 해제한다.
export function removeAdminGeneral(replay: ReplayState, generalId: number, tick: number): boolean {
  const world = replay.state;
  const general = world.generals[generalId]!;
  const campaign = world.campaign;
  const lineage = world.lineage;
  if (campaign) {
    readCampaignState(campaign, world);
    if (campaign.revision === 2_147_483_647) return false;
    const units = campaign.units.filter((unit) => unit.ownerId === generalId || unit.commanderId === generalId);
    for (const unit of units) {
      const city = world.cities[world.generals[unit.commanderId]!.cityKey]!;
      city.population = Math.min(city.populationMax, city.population + unit.troops);
    }
    const removed = new Set(units.map((unit) => unit.id));
    campaign.units = campaign.units.filter((unit) => !removed.has(unit.id));
    campaign.links = campaign.links.filter((link) => link.masterId !== generalId && link.personId !== generalId);
    for (const offer of campaign.offers)
      if (offer.status === 'PENDING' && (offer.masterId === generalId || offer.personId === generalId))
        offer.status = 'CANCELLED';
    for (const order of campaign.orders?.items ?? [])
      if (
        ['PENDING', 'READY'].includes(order.status) &&
        (order.issuerId === generalId || order.recipientId === generalId)
      ) {
        order.status = 'CANCELLED';
        order.resolvedTick = tick;
        order.result = '운영 조치로 장수가 퇴장하여 취소되었습니다.';
      }
    campaign.revision++;
  } else {
    const city = world.cities[general.cityKey]!;
    city.population = Math.min(city.populationMax, city.population + general.crew);
  }
  Object.assign(general, { userId: null, nationId: null, officerLevel: 0, crew: 0, removedAt: tick });
  if (world.equipment && hasRareEquipment(world.equipment.config)) delete world.equipment.generals[generalId];
  if (world.commandMeta) delete world.commandMeta.offers[generalId];
  if (replay.policy) delete replay.policy.lastActiveTicks[generalId];
  if (campaign) readCampaignState(campaign, world);
  try {
    if (world.governance) replay.state = reconcileGovernance(replay.state, tick);
    if (lineage) replay.state = reconcileLineage(replay.state, tick);
  } catch (error) {
    if (error instanceof GovernanceRevisionLimitError || error instanceof LineageRevisionLimitError) return false;
    throw error;
  }
  return true;
}
