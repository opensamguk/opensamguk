import { rollBattleTactics, type battleTacticsStats, type PhaseTactic } from './tactics';
import type { HeritageBenefits } from '../heritage/benefits';
import type { CombatSpecialty } from '../general/combatSpecialty';
import type { Rng } from '@opensamguk/shared';
import { proficiencyDamageFactor, type GeneralProficiency } from '../general/proficiency';
import { BALANCE } from '../balance';
import type { DeepReadonly } from '../model/world';
import type { UnitSetResource } from '../world/resources';
import { applyModifiers, type BattleModifiers } from '../modifiers';
import type { EquipmentBattleEffects } from '../equipment/battle';

export type BattleForce = { crew: number; crewType: number; train: number; atmos: number };
export type BattleInput = {
  attacker: Readonly<BattleForce>;
  defender: Readonly<BattleForce>;
  attackerTech: number;
  defenderTech: number;
  defence?: number;
  openingSkirmish?: boolean;
  siege?: boolean;
  attackerFirstVolleyUsed?: boolean;
  unitSet: DeepReadonly<UnitSetResource>;
  coefMode?: 'divide' | 'multiply';
  attackerModifiers?: BattleModifiers;
  defenderModifiers?: BattleModifiers;
  recordPhases?: boolean;
  attackerReadiness?: { train?: number; morale?: number } | undefined;
  defenderReadiness?: { train?: number; morale?: number } | undefined;
  attackerProficiency?: Readonly<GeneralProficiency> | undefined;
  defenderProficiency?: Readonly<GeneralProficiency> | undefined;
  attackerSpecialty?: CombatSpecialty | undefined;
  defenderSpecialty?: CombatSpecialty | undefined;
  attackerHeritage?: HeritageBenefits | undefined;
  defenderHeritage?: HeritageBenefits | undefined;
  attackerTactics?: ReturnType<typeof battleTacticsStats>;
  defenderTactics?: ReturnType<typeof battleTacticsStats>;
  attackerEquipment?: EquipmentBattleEffects | undefined;
  defenderEquipment?: EquipmentBattleEffects | undefined;
  attackerInjury?: number;
  defenderInjury?: number;
};

type Unit = DeepReadonly<UnitSetResource['crewTypes'][number]>;
function unit(unitSet: BattleInput['unitSet'], id: number): Unit {
  const result = unitSet.crewTypes.find((u) => u.id === id);
  if (!result) throw new Error('전투 병종이 없습니다.');
  return result;
}
function coefficient(table: Unit['attackCoef'], target: Unit, idFirst: boolean) {
  if (Array.isArray(table)) return 1;
  const values = table as Readonly<Record<string, number>>;
  // 기존 월드는 사용자 병종의 ID 계수도 당시처럼 건너뛴다.
  return (idFirst ? values[String(target.id)] : undefined) ?? values[String(target.armType)] ?? 1;
}
function regionalUnit(unit: Unit) {
  return unit.requirements?.some(
    ({ kind }) => kind === 'regions' || kind === 'legacyCheRegions' || kind === 'cities' || kind === 'citiesWithLevel',
  );
}

