import { BALANCE } from '../balance';
import { affordableRecruits } from '../commands/statScores';
import type { WorldView } from '../model/world';
import type { NpcCandidate, NpcContext } from '../npc';
import { readCampaignState } from '../campaign/state';
import { readCityResourcesState } from './state';

const candidate = (key: string, args: Record<string, unknown>, score: number, reason: string): NpcCandidate => ({
  key,
  args,
  score,
  reason,
});
export function cityNpcPreparation(view: WorldView, generalId: number, context: NpcContext): NpcCandidate[] {
  const general = view.generals[generalId]!,
    city = view.cities[general.cityKey]!;
  const resources = readCityResourcesState(view.cityResources, view).cities[String(city.cityKey)]!;
  const campaign = readCampaignState(view.campaign, view),
    owned = campaign.units.filter((row) => row.ownerId === generalId);
  const army = owned.sort((a, b) => a.id - b.id)[0];
  const type =
    context.unitSet?.crewTypes.find((row) => row.id === (army?.crewType ?? general.crewType) && row.armType > 0) ??
    context.unitSet?.crewTypes.filter((row) => row.armType > 0).sort((a, b) => a.id - b.id)[0];
  if (!type) return [];
  const row = resources.garrison.find((entry) => entry.crewType === type.id),
    choices: NpcCandidate[] = [];
  if (!army && general.leadership > 0 && row?.troops)
    choices.push(candidate('form_unit', { crewType: type.id }, 180, '도시 병력을 배속할 빈 부곡을 편성한다.'));
  if (row?.troops) {
    if (row.atmos < 70)
      choices.push(
        candidate('morale', { target: 'city', crewType: type.id }, 170, '배속·수비 전에 도시 병사의 사기를 높인다.'),
      );
    else if (row.train < 60)
      choices.push(
        candidate('train', { target: 'city', crewType: type.id }, 160, '배속·수비 전에 도시 병사를 훈련한다.'),
      );
  }
  if ((row?.troops ?? 0) < 2000) {
    const limit = Math.min(2000 - (row?.troops ?? 0), city.population);
    const amount = affordableRecruits(view, { ...general, gold: resources.gold }, type.cost, limit);
    if (amount > 0)
      choices.push(
        candidate('recruit', { amount, crewType: type.id }, 120, '도시 금으로 부족한 도시 수비병을 모집한다.'),
      );
  }
  if (army && army.troops > 0) {
    if (army.atmos < 70) choices.push(candidate('morale', { unitId: army.id }, 175, '출병할 부곡의 사기를 회복한다.'));
    else if (army.train < 60) choices.push(candidate('train', { unitId: army.id }, 165, '출병할 부곡을 훈련한다.'));
  }
  return choices;
}

export function cityNpcAllocations(view: WorldView, nationId: number): NpcCandidate[] {
  const ledger = readCityResourcesState(view.cityResources, view),
    campaign = readCampaignState(view.campaign, view);
  const choices: NpcCandidate[] = [];
  for (const unit of campaign.units) {
    const owner = view.generals[unit.ownerId]!,
      commander = view.generals[unit.commanderId]!;
    if (owner.nationId !== nationId || commander.nationId !== nationId || owner.cityKey !== commander.cityKey) continue;
    const city = view.cities[owner.cityKey]!;
    if (city.nationId !== nationId) continue;
    const row = ledger.cities[String(city.cityKey)]!.garrison.find((entry) => entry.crewType === unit.crewType);
    if (!row || row.train < 60 || row.atmos < 70) continue;
    const capacity = commander.leadership * BALANCE.CREW_PER_LEADERSHIP;
    const commanded = campaign.units
      .filter((entry) => entry.commanderId === commander.id)
      .reduce((sum, entry) => sum + entry.troops, 0);
    const amount = Math.min(row.troops, Math.min(capacity, 2000) - unit.troops, capacity - commanded);
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
