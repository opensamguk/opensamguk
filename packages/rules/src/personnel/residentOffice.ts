import { z } from 'zod';
import { officeEffectsConfig } from './office-effects';
import type { WorldState, WorldView } from '../model/world';
import type { InitialGeneral } from '../world/bootstrap';

export const OFFICE_EFFECTS_FEATURE = 'office-effects';
const percent = z.number().int().min(0).max(50);
const officeEffectsBase = z.strictObject({
  version: z.literal(1),
  minimumAbility: z.number().int().positive().max(100),
  tax: z.strictObject({ 3: percent, 4: percent, 11: percent }),
  supplyLoss: z.strictObject({ 5: percent, 6: percent, 7: percent, 8: percent, 9: percent, 10: percent }),
});
export const officeEffectsSchema = z.union([
  officeEffectsBase.extend({ secretary: z.literal(true) }),
  officeEffectsBase,
]);
export const defaultOfficeEffects = officeEffectsSchema.parse(officeEffectsConfig);
export type OfficeEffects = z.infer<typeof officeEffectsSchema>;
export const hasCitySecretary = (effects: OfficeEffects | undefined): boolean =>
  effects !== undefined && 'secretary' in effects;
const localOfficeTitles = { 2: '종사', 3: '군사', 4: '태수' } as const;
type LocalOfficeLevel = keyof typeof localOfficeTitles;
export const isLocalOffice = (level: number): level is LocalOfficeLevel => Object.hasOwn(localOfficeTitles, level);
export const localOfficeTitle = (level: LocalOfficeLevel) => localOfficeTitles[level];

export function localOfficeAbility(
  general: Pick<InitialGeneral, 'officerLevel' | 'strength' | 'intel'>,
  level: LocalOfficeLevel,
  minimum: number,
): boolean {
  // 원작 officeRequest의 종사(2)에는 무력·지력 문턱이 없다.
  return general.officerLevel <= 1 && (level === 2 || (level === 4 ? general.strength : general.intel) >= minimum);
}

export function isOfficeResident(
  general: Pick<InitialGeneral, 'nationId' | 'officerLevel' | 'officerCityKey' | 'cityKey'>,
  cityNationId: number | null,
): boolean {
  if (general.nationId === null || cityNationId !== general.nationId) return false;
  if (isLocalOffice(general.officerLevel)) return general.cityKey === general.officerCityKey;
  return general.officerLevel >= 5 && general.officerLevel <= 11;
}

type Bonus = { percent: number; generalId: number };
export type OfficeBonuses = Map<number, { tax?: Bonus; supplyLoss?: Bonus }>;

export function residentOfficeBonuses(state: WorldView, year: number): OfficeBonuses {
  const bonuses: OfficeBonuses = new Map();
  if (!state.officeEffects) return bonuses;
  for (const general of Object.values(state.generals)) {
    const city = state.cities[general.cityKey];
    if (!city || city.kind === 'PASS' || general.removedAt !== undefined || general.activeFromYear > year) continue;
    if (!isOfficeResident(general, city.nationId)) continue;
    const effects = bonuses.get(city.cityKey) ?? {};
    for (const target of ['tax', 'supplyLoss'] as const) {
      const rates: Readonly<Partial<Record<number, number>>> = state.officeEffects[target];
      const percent = rates[general.officerLevel] ?? 0;
      const current = effects[target];
      if (
        percent > 0 &&
        (!current || current.percent < percent || (current.percent === percent && general.id < current.generalId))
      )
        effects[target] = { percent, generalId: general.id };
    }
    bonuses.set(city.cityKey, effects);
  }
  return bonuses;
}

export function clearLostCityOffices(before: WorldView, state: WorldState): void {
  if (!state.officeEffects) return;
  for (const general of Object.values(state.generals)) {
    if (general.officerCityKey == null) continue;
    const city = state.cities[general.officerCityKey];
    if (
      isLocalOffice(general.officerLevel) &&
      general.removedAt === undefined &&
      general.nationId !== null &&
      city?.nationId === general.nationId &&
      before.generals[general.id]?.nationId === general.nationId
    )
      continue;
    if (isLocalOffice(general.officerLevel)) general.officerLevel = general.nationId === null ? 0 : 1;
    delete general.officerCityKey;
  }
}
