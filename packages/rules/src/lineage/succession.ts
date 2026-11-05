import { campaignPeople, readCampaignState, type CampaignState } from '../campaign/state';
import { buildRetinueHierarchy, INITIAL_RENOWN_CAPACITY } from '../campaign/retinue';
import { cloneWorld } from '../model/clone';
import type { WorldState, WorldView } from '../model/world';
import { LINEAGE_EXITED_YEAR, LINEAGE_MAX } from './config';
import { heirEligibility, lineageActive, lineageFail } from './eligibility';
import { emptyLineagePerson } from './state';
import { inheritEquipment } from '../equipment/succession';

export type SuccessionMode = 'HUMAN' | 'NPC_DEATH';

// 위치는 지휘관의 도시다. 지휘관을 바꿀 때 같은 도시인지 확인하고 손실을 따로 합산한다.
export function applySuccession(world: WorldView, fromId: number, toId: number, mode: SuccessionMode, tick: number) {
  const denied = heirEligibility(world, fromId, toId, tick);
  if (denied) return denied;
  const next = cloneWorld(world),
    from = next.generals[fromId]!,
    to = next.generals[toId]!;
  if ((mode === 'HUMAN') !== (from.userId !== null))
    return lineageFail('NOT_OWNER', '사람의 계승에는 본인 동의가 필요합니다.');
  if (!inheritEquipment(next, fromId, toId, mode))
    return lineageFail('EQUIPMENT_CONFLICT', '부모와 후계자의 같은 칸 장비가 겹칩니다. 먼저 판매한 뒤 계승하세요.');
  const loss = { gold: 0, rice: 0, troops: 0 };
  const releasedPeople: number[] = [],
    inheritedPeople: number[] = [];
  for (const resource of ['gold', 'rice'] as const) {
    const total = from[resource] + to[resource];
    if (mode === 'HUMAN' && total > LINEAGE_MAX) return lineageFail('HOLDER_FULL', '후계자의 금·쌀 상한을 넘습니다.');
    to[resource] = Math.min(LINEAGE_MAX, total);
    loss[resource] = total - to[resource];
  }
  const campaign = next.campaign;
  if (campaign) {
    readCampaignState(campaign, next);
    if (
      mode === 'HUMAN' &&
      campaign.units.some((unit) => unit.commanderId === toId && unit.ownerId !== toId && unit.ownerId !== fromId)
    )
      return lineageFail('HEIR_COMMANDS_OTHERS', '후계자가 남의 부곡을 지휘하고 있습니다.');
    const children = campaign.links.filter((link) => link.masterId === fromId).sort((a, b) => a.personId - b.personId);
    campaign.links = campaign.links.filter(
      (link) => link.masterId !== fromId && link.personId !== fromId && (mode !== 'HUMAN' || link.personId !== toId),
    );
    for (const link of children) {
      if (link.personId === toId) continue;
      const person = next.generals[link.personId]!;
      if (person.userId !== null) {
        releasedPeople.push(person.id);
        continue;
      }
      const links = [...campaign.links, { ...link, masterId: toId }];
      let fits = false;
      try {
        const tree = buildRetinueHierarchy(campaignPeople(next, campaign), links);
        fits = links.every((row) => tree.withinCapacity(row.masterId, INITIAL_RENOWN_CAPACITY));
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'RETINUE_CYCLE') throw error;
      }
      if (fits) {
        campaign.links = links;
        inheritedPeople.push(person.id);
      } else releasedPeople.push(person.id);
    }
    const removed = new Set<number>();
    for (const unit of [...campaign.units].sort((a, b) => a.id - b.id)) {
      if (unit.ownerId !== fromId && unit.commanderId !== fromId) continue;
      let commanderId: number;
      if (unit.ownerId === fromId) {
        if (unit.commanderId === fromId) {
          commanderId = toId;
          if (unit.troops > 0 && from.cityKey !== to.cityKey) {
            if (mode === 'HUMAN') return lineageFail('HEIR_AWAY', '병력이 있는 부곡과 후계자가 다른 도시에 있습니다.');
            loss.troops += unit.troops;
            removed.add(unit.id);
            continue;
          }
        } else {
          commanderId = unit.commanderId;
          if (
            commanderId !== toId &&
            !campaign.links.some(
              (link) => link.masterId === toId && link.personId === commanderId && link.relation === 'LIEUTENANT',
            )
          ) {
            if (mode === 'HUMAN') return lineageFail('HEIR_CAPACITY', '부장을 같은 관계로 받아들일 수 없습니다.');
            loss.troops += unit.troops;
            removed.add(unit.id);
            continue;
          }
        }
        unit.ownerId = toId;
      } else {
        commanderId = unit.ownerId;
        if (from.cityKey !== next.generals[commanderId]!.cityKey) {
          loss.troops += unit.troops;
          unit.troops = 0;
        }
      }
      const used = campaign.units
        .filter((other) => other.id !== unit.id && !removed.has(other.id) && other.commanderId === commanderId)
        .reduce((sum, other) => sum + other.troops, 0);
      const available = Math.max(0, next.generals[commanderId]!.leadership * 100 - used);
      if (unit.troops > available) {
        if (mode === 'HUMAN') return lineageFail('HEIR_CAPACITY', '후계자의 지휘 병력 상한을 넘습니다.');
        loss.troops += unit.troops - available;
        unit.troops = available;
      }
      unit.commanderId = commanderId;
    }
    campaign.units = campaign.units.filter((unit) => !removed.has(unit.id));
    closeCampaignActivity(campaign, new Set([fromId, toId]), tick);
    if (campaign.revision === LINEAGE_MAX) return lineageFail('LIMIT', '부곡 변경 번호 한도에 닿았습니다.');
    campaign.revision++;
  } else if (from.crew > 0) {
    const blocked = to.crew > 0 ? 'HEIR_HAS_CREW' : from.cityKey !== to.cityKey ? 'HEIR_AWAY' : null;
    if (blocked && mode === 'HUMAN') return lineageFail(blocked, '병력을 같은 도시의 빈 후계자에게 이전하세요.');
    if (blocked) loss.troops += from.crew;
    else {
      const capacity = to.leadership * 100;
      if (from.crew > capacity && mode === 'HUMAN')
        return lineageFail('HEIR_CAPACITY', '후계자의 지휘 병력 상한을 넘습니다.');
      const crew = Math.min(from.crew, capacity);
      loss.troops += from.crew - crew;
      Object.assign(to, { crew, crewType: from.crewType, train: from.train, atmos: from.atmos });
    }
  }
  to.userId = from.userId;
  to.officerLevel = Math.max(from.officerLevel, to.officerLevel);
  if (mode === 'HUMAN' && to.officerLevel === 12 && to.nationId !== null) next.nations[to.nationId]!.isNpc = false;
  recordExit(next, fromId, toId, mode, tick);
  if (campaign) readCampaignState(campaign, next);
  return { ok: true as const, world: next, loss, releasedPeople, inheritedPeople };
}