function damage(a: BattleForce, b: BattleForce, input: BattleInput, rng: Rng, attackingSide: boolean, scale = 1) {
  const { unitSet } = input;
  const attacking = unit(unitSet, a.crewType),
    defending = unit(unitSet, b.crewType);
  const multiply = input.coefMode === 'multiply';
  const tech = attackingSide ? input.attackerTech : input.defenderTech;
  const defence = attackingSide ? (input.defence ?? 0) : 0;
  const readiness = attackingSide ? input.attackerReadiness : input.defenderReadiness;
  const train = readiness?.train === undefined ? a.train : Math.max(0, a.train + readiness.train);
  const morale = readiness?.morale === undefined ? a.atmos : Math.max(0, a.atmos + readiness.morale);
  const attackPower =
    a.crew *
    (attacking.attack / Math.max(1, defending.defence + defence)) *
    coefficient(attacking.attackCoef, defending, multiply);
  const defenceCoef = coefficient(defending.defenceCoef, attacking, multiply);
  let power =
    (multiply ? attackPower * defenceCoef : attackPower / Math.max(0.01, defenceCoef)) *
    ((50 + train) / 150) *
    ((50 + morale) / 150) *
    (1 + tech / BALANCE.MAX_TECH) *
    BALANCE.DAMAGE_FACTOR *
    (0.9 + rng.next() * 0.2);
  if (attackingSide && defending.effects?.includes('guard5')) power /= 1.05;
  if (attacking.effects?.includes('cavalryClash') && !defending.effects?.includes('pikeWall'))
    power *= defending.armType === 0 ? 0.9 : attackingSide ? 1.02 : 0.97;
  if (
    defending.effects?.includes('cavalryClash') &&
    !attacking.effects?.includes('pikeWall') &&
    attacking.armType !== 0
  )
    power *= attackingSide ? 1.02 : 0.97;
  const attackTrait = attackingSide ? input.attackerSpecialty : input.defenderSpecialty;
  const defenseTrait = attackingSide ? input.defenderSpecialty : input.attackerSpecialty;
  if (attackTrait && (!attackTrait.regional || regionalUnit(defending))) {
    power *= attackTrait.dealt?.[attackingSide ? 0 : 1] ?? 1;
    if (defending.armType === 0) power *= attackTrait.wallDamage ?? 1;
  }
  if (defenseTrait && (!defenseTrait.regional || regionalUnit(attacking))) {
    power *= defenseTrait.taken?.[attackingSide ? 1 : 0] ?? 1;
  }
  if (input.attackerProficiency || input.defenderProficiency) {
    const attack = attackingSide ? input.attackerProficiency : input.defenderProficiency;
    const defense = attackingSide ? input.defenderProficiency : input.attackerProficiency;
    const armType = attacking.armType === 0 ? 5 : attacking.armType;
    const attackBonus =
      attackTrait?.armType && armType === (attackingSide ? defending.armType : attacking.armType)
        ? (attack?.[attackTrait.armType] ?? 0)
        : 0;
    const defenseBonus =
      defenseTrait?.armType && armType === (attackingSide ? defending.armType : attacking.armType)
        ? (defense?.[defenseTrait.armType] ?? 0)
        : 0;
    power *= proficiencyDamageFactor((attack?.[armType] ?? 0) + attackBonus, (defense?.[armType] ?? 0) + defenseBonus);
  }
  power *= scale;
  const equipment = attackingSide ? input.attackerEquipment : input.defenderEquipment;
  power *= equipment?.damageFactor ?? 1;
  const attackerModifiers = attackingSide ? input.attackerModifiers : input.defenderModifiers;
  const defenderModifiers = attackingSide ? input.defenderModifiers : input.attackerModifiers;
  power = applyModifiers(power, attackerModifiers?.dealt ?? []);
  power = applyModifiers(power, defenderModifiers?.taken ?? []);
  return Math.min(b.crew, Math.max(1, Math.round(power)));
}
function copyForce(force: Readonly<BattleForce>): BattleForce {
  return { crew: force.crew, crewType: force.crewType, train: force.train, atmos: force.atmos };
}

export type BattlePhase = {
  kind: 'volley' | 'hold' | 'exchange';
  opponent?: string;
  attackerLoss: number;
  defenderLoss: number;
  attackerEvaded?: boolean;
  defenderEvaded?: boolean;
  attackerCritical?: boolean;
  defenderCritical?: boolean;
  attackerTactic?: PhaseTactic;
  defenderTactic?: PhaseTactic;
  attackerSniped?: boolean;
  defenderSniped?: boolean;
};
type BattleResult = {
  attacker: BattleForce;
  defender: BattleForce;
  attackerFirstVolleyFired?: true;
  attackerInjury?: number;
  defenderInjury?: number;
  phases?: BattlePhase[];
};

