import { z } from 'zod';
import { BALANCE } from '../balance';
import type { Actor, Failure } from '../commands/types';
import { readCampaignState } from '../campaign/state';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { allocateCityGarrison } from './ledger';
import { readCityResourcesState } from './state';

const id = z.number().int().min(1).max(2_147_483_647);
export const cityAllocationArgs = z.strictObject({ cityKey: id, unitId: id, crewType: id, amount: id });

// 사람 입력과 국가 예약 명령이 같은 소속·직책·집결·수량 검사를 사용한다.
export function applyCityAllocation(view: WorldView, actor: Actor, value: unknown) {
  const fail = (code: Failure['code'], message: string) => ({ ok: false as const, code, message });
  if (!view.ruleFeatures?.includes('city-resources-v1'))
    return fail('COMMAND_DISABLED', '도시 자원을 사용하는 판이 아닙니다.');
  const armyTypes = actor.unitSet?.crewTypes.filter((row) => row.armType > 0).map((row) => row.id);
  const ledger = readCityResourcesState(view.cityResources, view, armyTypes);
  const campaign = readCampaignState(view.campaign, view);
  if (Object.values(view.generals).some((general) => general.crew !== 0))
    throw new Error('도시·부곡 원장 밖에 중복된 장수 병력이 있습니다.');
  const parsed = cityAllocationArgs.safeParse(value);
  if (!parsed.success) return fail('BAD_ARGS', '도시 병력 배속 인자를 확인하세요.');
  const general = view.generals[actor.generalId];
  if (!general) return fail('NO_ACTOR', '장수가 없습니다.');
  if (general.nationId === null || !view.nations[general.nationId])
    return fail('NOT_NATION', '국가에 소속되어야 합니다.');
  if (general.officerLevel < 5 || general.officerLevel > 12)
    return fail('PROTECTED', '군주·참모·수뇌만 도시 병력을 배속할 수 있습니다.');
  const args = parsed.data,
    city = view.cities[args.cityKey];
  if (!city || city.nationId !== general.nationId) return fail('NOT_OWN_CITY', '자기 국가 도시를 선택하세요.');
  const unit = campaign.units.find((entry) => entry.id === args.unitId);
  if (!unit) return fail('BAD_TARGET', '배속할 부곡이 없습니다.');
  const owner = view.generals[unit.ownerId]!,
    commander = view.generals[unit.commanderId]!;
  if (owner.nationId !== general.nationId || commander.nationId !== general.nationId)
    return fail('PROTECTED', '자기 국가 부곡에만 배속할 수 있습니다.');
  if (owner.cityKey !== args.cityKey || commander.cityKey !== args.cityKey)
    return fail('BAD_STATE', '부곡 소유자와 실제 지휘관이 해당 거점에 모여야 합니다.');
  if (!armyTypes?.includes(args.crewType) || unit.crewType !== args.crewType)
    return fail('NO_UNIT_SET', '도시 병력과 부곡의 병종을 확인하세요.');
  const row = ledger.cities[String(args.cityKey)]!.garrison.find((entry) => entry.crewType === args.crewType);
  if (!row || row.troops < args.amount) return fail('NO_CREW', '배속할 도시 수비병이 부족합니다.');
  const commanded = campaign.units
    .filter((entry) => entry.commanderId === commander.id)
    .reduce((sum, entry) => sum + entry.troops, 0);
  if (commanded + args.amount > commander.leadership * BALANCE.CREW_PER_LEADERSHIP)
    return fail('AT_MAX', '실제 지휘관의 전체 병력 상한을 넘습니다.');
  if (campaign.revision === 2_147_483_647) return fail('BAD_STATE', '휘하 변경 번호 한도를 넘었습니다.');
  const allocated = allocateCityGarrison(ledger.cities[String(args.cityKey)]!, unit, args.crewType, args.amount);
  ledger.cities[String(args.cityKey)] = allocated.city;
  campaign.units[campaign.units.findIndex((entry) => entry.id === unit.id)] = allocated.unit;
  campaign.revision++;
  const state = cloneWorld(view);
  state.cityResources = readCityResourcesState(ledger, state, armyTypes);
  state.campaign = readCampaignState(campaign, state);
  return { ok: true as const, state, text: `부곡${unit.id}에 도시 수비병 ${args.amount}명 배속` };
}
