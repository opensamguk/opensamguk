import { BALANCE } from '../balance';
import { affordableRecruits } from '../commands/statScores';
import type { DeepReadonly, WorldState, WorldView } from '../model/world';
import type { NpcCandidate, NpcContext } from '../npc';
import { npcNationPolicy } from '../npc/policy';
import { readCampaignState } from '../campaign/state';
import { readCityResourcesState } from './state';
import { affordableByGoods } from '../logistics/consumption';
import { crewContext, crewTypeFailure } from '../world/crewRequirements';

const candidate = (key: string, args: Record<string, unknown>, score: number, reason: string): NpcCandidate => ({
  key,
  args,
  score,
  reason,
});
export function cityNpcRecruitPlan(
  view: WorldView,
  generalId: number,
  context: Pick<NpcContext, 'unitSet' | 'tick'>,
  prepared: {
    resources: DeepReadonly<NonNullable<WorldState['cityResources']>['cities'][string]>;
    army: DeepReadonly<NonNullable<WorldState['campaign']>['units'][number]> | undefined;
  },
) {
  const general = view.generals[generalId]!,
    city = view.cities[general.cityKey]!;
  const { resources, army } = prepared;
  const policy = npcNationPolicy(view, general.nationId === null ? undefined : view.nations[general.nationId]);
  const requirements = crewContext(view, { generalId, tick: context.tick ?? 0 });
  const preferred = context.unitSet?.crewTypes.find(
    (row) => row.id === (army?.crewType ?? general.crewType) && row.armType > 0,
  );
  const existingTroops =
    (army?.troops ?? 0) + (resources.garrison.find((row) => row.crewType === preferred?.id)?.troops ?? 0);
  const type =
    preferred && (existingTroops > 0 || !crewTypeFailure(preferred, requirements))
      ? preferred
      : context.unitSet?.crewTypes
          .filter((row) => row.armType > 0 && !crewTypeFailure(row, requirements))
          .sort((a, b) => a.id - b.id)[0];
  if (!type) return null;
  const row = resources.garrison.find((entry) => entry.crewType === type.id);
  return {
    general,
    city,
    resources,
    army,
    type,
    row,
    policy,
    recruitable: crewTypeFailure(type, requirements) === null,
    limit: Math.max(0, Math.min(policy.recruitTarget - (row?.troops ?? 0), city.population)),
  };
}

export function cityNpcPreparation(view: WorldView, generalId: number, context: NpcContext): NpcCandidate[] {
  const generalView = view.generals[generalId]!;
  const resourcesView = readCityResourcesState(view.cityResources, view).cities[String(generalView.cityKey)]!;
  const owned = readCampaignState(view.campaign, view).units.filter((unit) => unit.ownerId === generalId);
  const plan = cityNpcRecruitPlan(view, generalId, context, {
    resources: resourcesView,
    army: owned.sort((a, b) => a.id - b.id)[0],
  });
  if (!plan) return [];
  const { general, city, resources, army, type, row, limit, recruitable, policy } = plan;
  const choices: NpcCandidate[] = [];
  if (recruitable && !army && general.leadership > 0 && row?.troops)
    choices.push(candidate('form_unit', { crewType: type.id }, 180, '도시 병력을 배속할 빈 부곡을 편성한다.'));
  if (row?.troops) {
    if (row.atmos < policy.moraleTarget)
      choices.push(
        candidate('morale', { target: 'city', crewType: type.id }, 170, '배속·수비 전에 도시 병사의 사기를 높인다.'),
      );
    else if (row.train < policy.trainingTarget)
      choices.push(
        candidate('train', { target: 'city', crewType: type.id }, 160, '배속·수비 전에 도시 병사를 훈련한다.'),
      );
  }
  if (recruitable && (row?.troops ?? 0) < policy.recruitTarget) {
    let amount = affordableRecruits(view, { ...general, gold: resources.gold }, type.cost, limit);
    if (view.ruleFeatures?.includes('logistics-v1')) {
      const logistics = view.logistics,
        cost = logistics?.config.recruitPer100[String(type.armType)],
        stock = logistics?.cities[String(city.cityKey)];
      if (!cost || !stock) throw new Error('NPC의 물류 모집 비용 또는 거점 재고가 없습니다.');
      amount = affordableByGoods(stock, cost, amount);
    }
    if (amount > 0)
      choices.push(
        candidate('recruit', { amount, crewType: type.id }, 120, '도시 금으로 부족한 도시 수비병을 모집한다.'),
      );
  }
  if (army && army.troops > 0) {
    if (army.atmos < policy.moraleTarget)
      choices.push(candidate('morale', { unitId: army.id }, 175, '출병할 부곡의 사기를 회복한다.'));
    else if (army.train < policy.trainingTarget)
      choices.push(candidate('train', { unitId: army.id }, 165, '출병할 부곡을 훈련한다.'));
  }
  return choices;
}

export function cityNpcAllocations(view: WorldView, nationId: number): NpcCandidate[] {
  const ledger = readCityResourcesState(view.cityResources, view),
    campaign = readCampaignState(view.campaign, view);
  const choices: NpcCandidate[] = [];
  const policy = npcNationPolicy(view, view.nations[nationId]);
  for (const unit of campaign.units) {
    const owner = view.generals[unit.ownerId]!,
      commander = view.generals[unit.commanderId]!;
    if (owner.nationId !== nationId || commander.nationId !== nationId || owner.cityKey !== commander.cityKey) continue;
    const city = view.cities[owner.cityKey]!;
    if (city.nationId !== nationId) continue;
    const row = ledger.cities[String(city.cityKey)]!.garrison.find((entry) => entry.crewType === unit.crewType);
    if (!row || row.train < policy.trainingTarget || row.atmos < policy.moraleTarget) continue;
    const capacity = commander.leadership * BALANCE.CREW_PER_LEADERSHIP;
    const commanded = campaign.units
      .filter((entry) => entry.commanderId === commander.id)
      .reduce((sum, entry) => sum + entry.troops, 0);
    const amount = Math.min(row.troops, Math.min(capacity, policy.recruitTarget) - unit.troops, capacity - commanded);
    if (amount > 0)
      choices.push(
        candidate(
          'nation_city_allocate',
          { cityKey: city.cityKey, unitId: unit.id, crewType: unit.crewType, amount },
          180,
          '준비된 도시 병사를 집결한 부곡에 한 번 배속한다.',
        ),
      );
  }
  return choices;
}