function closeCampaignActivity(campaign: CampaignState, ids: ReadonlySet<number>, tick: number) {
  for (const offer of campaign.offers)
    if (offer.status === 'PENDING' && (ids.has(offer.masterId) || ids.has(offer.personId))) offer.status = 'CANCELLED';
  for (const order of campaign.orders?.items ?? [])
    if (
      (order.status === 'PENDING' || order.status === 'READY') &&
      (ids.has(order.issuerId) || ids.has(order.recipientId))
    ) {
      order.status = 'CANCELLED';
      order.resolvedTick = tick;
      order.result = '계승으로 취소되었습니다.';
    }
}

function recordExit(next: WorldState, fromId: number, toId: number | null, mode: SuccessionMode, tick: number) {
  const from = next.generals[fromId]!,
    state = next.lineage!;
  const person = state.persons[String(fromId)] ?? emptyLineagePerson();
  person.exit = { tick, cause: mode === 'HUMAN' ? 'SUCCEEDED' : 'DIED', activeFromYear: from.activeFromYear };
  person.successorId = toId;
  person.heirId = null;
  state.persons[String(fromId)] = person;
  Object.assign(from, {
    userId: null,
    nationId: null,
    officerLevel: 0,
    crew: 0,
    gold: 0,
    rice: 0,
    activeFromYear: LINEAGE_EXITED_YEAR,
  });
  state.marriages = state.marriages.filter((row) => row.a !== fromId && row.b !== fromId);
  state.offers = state.offers.filter((row) => row.fromId !== fromId && row.toId !== fromId);
  for (const entry of Object.values(state.persons)) if (entry.heirId === fromId) entry.heirId = null;
  if (next.commandMeta) delete next.commandMeta.offers[fromId];
}

export function retireNpcWithoutHeir(world: WorldView, fromId: number, tick: number) {
  if (!world.lineage || !lineageActive(world, fromId, tick) || world.generals[fromId]!.userId !== null)
    return lineageFail('BAD_TARGET', '살아 있는 NPC만 자동 사망 처리할 수 있습니다.');
  const next = cloneWorld(world),
    from = next.generals[fromId]!;
  const loss = { gold: from.gold, rice: from.rice, troops: from.crew };
  const campaign = next.campaign;
  if (campaign) {
    readCampaignState(campaign, next);
    if (campaign.revision === LINEAGE_MAX) return lineageFail('LIMIT', '부곡 변경 번호 한도에 닿았습니다.');
    const removed = new Set<number>();
    for (const unit of [...campaign.units].sort((a, b) => a.id - b.id)) {
      if (unit.ownerId === fromId) {
        loss.troops += unit.troops;
        removed.add(unit.id);
        continue;
      }
      if (unit.commanderId !== fromId) continue;
      const owner = next.generals[unit.ownerId]!;
      const used = campaign.units
        .filter((other) => other.id !== unit.id && other.commanderId === owner.id)
        .reduce((sum, other) => sum + other.troops, 0);
      const retained =
        owner.cityKey === from.cityKey ? Math.min(unit.troops, Math.max(0, owner.leadership * 100 - used)) : 0;
      loss.troops += unit.troops - retained;
      unit.troops = retained;
      unit.commanderId = owner.id;
    }
    campaign.units = campaign.units.filter((unit) => !removed.has(unit.id));
    campaign.links = campaign.links.filter((link) => link.masterId !== fromId && link.personId !== fromId);
    closeCampaignActivity(campaign, new Set([fromId]), tick);
    campaign.revision++;
  }
  inheritEquipment(next, fromId, null, 'NPC_DEATH');
  recordExit(next, fromId, null, 'NPC_DEATH', tick);
  if (campaign) readCampaignState(campaign, next);
  return { ok: true as const, world: next, loss };
}
