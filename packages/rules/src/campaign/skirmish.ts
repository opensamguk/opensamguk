import { useBattleTool } from '../equipment/morale';
import { consumeSnipeTool, equipmentBattleEffects } from '../equipment/battle';
import { battleTacticsStats } from '../battle/tactics';
import { combatSpecialty, combatSpecialtyKey } from '../general/combatSpecialty';
import type { Rng } from '@opensamguk/shared';
import { personalityEffects } from '../general/personality';
import { BALANCE } from '../balance';
import { simulateBattle, type BattleForce, type BattleInput } from '../battle/simulate';
import { FIVE_STAT_KEYS, fiveStatsSchema } from '../general/fiveStats';
import { battleModifiersForEffectiveStats, fiveStatsBattleModifiers } from '../general/fiveStatsBattle';
import { commandConditionStats, GENERAL_CONDITION_FEATURE } from '../general/condition';
import { collectModifiers, type BattleModifiers } from '../modifiers';
import { cloneWorld } from '../model/clone';
import type { DeepReadonly, WorldState, WorldView } from '../model/world';
import type { UnitSetResource } from '../world/resources';
import { readCampaignState, type CampaignUnitState } from './state';
import { readCityResourcesState } from '../cityResources/state';
import { equipmentBonus } from '../equipment/stats';

function start(view: WorldView) {
  const state = cloneWorld(view);
  const campaign = readCampaignState(state.campaign, state);
  if (Object.values(state.generals).some((general) => general.crew !== 0))
    throw new Error('부곡 전투에서 장수 병력을 중복 계산할 수 없습니다.');
  if (campaign.revision === 2_147_483_647) throw new Error('휘하 변경 번호 한도를 넘었습니다.');
  state.campaign = campaign;
  return state;
}
function unit(state: WorldState, id: number) {
  const row = state.campaign!.units.find((row) => row.id === id);
  if (!row || row.troops <= 0 || row.atmos <= 0) throw new Error('교전할 부곡 병력이나 사기가 없습니다.');
  return row;
}
function force(row: CampaignUnitState): BattleForce {
  return { crew: row.troops, crewType: row.crewType, train: row.train, atmos: row.atmos };
}
function feed(state: WorldState, row: CampaignUnitState, riceFactor = 1) {
  const owner = state.generals[row.ownerId]!;
  owner.rice = Math.max(0, owner.rice - Math.ceil(row.troops * BALANCE.BATTLE_RICE_PER_CREW * riceFactor));
  if (owner.rice === 0) row.atmos = Math.max(0, row.atmos - BALANCE.STARVATION_ATMOS_LOSS);
}
function modifiers(state: WorldState, row: CampaignUnitState): BattleModifiers {
  const commander = state.generals[row.commanderId]!;
  const stats = fiveStatsSchema.parse(Object.fromEntries(FIVE_STAT_KEYS.map((key) => [key, commander[key]])));
  const equipment = state.ruleFeatures?.includes('equipment-v1') ? equipmentBonus(state, commander.id) : undefined;
  const base = state.ruleFeatures?.includes(GENERAL_CONDITION_FEATURE)
    ? battleModifiersForEffectiveStats(commandConditionStats(state, commander, stats))
    : fiveStatsBattleModifiers(
        stats,
        equipment ? { leadership: equipment.leadership, strength: equipment.strength } : undefined,
      );
  return {
    dealt: [...collectModifiers(state, commander.id, { stage: 'battle.dealt', commandKey: 'attack' }), ...base.dealt],
    taken: [...collectModifiers(state, commander.id, { stage: 'battle.taken', commandKey: 'attack' }), ...base.taken],
  };
}
function finish(state: WorldState, row: CampaignUnitState, result: BattleForce) {
  row.troops = result.crew;
  row.train = result.train;
  row.atmos = result.atmos;
  // 병종과 소유자/지휘관은 전투 피해로 바뀌지 않는다.
  state.campaign!.revision++;
  readCampaignState(state.campaign, state);
}