export function simulateBattle(input: BattleInput, rng: Rng): BattleResult {
  const { unitSet } = input;
  const attacker = copyForce(input.attacker),
    defender = copyForce(input.defender);
  const canFight = () => attacker.crew > 0 && defender.crew > 0 && attacker.atmos > 0 && defender.atmos > 0;
  const result: BattleResult = { attacker, defender, ...(input.recordPhases ? { phases: [] } : {}) };
  if (!canFight()) return result;
  const attackerSnipe = input.attackerEquipment?.snipe;
  const defenderSnipe = input.defenderEquipment?.snipe;
  const attackerSniped = attackerSnipe && rng.next() < attackerSnipe.chance;
  const defenderSniped = defenderSnipe && rng.next() < defenderSnipe.chance;
  const snipes = { ...(attackerSniped ? { attackerSniped } : {}), ...(defenderSniped ? { defenderSniped } : {}) };
  if (attackerSniped) {
    attacker.atmos = Math.min(100, attacker.atmos + attackerSnipe.morale);
    if (input.defenderInjury !== undefined)
      result.defenderInjury = snipeInjury(input.defenderInjury, attackerSnipe.injury, rng);
  }
  if (defenderSniped) {
    defender.atmos = Math.min(100, defender.atmos + defenderSnipe.morale);
    if (input.attackerInjury !== undefined)
      result.attackerInjury = snipeInjury(input.attackerInjury, defenderSnipe.injury, rng);
  }
  const aUnit = unit(unitSet, attacker.crewType),
    bUnit = unit(unitSet, defender.crewType);
  const sortieVolley = unitSet.firstVolleyScope === 'sortie';
  const attackerFires = aUnit.effects?.includes('firstVolley') && !(sortieVolley && input.attackerFirstVolleyUsed);
  const defenderFires = bUnit.effects?.includes('firstVolley') && !(sortieVolley && input.siege);
  if (attackerFires || defenderFires) {
    const toDefender = attackerFires ? damage(attacker, defender, input, rng, true, 2 / 3) : 0,
      toAttacker = defenderFires ? damage(defender, attacker, input, rng, false, 2 / 3) : 0;
    attacker.crew -= toAttacker;
    defender.crew -= toDefender;
    result.phases?.push({ kind: 'volley', attackerLoss: toAttacker, defenderLoss: toDefender, ...snipes });
    if (sortieVolley && attackerFires) result.attackerFirstVolleyFired = true;
    if (input.openingSkirmish) return result;
  }
  let held = false;
  const phases = input.openingSkirmish ? 1 : BALANCE.BATTLE_PHASES + (input.attackerEquipment?.extraPhases ?? 0);
  for (let phase = 0; phase < phases && canFight(); phase++) {
    const openingSnipes = phase === 0 && !attackerFires && !defenderFires ? snipes : {};
    if (bUnit.effects?.includes('hold') && !held && rng.next() < (defender.train + defender.atmos) / 400) {
      held = true;
      result.phases?.push({ kind: 'hold', attackerLoss: 0, defenderLoss: 0, ...openingSnipes });
      continue;
    }
    const attackerTactic = rollBattleTactics(
      input.attackerTactics,
      aUnit,
      bUnit,
      input.attackerSpecialty,
      input.defenderSpecialty,
      input.attackerHeritage,
      input.defenderHeritage,
      phase === 0,
      rng,
      input.attackerEquipment,
      input.defenderEquipment,
    );
    const defenderTactic = rollBattleTactics(
      input.defenderTactics,
      bUnit,
      aUnit,
      input.defenderSpecialty,
      input.attackerSpecialty,
      input.defenderHeritage,
      input.attackerHeritage,
      phase === 0,
      rng,
      input.defenderEquipment,
      input.attackerEquipment,
    );
    const reflectedByAttacker = reflectedTactic(defenderTactic, input.attackerEquipment, rng);
    const reflectedByDefender = reflectedTactic(attackerTactic, input.defenderEquipment, rng);
    const attackerTacticDamage = (reflectedByDefender ? 1 : attackerTactic.dealt) * (reflectedByAttacker?.dealt ?? 1);
    const defenderTacticDamage = (reflectedByAttacker ? 1 : defenderTactic.dealt) * (reflectedByDefender?.dealt ?? 1);
    const attackerTacticLog = reflectedByAttacker?.tactic ?? (reflectedByDefender ? undefined : attackerTactic.tactic);
    const defenderTacticLog = reflectedByDefender?.tactic ?? (reflectedByAttacker ? undefined : defenderTactic.tactic);
    const attackerAvoidBonus =
      (input.attackerSpecialty?.avoid ?? 0) + equipmentEvasion(attacker, input.attackerEquipment);
    const defenderAvoidBonus =
      (input.defenderSpecialty?.avoid ?? 0) + equipmentEvasion(defender, input.defenderEquipment);
    const attackerCanAvoid = aUnit.effects?.includes('avoid');
    const defenderCanAvoid = bUnit.effects?.includes('avoid');
    const attackerHeritageAvoid =
      ((input.attackerHeritage?.evasion ?? 0) - (input.defenderHeritage?.opponentEvasion ?? 0)) / 100;
    const defenderHeritageAvoid =
      ((input.defenderHeritage?.evasion ?? 0) - (input.attackerHeritage?.opponentEvasion ?? 0)) / 100;
    const avoidAttacker =
      !defenderTactic.ignoresEvasion &&
      (attackerCanAvoid || attackerAvoidBonus + attackerHeritageAvoid > 0) &&
      rng.next() < (attackerCanAvoid ? aUnit.avoid / 100 : 0) + attackerAvoidBonus + attackerHeritageAvoid;
    const avoidDefender =
      !attackerTactic.ignoresEvasion &&
      (defenderCanAvoid || defenderAvoidBonus + defenderHeritageAvoid > 0) &&
      rng.next() < (defenderCanAvoid ? bUnit.avoid / 100 : 0) + defenderAvoidBonus + defenderHeritageAvoid;
    // 양쪽 피해는 같은 페이즈 시작 상태로 계산하고 동시에 적용한다.
    const toDefender = damage(
      attacker,
      defender,
      input,
      rng,
      true,
      (avoidDefender ? 1 / 6 : 1) * attackerTacticDamage * defenderTactic.opposing,
    );
    const toAttacker = damage(
      defender,
      attacker,
      input,
      rng,
      false,
      (avoidAttacker ? 1 / 6 : 1) * defenderTacticDamage * attackerTactic.opposing,
    );
    attacker.crew -= toAttacker;
    defender.crew -= toDefender;
    result.phases?.push({
      kind: 'exchange',
      attackerLoss: toAttacker,
      defenderLoss: toDefender,
      ...openingSnipes,
      ...(avoidAttacker ? { attackerEvaded: true } : {}),
      ...(avoidDefender ? { defenderEvaded: true } : {}),
      ...(attackerTactic.critical ? { attackerCritical: true } : {}),
      ...(defenderTactic.critical ? { defenderCritical: true } : {}),
      ...(attackerTacticLog ? { attackerTactic: attackerTacticLog } : {}),
      ...(defenderTacticLog ? { defenderTactic: defenderTacticLog } : {}),
    });
    attacker.atmos = Math.max(0, attacker.atmos - BALANCE.BATTLE_ATMOS_LOSS);
    defender.atmos = Math.max(0, defender.atmos - BALANCE.BATTLE_ATMOS_LOSS);
  }
  return result;
}

function equipmentEvasion(force: BattleForce, equipment: EquipmentBattleEffects | undefined) {
  const leadership = equipment?.evasionLeadership;
  return leadership ? Math.min(0.5, Math.max(0, (1 - force.crew / (100 * leadership)) * 0.5)) : 0;
}

function snipeInjury(injury: number, [min, max]: readonly [number, number], rng: Rng) {
  return Math.max(injury, Math.min(80, injury + rng.int(min, max)));
}

function reflectedTactic(
  tactic: ReturnType<typeof rollBattleTactics>,
  equipment: EquipmentBattleEffects | undefined,
  rng: Rng,
) {
  if (tactic.tactic?.success && equipment?.counterTactics && rng.next() < equipment.counterTactics)
    return { dealt: tactic.dealt, tactic: { name: `반계(${tactic.tactic.name})`, success: true } };
}
