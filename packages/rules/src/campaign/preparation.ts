import { z } from 'zod';
import { BALANCE } from '../balance';
import { ownCity } from '../commands/support';
import { drillGain, recruitCost } from '../commands/statScores';
import type { Actor, Failure } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { readCampaignState } from './state';

const positive = z.number().int().min(1).max(1_000_000);
const unitId = z.number().int().min(1).max(2_147_483_647).optional();
export const campaignRecruitArgs = z.strictObject({ amount: positive, crewType: positive, unitId });
export const campaignDrillArgs = z.strictObject({ unitId });
export type CampaignPreparationKey = 'recruit' | 'conscript' | 'train' | 'morale' | 'dismiss';

// 기존 군사 명령의 비용·인구·훈련 산식을 쓰되 병력 정본은 부곡 한 곳에만 둔다.
// 운영 명령 등록은 이동·전투·월 정산 어댑터까지 완성한 뒤에 한다.
export function applyCampaignPreparation(view: WorldView, actor: Actor, key: CampaignPreparationKey, value: unknown) {
  const fail = (code: Failure['code'], message: string) => ({ ok: false as const, code, message });
  const campaign = readCampaignState(view.campaign, view);
  if (Object.values(view.generals).some((general) => general.crew !== 0))
    throw new Error('부곡 월드에 중복된 장수 병력이 있습니다.');
  const recruiting = key === 'recruit' || key === 'conscript';
  const parsed = (recruiting ? campaignRecruitArgs : campaignDrillArgs).safeParse(value);
  if (!parsed.success) return fail('BAD_ARGS', '부곡 명령 인자를 확인하세요.');
  const owner = view.generals[actor.generalId];
  if (!owner) return fail('NO_ACTOR', '장수가 없습니다.');
  if (key !== 'dismiss') {
    const failure = ownCity(view, actor);
    if (failure) return { ok: false as const, ...failure };
  }
  const requestedId = parsed.data.unitId;
  const owned = campaign.units.filter((row) => row.ownerId === owner.id).sort((a, b) => a.id - b.id);
  let unit =
    requestedId === undefined
      ? recruiting
        ? owned[0]
        : owned.find((row) => row.troops > 0)
      : owned.find((row) => row.id === requestedId);
  if (requestedId !== undefined && !unit) return fail('BAD_TARGET', '자기 부곡을 선택하세요.');
  if (!unit && !recruiting) return fail('NO_CREW', '병력이 없습니다.');
  if (!unit && campaign.nextUnitId === 2_147_483_647) return fail('BAD_STATE', '부곡 번호 한도를 넘었습니다.');
  const commander = view.generals[unit?.commanderId ?? owner.id]!;
  if (commander.cityKey !== owner.cityKey) return fail('BAD_STATE', '지휘관과 부곡이 같은 거점에 모여야 합니다.');
  if (campaign.revision === 2_147_483_647) return fail('BAD_STATE', '휘하 변경 번호 한도를 넘었습니다.');
  const state = cloneWorld(view);
  state.campaign = campaign;
  const general = state.generals[owner.id]!,
    city = state.cities[owner.cityKey]!;
  let text: string;
  if (recruiting) {
    const args = campaignRecruitArgs.parse(value);
    const crewType = actor.unitSet?.crewTypes.find((row) => row.id === args.crewType && row.armType > 0);
    if (!crewType) return fail('NO_UNIT_SET', '모집할 병종을 확인하세요.');
    if (unit && unit.troops > 0 && unit.crewType !== args.crewType)
      return fail('BAD_STATE', '소집해제 후 병종을 바꿀 수 있습니다.');
    const commanded = campaign.units
      .filter((row) => row.commanderId === commander.id)
      .reduce((sum, row) => sum + row.troops, 0);
    if (commanded + args.amount > commander.leadership * BALANCE.CREW_PER_LEADERSHIP)
      return fail('AT_MAX', '실제 지휘관의 전체 병력 상한을 넘습니다.');
    if (city.population < args.amount) return fail('NO_POPULATION', '도시 인구가 부족합니다.');
    const cost = recruitCost(view, owner, args.amount, crewType.cost, key === 'conscript');
    if (owner.gold < cost) return fail('NO_GOLD', '금이 부족합니다.');
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
    general.gold -= cost;
    unit.train = Math.floor((unit.train * unit.troops) / (unit.troops + args.amount));
    unit.atmos = Math.floor((unit.atmos * unit.troops) / (unit.troops + args.amount));
    unit.troops += args.amount;
    unit.crewType = args.crewType;
    city.population -= args.amount;
    if (key === 'conscript') city.trust = Math.max(0, city.trust - BALANCE.CONSCRIPT_TRUST_LOSS);
    text = `${key === 'conscript' ? '징병' : '모병'}: 부곡${unit.id} ${args.amount}명, 병력 ${unit.troops}명`;
  } else {
    if (unit!.troops <= 0) return fail('NO_CREW', '병력이 없습니다.');
    if (key === 'dismiss') {
      if (city.nationId === owner.nationId)
        city.population = Math.min(city.populationMax, city.population + unit!.troops);
      unit!.troops = 0;
      unit!.train = 0;
      unit!.atmos = 0;
      text = `부곡${unit!.id} 소집해제`;
    } else {
      const field = key === 'morale' ? 'atmos' : 'train';
      if (unit![field] >= 100) return fail('AT_MAX', '이미 최대치입니다.');
      if (owner.gold < BALANCE.DRILL_COST) return fail('NO_GOLD', '금이 부족합니다.');
      general.gold -= BALANCE.DRILL_COST;
      unit![field] = Math.min(100, unit![field] + drillGain(view, commander, key === 'morale'));
      text = `부곡${unit!.id} ${key === 'morale' ? '사기진작' : '훈련'}: ${unit![field]}`;
    }
  }
  campaign.revision++;
  readCampaignState(campaign, state);
  return { ok: true as const, state, unitId: unit!.id, text };
}
