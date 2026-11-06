import type { Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import type { DeepReadonly } from '../model/world';
import type { UnitSetResource } from '../world/resources';
import { applyModifiers, type BattleModifiers } from '../modifiers';

export type BattleForce = { crew: number; crewType: number; train: number; atmos: number };
export type BattleInput = {
  attacker: Readonly<BattleForce>;
  defender: Readonly<BattleForce>;
  attackerTech: number;
  defenderTech: number;
  defence?: number;
  unitSet: DeepReadonly<UnitSetResource>;
  coefMode?: 'divide' | 'multiply';
  attackerModifiers?: BattleModifiers;
  defenderModifiers?: BattleModifiers;
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
function damage(a: BattleForce, b: BattleForce, input: BattleInput, rng: Rng, attackingSide: boolean, scale = 1) {
  const { unitSet } = input;
  const attacking = unit(unitSet, a.crewType),
    defending = unit(unitSet, b.crewType);
  const multiply = input.coefMode === 'multiply';
  const tech = attackingSide ? input.attackerTech : input.defenderTech;
  const defence = attackingSide ? (input.defence ?? 0) : 0;
  const attackPower =
    a.crew *
    (attacking.attack / Math.max(1, defending.defence + defence)) *
    coefficient(attacking.attackCoef, defending, multiply);
  const defenceCoef = coefficient(defending.defenceCoef, attacking, multiply);
  let power =
    (multiply ? attackPower * defenceCoef : attackPower / Math.max(0.01, defenceCoef)) *
    ((50 + a.train) / 150) *
    ((50 + a.atmos) / 150) *
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
  power *= scale;
  const attackerModifiers = attackingSide ? input.attackerModifiers : input.defenderModifiers;
  const defenderModifiers = attackingSide ? input.defenderModifiers : input.attackerModifiers;
  power = applyModifiers(power, attackerModifiers?.dealt ?? []);
  power = applyModifiers(power, defenderModifiers?.taken ?? []);
  return Math.min(b.crew, Math.max(1, Math.round(power)));
}
function copyForce(force: Readonly<BattleForce>): BattleForce {
  return { crew: force.crew, crewType: force.crewType, train: force.train, atmos: force.atmos };
}

export function simulateBattle(input: BattleInput, rng: Rng): { attacker: BattleForce; defender: BattleForce } {
  const { unitSet } = input;
  const attacker = copyForce(input.attacker),
    defender = copyForce(input.defender);
  const canFight = () => attacker.crew > 0 && defender.crew > 0 && attacker.atmos > 0 && defender.atmos > 0;
  if (!canFight()) return { attacker, defender };
  const aUnit = unit(unitSet, attacker.crewType),
    bUnit = unit(unitSet, defender.crewType);
  if (aUnit.effects?.includes('firstVolley') || bUnit.effects?.includes('firstVolley')) {
    const toDefender = aUnit.effects?.includes('firstVolley') ? damage(attacker, defender, input, rng, true, 2 / 3) : 0,
      toAttacker = bUnit.effects?.includes('firstVolley') ? damage(defender, attacker, input, rng, false, 2 / 3) : 0;
    attacker.crew -= toAttacker;
    defender.crew -= toDefender;
  }
  let held = false;
  for (let phase = 0; phase < BALANCE.BATTLE_PHASES && canFight(); phase++) {
    if (bUnit.effects?.includes('hold') && !held && rng.next() < (defender.train + defender.atmos) / 400) {
      held = true;
      continue;
    }
    const avoidAttacker = aUnit.effects?.includes('avoid') && rng.next() < aUnit.avoid / 100;
    const avoidDefender = bUnit.effects?.includes('avoid') && rng.next() < bUnit.avoid / 100;
    // 양쪽 피해는 같은 페이즈 시작 상태로 계산하고 동시에 적용한다.
    const toDefender = damage(attacker, defender, input, rng, true, avoidDefender ? 1 / 6 : 1),
      toAttacker = damage(defender, attacker, input, rng, false, avoidAttacker ? 1 / 6 : 1);
    attacker.crew -= toAttacker;
    defender.crew -= toDefender;
    attacker.atmos = Math.max(0, attacker.atmos - BALANCE.BATTLE_ATMOS_LOSS);
    defender.atmos = Math.max(0, defender.atmos - BALANCE.BATTLE_ATMOS_LOSS);
  }
  return { attacker, defender };
}
