import type { Rng } from '@opensamguk/shared';
import type { WorldView } from '../model/world';
import type { CombatSpecialty } from '../general/combatSpecialty';
import type { HeritageBenefits } from '../heritage/benefits';

export const BATTLE_TACTICS_FEATURE = 'battle-tactics-v1';
type Stats = { leadership: number; strength: number; intel: number };
type Unit = { armType: number; magicCoef: number };
export function battleTacticsStats(world: Pick<WorldView, 'ruleFeatures'>, general: Stats) {
  return world.ruleFeatures?.includes(BATTLE_TACTICS_FEATURE)
    ? { leadership: general.leadership, strength: general.strength, intel: general.intel }
    : undefined;
}

const fieldTactics = [
  ['위보', 1.2, 1.1],
  ['매복', 1.4, 1.2],
  ['반목', 1.6, 1.3],
  ['화계', 1.8, 1.4],
  ['혼란', 2.0, 1.5],
] as const;
const siegeTactics = [
  ['급습', 1.2, 1.1],
  ['위보', 1.4, 1.2],
  ['혼란', 1.6, 1.3],
] as const;

export type PhaseTactic = { name: string; success: boolean };

export function rollBattleTactics(
  stats: Stats | undefined,
  unit: Unit,
  target: Unit,
  specialty: CombatSpecialty | undefined,
  opposingSpecialty: CombatSpecialty | undefined,
  heritage: HeritageBenefits | undefined,
  opposingHeritage: HeritageBenefits | undefined,
  first: boolean,
  rng: Rng,
) {
  if (!stats || unit.armType === 0) return { dealt: 1, opposing: 1, ignoresEvasion: false };
  const trait = specialty?.name;
  const opponent = opposingSpecialty?.name;
  let trial =
    (stats.intel * unit.magicCoef) / 100 +
    ((heritage?.tactics ?? 0) - (opposingHeritage?.opponentTactics ?? 0)) / 100 +
    (trait === '신산' ? 0.2 : 0);
  if (first && stats.intel * 3 >= stats.leadership + stats.strength + stats.intel) trial *= 3;
  if (trial > 0 && rng.next() < trial) {
    const table = target.armType === 0 ? siegeTactics : fieldTactics;
    const [name, successDamage, failureDamage] = table[Math.floor(rng.next() * table.length)]!;
    const successChance =
      0.7 +
      (trait === '신산' || trait === '귀병' ? 0.2 : trait === '환술' ? 0.1 : 0) -
      (opponent === '견고' || opponent === '반계' ? 0.1 : 0);
    const success = rng.next() < successChance;
    return {
      dealt: success ? successDamage * (trait === '환술' ? 1.3 : 1) : 1 / failureDamage,
      opposing: success ? 1 : failureDamage,
      ignoresEvasion: false,
      tactic: { name, success } satisfies PhaseTactic,
    };
  }
  const main = unit.armType === 4 ? stats.intel : unit.armType === 5 ? stats.leadership : stats.strength;
  const coefficient = unit.armType >= 4 ? 0.4 : 0.5;
  const critical =
    Math.min(50, Math.max(0, main - 65) * coefficient) / 100 +
    ((heritage?.critical ?? 0) - (opposingHeritage?.opponentCritical ?? 0)) / 100 +
    (trait === '필살' ? 0.3 : trait === '무쌍' ? 0.1 : 0) -
    (opponent === '견고' ? 0.2 : 0);
  if (critical > 0 && rng.next() < critical) {
    const min = trait === '필살' ? 1.65 : 1.3;
    return { dealt: min + rng.next() * (2 - min), opposing: 1, critical: true, ignoresEvasion: trait === '필살' };
  }
  return { dealt: 1, opposing: 1, ignoresEvasion: false };
}
