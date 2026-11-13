import { z } from 'zod';
import { BALANCE } from '../balance';
import type { RecordedInput, ReplayState } from '../replay';

export const DEFENSE_STANCE_FEATURE = 'defense-stance-v1';
export const DEFENSE_STANCE_KIND = 'general.setDefenseStance';
export const DEFENSE_STANCES = [90, 80, 60, 40, 999] as const;
const DEFAULT_DEFENSE_STANCE = 80;
const DISABLED_DEFENSE_STANCE = 999;
const stanceSchema = z.literal(DEFENSE_STANCES);
export const defenseStanceInput = z.strictObject({ threshold: stanceSchema });

export function defenseRequirements(enabled: boolean, threshold: number | null | undefined) {
  const stance = enabled ? (threshold ?? DEFAULT_DEFENSE_STANCE) : null;
  return {
    enabled: stance !== DISABLED_DEFENSE_STANCE,
    minimumTraining: stance ?? BALANCE.DEFEND_TRAIN,
    minimumMorale: stance ?? BALANCE.DEFEND_ATMOS,
  };
}

export function canDefend(
  troops: number,
  training: number,
  morale: number,
  stanceEnabled = false,
  threshold?: number | null,
) {
  const limits = defenseRequirements(stanceEnabled, threshold);
  return limits.enabled && troops > 0 && training >= limits.minimumTraining && morale >= limits.minimumMorale;
}

export function storedDefenseStance(enabled: boolean, value: number | null) {
  if (value === null) return {};
  if (!enabled) throw new Error('수비 설정을 끈 월드에 저장된 기준이 있습니다.');
  return { defenseThreshold: stanceSchema.parse(value) };
}

export function applyDefenseStance(replay: ReplayState, input: RecordedInput): ReplayState {
  const { threshold } = defenseStanceInput.parse(input.payload);
  const result = defenseStanceInput.parse(input.result);
  const general = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  if (!general || general.userId === null || general.removedAt !== undefined || result.threshold !== threshold)
    throw new Error('장수의 수비 기준 기록이 올바르지 않습니다.');
  const next = structuredClone(replay);
  next.state.generals[general.id]!.defenseThreshold = threshold;
  return next;
}
