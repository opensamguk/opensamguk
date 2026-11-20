import { z } from 'zod';
import { BALANCE } from '../balance';
import { ownCity } from '../commands/support';
import { recruitCost, drillGain } from '../commands/statScores';
import type { Actor, Failure } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { readCampaignState } from '../campaign/state';
import { recruitCityGarrison } from './ledger';
import { CITY_RESOURCE_MAX, readCityResourcesState } from './state';
import { consumeCityGoods, recruitGoods } from '../logistics/consumption';
import { crewContext, crewTypeFailure } from '../world/crewRequirements';
import { campaignRecruitArgs } from '../campaign/preparation';

const positive = z.number().int().min(1).max(1_000_000);
export const cityRecruitArgs = z.strictObject({ amount: positive, crewType: positive });
export const cityDrillArgs = z.strictObject({ target: z.literal('city'), crewType: positive });
export type CityPreparationKey = 'recruit' | 'conscript' | 'train' | 'morale';

export function applyCityUnitRecruitment(view: WorldView, actor: Actor, key: 'recruit' | 'conscript', value: unknown) {
  const fail = (code: Failure['code'], message: string) => ({ ok: false as const, code, message });
  const parsed = campaignRecruitArgs.safeParse(value);
  if (!parsed.success || parsed.data.unitId === undefined) return fail('BAD_ARGS', '모집할 부곡을 선택하세요.');
  const args = parsed.data;
  const owner = view.generals[actor.generalId];
  if (!owner) return fail('NO_ACTOR', '장수가 없습니다.');
  const campaign = readCampaignState(view.campaign, view);
  let unit =
    args.unitId === 'new'
      ? undefined
      : campaign.units.find((row) => row.id === args.unitId && row.ownerId === owner.id);
  if (args.unitId !== 'new' && !unit) return fail('BAD_TARGET', '자기 부곡을 선택하세요.');
  if (unit?.supply) return fail('BAD_STATE', '귀환을 마친 뒤 부곡 병력을 보충하세요.');
  if (unit && unit.crewType !== args.crewType) return fail('BAD_ARGS', '같은 병종을 선택하세요.');
  const commander = view.generals[unit?.commanderId ?? owner.id]!;
  if (commander.cityKey !== owner.cityKey) return fail('BAD_STATE', '지휘관과 같은 거점에 모여야 합니다.');
  const commanded = campaign.units
    .filter((row) => row.commanderId === commander.id)
    .reduce((sum, row) => sum + row.troops, 0);
  if (commanded + args.amount > commander.leadership * BALANCE.CREW_PER_LEADERSHIP)
    return fail('AT_MAX', '실제 지휘관의 전체 병력 상한을 넘습니다.');
  if (campaign.revision === CITY_RESOURCE_MAX || (!unit && campaign.nextUnitId === CITY_RESOURCE_MAX))
    return fail('BAD_STATE', '부곡 변경 번호 한도를 넘었습니다.');
  const recruited = applyCityPreparation(view, actor, key, { amount: args.amount, crewType: args.crewType });
  if (!recruited.ok) return recruited;
  // 모집 비용·인구·물자는 도시 준비 규칙을 쓰고 새 병력만 선택 부곡으로 직접 보낸다.
  recruited.state.cityResources!.cities[String(owner.cityKey)]!.garrison = structuredClone(
    view.cityResources!.cities[String(owner.cityKey)]!.garrison,
  ) as NonNullable<typeof recruited.state.cityResources>['cities'][string]['garrison'];
  if (!unit) {
    unit = {
      id: campaign.nextUnitId++,
      ownerId: owner.id,
      commanderId: owner.id,
      troops: 0,
      crewType: args.crewType,
      train: 0,
      atmos: 0,
    };
    campaign.units.push(unit);
  }
  unit.train = Math.floor((unit.train * unit.troops) / (unit.troops + args.amount));
  unit.atmos = Math.floor((unit.atmos * unit.troops) / (unit.troops + args.amount));
  unit.troops += args.amount;
  campaign.revision++;
  recruited.state.campaign = readCampaignState(campaign, recruited.state);
  return { ...recruited, text: `부곡${unit.id} ${key === 'conscript' ? '징병' : '모병'} ${args.amount}명` };
}

