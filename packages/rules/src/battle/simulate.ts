import type { Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import type { DeepReadonly } from '../model/world';
import type { UnitSetResource } from '../world/resources';

export type BattleForce = { crew: number; crewType: number; train: number; atmos: number };
export type BattleInput = {
  attacker: Readonly<BattleForce>;
  defender: Readonly<BattleForce>;
  attackerTech: number;
  defenderTech: number;
  defence?: number;
  unitSet: DeepReadonly<UnitSetResource>;
};

type Unit = DeepReadonly<UnitSetResource['crewTypes'][number]>;
function unit(unitSet: BattleInput['unitSet'], id: number): Unit {
  const result = unitSet.crewTypes.find((u) => u.id === id);
  if (!result) throw new Error('전투 병종이 없습니다.');
  return result;
}
function coefficient(table: Unit['attackCoef'], arm: number) {
  return Array.isArray(table) ? 1 : ((table as Readonly<Record<string, number>>)[String(arm)] ?? 1);
}
function damage(
  a: BattleForce,
  b: BattleForce,
  unitSet: BattleInput['unitSet'],
  rng: Rng,
  tech: number,
  defence: number,
) {
  const attacking = unit(unitSet, a.crewType),
    defending = unit(unitSet, b.crewType);
  const power =
    ((a.crew *
      (attacking.attack / Math.max(1, defending.defence + defence)) *
      coefficient(attacking.attackCoef, defending.armType)) /
      Math.max(0.01, coefficient(defending.defenceCoef, attacking.armType))) *
    ((50 + a.train) / 150) *
    ((50 + a.atmos) / 150) *
    (1 + tech / BALANCE.MAX_TECH) *
    BALANCE.DAMAGE_FACTOR *
    (0.9 + rng.next() * 0.2);
  return Math.min(b.crew, Math.max(1, Math.round(power)));
}
function copyForce(force: Readonly<BattleForce>): BattleForce {
  return { crew: force.crew, crewType: force.crewType, train: force.train, atmos: force.atmos };
}

export function simulateBattle(input: BattleInput, rng: Rng): { attacker: BattleForce; defender: BattleForce } {
  const { unitSet, attackerTech, defenderTech, defence = 0 } = input;
  const attacker = copyForce(input.attacker),
    defender = copyForce(input.defender);
  for (
    let phase = 0;
    phase < BALANCE.BATTLE_PHASES && attacker.crew > 0 && defender.crew > 0 && attacker.atmos > 0 && defender.atmos > 0;
    phase++
  ) {
    // 양쪽 피해는 같은 페이즈 시작 상태로 계산하고 동시에 적용한다.
    const toDefender = damage(attacker, defender, unitSet, rng, attackerTech, defence),
      toAttacker = damage(defender, attacker, unitSet, rng, defenderTech, 0);
    attacker.crew -= toAttacker;
    defender.crew -= toDefender;
    attacker.atmos = Math.max(0, attacker.atmos - BALANCE.BATTLE_ATMOS_LOSS);
    defender.atmos = Math.max(0, defender.atmos - BALANCE.BATTLE_ATMOS_LOSS);
  }
  return { attacker, defender };
}
