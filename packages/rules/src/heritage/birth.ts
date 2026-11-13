import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import { combatSpecialtyNames } from '../general/combatSpecialty';

export const HERITAGE_BIRTH_FEATURE = 'heritage-birth-v1';
// core2026 c81d304, app/game-engine/src/turn/joinCreateGeneralService.ts (MIT).
export const heritageBirthCosts = { cityKey: 1000, turnZone: 2500, specialty: 6000 } as const;
export const HERITAGE_BIRTH_ZONES = 60;
export const heritageBirthSchema = z
  .strictObject({
    cityKey: z.number().int().positive().max(2_147_483_647).optional(),
    turnZone: z
      .number()
      .int()
      .min(0)
      .max(HERITAGE_BIRTH_ZONES - 1)
      .optional(),
    specialty: z.enum(combatSpecialtyNames).optional(),
  })
  .refine((birth) => Object.values(birth).some((value) => value !== undefined));
export type HeritageBirth = z.infer<typeof heritageBirthSchema>;

export function heritageBirthCost(birth: HeritageBirth) {
  return (Object.keys(heritageBirthCosts) as Array<keyof HeritageBirth>).reduce(
    (cost, key) => cost + (birth[key] === undefined ? 0 : heritageBirthCosts[key]),
    0,
  );
}

export function heritageBirthZone(zone: number) {
  return {
    start: Math.floor((zone * TICKS_PER_MONTH) / HERITAGE_BIRTH_ZONES),
    end: Math.floor(((zone + 1) * TICKS_PER_MONTH) / HERITAGE_BIRTH_ZONES),
  };
}
