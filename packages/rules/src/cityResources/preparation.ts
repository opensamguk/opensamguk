import { z } from 'zod';
import { BALANCE } from '../balance';
import { ownCity } from '../commands/support';
import { recruitCost, drillGain } from '../commands/statScores';
import type { Actor, Failure } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { readCampaignState } from '../campaign/state';
import { recruitCityGarrison } from './ledger';
import { readCityResourcesState } from './state';

const positive = z.number().int().min(1).max(1_000_000);
export const cityRecruitArgs = z.strictObject({ amount: positive, crewType: positive });
export const cityDrillArgs = z.strictObject({ target: z.literal('city'), crewType: positive });
export type CityPreparationKey = 'recruit' | 'conscript' | 'train' | 'morale';

export function applyCityPreparation(view: WorldView, actor: Actor, key: CityPreparationKey, value: unknown) {
  const fail = (code: Failure['code'], message: string) => ({ ok: false as const, code, message });
  if (!view.ruleFeatures?.includes('city-resources-v1'))
    return fail('COMMAND_DISABLED', '도시 자원을 사용하는 판이 아닙니다.');
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
  const crewType = actor.unitSet?.crewTypes.find((row) => row.id === parsed.data.crewType && row.armType > 0);
  if (!crewType) return fail('NO_UNIT_SET', '모집하거나 준비할 병종을 확인하세요.');
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