export function applyCityPreparation(view: WorldView, actor: Actor, key: CityPreparationKey, value: unknown) {
  const fail = (code: Failure['code'], message: string) => ({ ok: false as const, code, message });
  const armyTypes = actor.unitSet?.crewTypes.filter((row) => row.armType > 0).map((row) => row.id);
  const ledger = readCityResourcesState(view.cityResources, view, armyTypes);
  readCampaignState(view.campaign, view);
  if (Object.values(view.generals).some((general) => general.crew !== 0))
    throw new Error('도시·부곡 원장 밖에 중복된 장수 병력이 있습니다.');
  const recruiting = key === 'recruit' || key === 'conscript';
  const parsed = (recruiting ? cityRecruitArgs : cityDrillArgs).safeParse(value);
  if (!parsed.success) return fail('BAD_ARGS', '도시 군사 명령 인자를 확인하세요.');
  const failure = ownCity(view, actor);
  if (failure) return { ok: false as const, ...failure };
  const general = view.generals[actor.generalId]!;
  if (view.cities[general.cityKey]!.kind === 'FIELD')
    return fail('BAD_TARGET', '전장에서는 도시 병력을 준비할 수 없습니다.');
  const crewType = actor.unitSet?.crewTypes.find((row) => row.id === parsed.data.crewType && row.armType > 0);
  if (!crewType) return fail('NO_UNIT_SET', '모집하거나 준비할 병종을 확인하세요.');
  if (recruiting) {
    const requirement = crewTypeFailure(crewType, crewContext(view, actor));
    if (requirement) return { ok: false as const, ...requirement };
  }
  const state = cloneWorld(view);
  state.cityResources = ledger;
  const city = state.cities[general.cityKey]!,
    resource = ledger.cities[String(general.cityKey)]!;
  let text: string;
  if (recruiting) {
    const { amount } = cityRecruitArgs.parse(value);
    if (city.population < amount) return fail('NO_POPULATION', '도시 인구가 부족합니다.');
    const cost = recruitCost(view, general, amount, crewType.cost, key === 'conscript');
    if (resource.gold < cost) return fail('NO_GOLD', '도시 금이 부족합니다.');
    const troops = resource.garrison.reduce((total, row) => total + row.troops, 0);
    if (amount > CITY_RESOURCE_MAX - troops) return fail('AT_MAX', '도시 전체 병력 수량 한도를 넘었습니다.');
    {
      if (!view.logistics) throw new Error('물류 판의 재고가 없습니다.');
      const spent = consumeCityGoods(view, city.cityKey, recruitGoods(view.logistics.config, crewType.armType, amount));
      if (!spent.ok) return spent;
      state.logistics = spent.logistics;
    }
    const recruited = recruitCityGarrison(resource, crewType.id, amount);
    recruited.gold -= cost;
    ledger.cities[String(general.cityKey)] = recruited;
    city.population -= amount;
    if (key === 'conscript') city.trust = Math.max(0, city.trust - BALANCE.CONSCRIPT_TRUST_LOSS);
    text = `${key === 'conscript' ? '징병' : '모병'}: 도시 수비병 ${amount}명 모집`;
  } else {
    const row = resource.garrison.find((entry) => entry.crewType === crewType.id);
    if (!row || row.troops === 0) return fail('NO_CREW', '준비할 도시 수비병이 없습니다.');
    const field = key === 'morale' ? 'atmos' : 'train';
    if (row[field] >= 100) return fail('AT_MAX', '이미 최대치입니다.');
    if (resource.gold < BALANCE.DRILL_COST) return fail('NO_GOLD', '도시 금이 부족합니다.');
    resource.gold -= BALANCE.DRILL_COST;
    row[field] = Math.min(100, row[field] + drillGain(view, general, key === 'morale'));
    text = `도시 수비병 ${key === 'morale' ? '사기진작' : '훈련'}: ${row[field]}`;
  }
  readCityResourcesState(ledger, state, armyTypes);
  return { ok: true as const, state, text };
}
