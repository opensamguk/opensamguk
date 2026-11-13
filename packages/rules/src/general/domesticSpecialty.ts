import type { WorldView } from '../model/world';

export const DOMESTIC_SPECIALTY_FEATURE = 'domestic-specialty-v1';
const specialties: Record<string, readonly string[]> = {
  경작: ['farm'],
  상재: ['commerce'],
  통찰: ['security'],
  인덕: ['goodwill', 'settle'],
  수비: ['defence'],
  축성: ['wall'],
  발명: ['research'],
  귀모: ['stratagem'],
};

export function domesticSpecialtyNames() {
  return Object.keys(specialties);
}

export function domesticSpecialty(view: Pick<WorldView, 'ruleFeatures'>, key: string | null | undefined) {
  const name = key?.replace(/^che_/, '');
  if (!view.ruleFeatures?.includes(DOMESTIC_SPECIALTY_FEATURE) || !name || !Object.hasOwn(specialties, name))
    return undefined;
  const commands = specialties[name]!;
  return name === '귀모'
    ? { name, commands, score: 1, cost: 1, successBonus: 0.2 }
    : { name, commands, score: 1.1, cost: 0.8, successBonus: 0.1 };
}

export function domesticSpecialtyFor(view: WorldView, general: WorldView['generals'][number], key: string) {
  const trait = domesticSpecialty(view, general.special);
  return trait?.commands.includes(key) ? trait : undefined;
}
