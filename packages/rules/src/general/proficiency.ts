import { z } from 'zod';
import type { WorldView, WorldState } from '../model/world';

export const GENERAL_PROFICIENCY_FEATURE = 'general-proficiency-v1';
const max = 2_147_483_647;
const proficiencySchema = z.record(z.string().regex(/^[1-9][0-9]*$/), z.number().int().min(0).max(max));
export type GeneralProficiency = z.infer<typeof proficiencySchema>;
const thresholds = [
  0, 350, 1375, 3500, 7125, 12650, 20475, 31000, 44625, 61750, 82775, 108100, 138125, 173250, 213875, 260400, 313225,
  372750, 439375, 513500, 595525, 685850, 784875, 893000, 1010625, 1138150, 1275975,
];
const grades = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'Z', 'EX'].flatMap((letter) => [letter + '-', letter, letter + '+']);

export function proficiencyGrade(value: number) {
  const index = thresholds.findLastIndex((limit) => value >= limit);
  const floor = thresholds[index]!;
  const next = thresholds[index + 1];
  return {
    value,
    grade: grades[index]!,
    nextGrade: grades[index + 1] ?? null,
    progress: next === undefined ? 100 : ((value - floor) * 100) / (next - floor),
    overall: Math.min(100, (value * 100) / thresholds.at(-1)!),
  };
}

export function storedGeneralProficiency(enabled: boolean, raw: unknown) {
  if (raw == null) return {};
  if (!enabled) throw new Error('병종 숙련을 끈 월드에 저장된 숙련이 있습니다.');
  return { proficiency: proficiencySchema.parse(raw) };
}

export function addGeneralProficiency(
  state: Pick<WorldView, 'ruleFeatures'>,
  general: WorldState['generals'][number],
  armType: number,
  amount: number,
) {
  if (!state.ruleFeatures?.includes(GENERAL_PROFICIENCY_FEATURE) || armType <= 0) return;
  const gain = Math.floor(armType === 4 || armType === 5 ? amount * 0.9 : amount);
  if (gain <= 0) return;
  const proficiency = (general.proficiency ??= {});
  proficiency[armType] = Math.min(max, (proficiency[armType] ?? 0) + gain);
}

export function proficiencyConversion(source: number, target: number) {
  const cut = Math.floor(source * 0.4);
  const gain = Math.min(max - target, Math.floor(cut * 0.9));
  return { cut, gain, source: source - cut, target: target + gain };
}