// 순수 교전 어댑터다. 출병 소유권·인접/전쟁·집결·교전 순서·점령은 호출하는 명령이 검사한다.
export function fightCampaignUnits(
  view: WorldView,
  attackerId: number,
  defenderId: number,
  unitSet: DeepReadonly<UnitSetResource>,
  rng: Rng,
  attackerFirstVolleyUsed = false,
  recordPhases = false,
) {
  if (attackerId === defenderId) throw new Error('같은 부곡을 양쪽에 배치할 수 없습니다.');
  const state = start(view),
    attacker = unit(state, attackerId),
    defender = unit(state, defenderId);
  const aNation = state.generals[attacker.ownerId]!.nationId,
    bNation = state.generals[defender.ownerId]!.nationId;
  if (aNation === null || bNation === null || aNation === bNation)
    throw new Error('서로 다른 국가의 부곡만 교전할 수 있습니다.');
  const attackerEquipment = equipmentBattleEffects(state, attacker.commanderId);
  const defenderEquipment = equipmentBattleEffects(state, defender.commanderId);
  const attackerCommander = state.generals[attacker.commanderId]!;
  const defenderCommander = state.generals[defender.commanderId]!;
  feed(state, attacker, attackerEquipment?.riceFactor);
  feed(state, defender, defenderEquipment?.riceFactor);
  useBattleTool(state, attacker.commanderId, attacker);
  useBattleTool(state, defender.commanderId, defender);
  const result = simulateBattle(
    {
      attacker: force(attacker),
      attackerEquipment,
      defenderEquipment,
      attackerInjury: attackerCommander.injury,
      defenderInjury: defenderCommander.injury,
      attackerReadiness: personalityEffects(state, state.generals[attacker.commanderId]!.personality),
      attackerProficiency: state.generals[attacker.commanderId]!.proficiency,
      attackerSpecialty: combatSpecialty(state, combatSpecialtyKey(state.generals[attacker.commanderId]!)),
      attackerHeritage: state.generals[attacker.commanderId]!.heritageBenefits,
      attackerTactics: battleTacticsStats(state, state.generals[attacker.commanderId]!),
      defender: force(defender),
      defenderReadiness: personalityEffects(state, state.generals[defender.commanderId]!.personality),
      defenderProficiency: state.generals[defender.commanderId]!.proficiency,
      defenderSpecialty: combatSpecialty(state, combatSpecialtyKey(state.generals[defender.commanderId]!)),
      defenderHeritage: state.generals[defender.commanderId]!.heritageBenefits,
      defenderTactics: battleTacticsStats(state, state.generals[defender.commanderId]!),
      attackerTech: state.nations[aNation]!.tech,
      defenderTech: state.nations[bNation]!.tech,
      unitSet,
      attackerFirstVolleyUsed,
      recordPhases,
      coefMode: state.ruleFeatures?.includes('battle-affinity-v2') ? 'multiply' : 'divide',
      attackerModifiers: modifiers(state, attacker),
      defenderModifiers: modifiers(state, defender),
    },
    rng,
  );
  // 두 부곡의 최종 피해를 함께 반영한 뒤 전체 지휘 상한을 검사한다.
  consumeSnipeTool(state, attacker.commanderId, result.attackerSniped);
  consumeSnipeTool(state, defender.commanderId, result.defenderSniped);
  if (result.attackerInjury !== undefined) attackerCommander.injury = result.attackerInjury;
  if (result.defenderInjury !== undefined) defenderCommander.injury = result.defenderInjury;
  defender.troops = result.defender.crew;
  defender.train = result.defender.train;
  defender.atmos = result.defender.atmos;
  finish(state, attacker, result.attacker);
  return { state, ...result };
}

export function fightCampaignWall(
  view: WorldView,
  attackerId: number,
  cityKey: number,
  unitSet: DeepReadonly<UnitSetResource>,
  rng: Rng,
  {
    openingSkirmish = false,
    attackerFirstVolleyUsed = false,
    recordPhases = false,
  }: Pick<BattleInput, 'openingSkirmish' | 'attackerFirstVolleyUsed' | 'recordPhases'> = {},
) {
  const state = start(view),
    attacker = unit(state, attackerId),
    city = state.cities[cityKey];
  const aNation = state.generals[attacker.ownerId]!.nationId;
  if (!city || aNation === null || city.nationId === aNation || city.wall < 0)
    throw new Error('교전할 성벽을 확인하세요.');
  const attackerEquipment = equipmentBattleEffects(state, attacker.commanderId);
  feed(state, attacker, attackerEquipment?.riceFactor);
  useBattleTool(state, attacker.commanderId, attacker);
  const result = simulateBattle(
    {
      attacker: force(attacker),
      attackerEquipment,
      attackerReadiness: personalityEffects(state, state.generals[attacker.commanderId]!.personality),
      attackerProficiency: state.generals[attacker.commanderId]!.proficiency,
      attackerSpecialty: combatSpecialty(state, combatSpecialtyKey(state.generals[attacker.commanderId]!)),
      attackerHeritage: state.generals[attacker.commanderId]!.heritageBenefits,
      attackerTactics: battleTacticsStats(state, state.generals[attacker.commanderId]!),
      defender: { crew: city.wall, crewType: 1000, train: 100, atmos: 100 },
      attackerTech: state.nations[aNation]!.tech,
      defenderTech: city.nationId === null ? 0 : state.nations[city.nationId]!.tech,
      defence: city.defence,
      openingSkirmish,
      recordPhases,
      siege: !openingSkirmish,
      attackerFirstVolleyUsed,
      unitSet,
      coefMode: state.ruleFeatures?.includes('battle-affinity-v2') ? 'multiply' : 'divide',
      attackerModifiers: modifiers(state, attacker),
    },
    rng,
  );
  consumeSnipeTool(state, attacker.commanderId, result.attackerSniped);
  city.wall = result.defender.crew;
  finish(state, attacker, result.attacker);
  return { state, ...result };
}

