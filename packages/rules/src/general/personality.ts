import type { WorldView } from '../model/world';

export const GENERAL_PERSONALITY_FEATURE = 'general-personality-v1';

type Effects = {
  train?: number;
  morale?: number;
  recruitPercent?: number;
  experiencePercent?: number;
  dedicationPercent?: number;
};

const personalities: Record<string, Effects> = {
  대의: { experiencePercent: 110, train: -5 },
  안전: { morale: -5, recruitPercent: 80 },
  왕좌: { experiencePercent: 110, morale: -5 },
  유지: { train: -5, recruitPercent: 80 },
  은둔: { experiencePercent: 90, dedicationPercent: 90, morale: -5, train: -5 },
  의협: { morale: 5, recruitPercent: 120 },
  재간: { experiencePercent: 90, recruitPercent: 80 },
  정복: { experiencePercent: 90, morale: 5 },
  출세: { experiencePercent: 110, recruitPercent: 120 },
  패권: { train: 5, recruitPercent: 120 },
  할거: { experiencePercent: 90, train: 5 },
};

export function personalityEffects(view: Pick<WorldView, 'ruleFeatures'>, key: string | null | undefined) {
  const name = key?.replace(/^che_/, '');
  if (!view.ruleFeatures?.includes(GENERAL_PERSONALITY_FEATURE) || !name || !Object.hasOwn(personalities, name))
    return undefined;
  return { name, ...personalities[name] };
}

export function applyPersonalityProgress(
  view: WorldView,
  next: WorldView['generals'][number] & {
    experience: number;
    dedication: number;
  },
  before: WorldView['generals'][number],
) {
  const effects = personalityEffects(view, before.personality);
  if (!effects) return;
  const experience = next.experience - before.experience;
  const dedication = next.dedication - before.dedication;
  if (experience > 0 && effects.experiencePercent !== undefined)
    next.experience = before.experience + Math.round((experience * effects.experiencePercent) / 100);
  if (dedication > 0 && effects.dedicationPercent !== undefined)
    next.dedication = before.dedication + Math.round((dedication * effects.dedicationPercent) / 100);
}
