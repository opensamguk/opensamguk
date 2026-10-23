import type { PresetRules } from '../world/preset';
import type { TreatyState } from '../diplomacy/treatyTypes';
import { cloneExtStateWithRegistry, extSlices, extCommandBindings, type ExtStateRegistry } from '../commands/ext/state';
import type { InitialCity, InitialGeneral, InitialNation, InitialDiplomacy, WorldInit } from '../world/bootstrap';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WorldExt = Record<string, JsonValue>;
export interface AssignmentOffer {
  id: string;
  nationId: number;
  issuerGeneralId: number;
  cityKey: number;
  createdTick: number;
  expiresTick: number;
}
export type OfficeTurns = Record<number, Record<number, { commandKey: string; args: unknown }[]>>;
export type OfficeRevisions = Record<number, Record<number, { revision: number; tenure: number }>>;
export interface WorldState {
  presetRules?: PresetRules;
  ext?: WorldExt;
  startYear: number;
  cities: Record<number, InitialCity>;
  nations: Record<number, InitialNation>;
  generals: Record<number, InitialGeneral>;
  diplomacies: InitialDiplomacy[];
  treaties?: TreatyState[];
  commandMeta?: { nextNationId: number; offers: Record<number, number> };
  nationTurns?: Record<number, { commandKey: string; args: unknown }[]>;
  assignmentOffers?: Record<number, AssignmentOffer>;
  officeTurns?: OfficeTurns;
}
type DeepReadonlyFields<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type DeepReadonly<T> = [T] extends [JsonValue]
  ? [JsonValue] extends [T]
    ? ReadonlyJsonValue
    : DeepReadonlyFields<T>
  : DeepReadonlyFields<T>;
type ReadonlyJsonValue = null | boolean | number | string | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
interface ReadonlyJsonObject {
  readonly [key: string]: ReadonlyJsonValue;
}
// 재귀 JSON의 mapped type을 매번 펼치지 않고 깊은 읽기 전용 경계를 유지한다.
export type WorldView = DeepReadonly<WorldState>;
export function toWorldState(initial: WorldInit): WorldState {
  return toWorldStateWithRegistry(initial, { slices: extSlices, bindings: extCommandBindings });
}

export function toWorldStateWithRegistry(initial: WorldInit, registry: ExtStateRegistry): WorldState {
  const ext = Object.hasOwn(initial, 'ext') ? cloneExtStateWithRegistry(initial.ext, registry) : undefined;
  const state = structuredClone(initial);
  return {
    ...(ext ? { ext } : {}),
    ...(state.presetRules ? { presetRules: state.presetRules } : {}),
    startYear: state.startYear,
    cities: Object.fromEntries(state.cities.map((city) => [city.cityKey, city])),
    nations: Object.fromEntries(state.nations.map((nation) => [nation.id, nation])),
    generals: Object.fromEntries(state.generals.map((general) => [general.id, general])),
    diplomacies: state.diplomacies,
    ...(state.commandMeta ? { commandMeta: state.commandMeta } : {}),
    ...(state.nationTurns ? { nationTurns: state.nationTurns } : {}),
  };
}