// 도시 수비에는 가상의 장수나 5능력치 보정을 만들지 않는다.
export function fightCampaignCityGarrison(
  view: WorldView,
  attackerId: number,
  cityKey: number,
  crewType: number,
  unitSet: DeepReadonly<UnitSetResource>,
  rng: Rng,
  attackerFirstVolleyUsed = false,
  recordPhases = false,
) {
  if (!view.ruleFeatures?.includes('city-resources-v1')) throw new Error('도시 수비 규칙이 없는 판입니다.');
  const state = start(view),
    attacker = unit(state, attackerId),
    city = state.cities[cityKey];
  const aNation = state.generals[attacker.ownerId]!.nationId;
  if (!city || aNation === null || city.nationId === null || city.nationId === aNation)
    throw new Error('서로 다른 국가의 도시 수비병만 교전할 수 있습니다.');
  const ledger = readCityResourcesState(
    state.cityResources,
    state,
    unitSet.crewTypes.filter((row) => row.armType > 0).map((row) => row.id),
  );
  state.cityResources = ledger;
  const resource = ledger.cities[String(cityKey)]!,
    defender = resource.garrison.find((row) => row.crewType === crewType);
  if (!defender || defender.troops <= 0) throw new Error('교전할 도시 수비병이 없습니다.');
  if (defender.atmos > 0) {
    resource.rice = Math.max(0, resource.rice - Math.ceil(defender.troops * BALANCE.BATTLE_RICE_PER_CREW));
    if (resource.rice === 0) defender.atmos = Math.max(0, defender.atmos - BALANCE.STARVATION_ATMOS_LOSS);
  }
  let returned = 0,
    overflow = 0;
  if (defender.atmos === 0) {
    returned = Math.min(defender.troops, Math.max(0, city.populationMax - city.population));
    overflow = defender.troops - returned;
    city.population += returned;
    resource.garrison = resource.garrison.filter((row) => row.crewType !== crewType);
    return { state, text: `도시 병종${crewType} 패주: 민간 복귀 ${returned}명, 인구 상한 밖 ${overflow}명` };
  }
  const attackerEquipment = equipmentBattleEffects(state, attacker.commanderId);
  feed(state, attacker, attackerEquipment?.riceFactor);
  useBattleTool(state, attacker.commanderId, attacker);
  const result = simulateBattle(
    {
      attacker: force(attacker),
      attackerEquipment,
      attackerReadiness: personalityEffects(state, state.generals[attacker.commanderId]!.personality),
      attackerProficiency: state.generals[attacker.commanderId]!.proficiency,
      attackerSpecialty: combatSpecialty(state, combatSpecialtyKey(state.generals[attacker.commanderId]!)),
      attackerHeritage: state.generals[attacker.commanderId]!.heritageBenefits,
      attackerTactics: battleTacticsStats(state, state.generals[attacker.commanderId]!),
      defender: { crew: defender.troops, crewType: defender.crewType, train: defender.train, atmos: defender.atmos },
      attackerTech: state.nations[aNation]!.tech,
      defenderTech: state.nations[city.nationId]!.tech,
      defence: city.defence,
      unitSet,
      attackerFirstVolleyUsed,
      recordPhases,
      coefMode: state.ruleFeatures?.includes('battle-affinity-v2') ? 'multiply' : 'divide',
      attackerModifiers: modifiers(state, attacker),
    },
    rng,
  );
  consumeSnipeTool(state, attacker.commanderId, result.attackerSniped);
  defender.troops = result.defender.crew;
  defender.train = result.defender.train;
  defender.atmos = result.defender.atmos;
  if (defender.atmos === 0) {
    returned = Math.min(defender.troops, Math.max(0, city.populationMax - city.population));
    overflow = defender.troops - returned;
    city.population += returned;
    defender.troops = 0;
  }
  resource.garrison = resource.garrison.filter((row) => row.troops > 0);
  finish(state, attacker, result.attacker);
  readCityResourcesState(ledger, state);
  return {
    state,
    text: `부곡${attackerId} 대 도시 병종${crewType}: 공격 ${attacker.troops}명, 수비 ${defender.troops}명, 민간 복귀 ${returned}명, 인구 상한 밖 ${overflow}명`,
    ...(result.attackerFirstVolleyFired && { attackerFirstVolleyFired: result.attackerFirstVolleyFired }),
    ...(result.phases?.length ? { phases: result.phases } : {}),
  };
}
