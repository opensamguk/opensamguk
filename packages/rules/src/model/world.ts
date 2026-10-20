import type { InitialCity, InitialGeneral, InitialNation, InitialDiplomacy, WorldInit } from '../world/bootstrap';
export interface WorldState {
  startYear: number;
  cities: Record<number, InitialCity>;
  nations: Record<number, InitialNation>;
  generals: Record<number, InitialGeneral>;
  diplomacies: InitialDiplomacy[];
}
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type WorldView = DeepReadonly<WorldState>;
export function toWorldState(initial: WorldInit): WorldState {
  const state = structuredClone(initial);
  return { startYear: state.startYear,
    cities: Object.fromEntries(state.cities.map((city) => [city.cityKey, city])),
    nations: Object.fromEntries(state.nations.map((nation) => [nation.id, nation])),
    generals: Object.fromEntries(state.generals.map((general) => [general.id, general])),
    diplomacies: state.diplomacies };
}
