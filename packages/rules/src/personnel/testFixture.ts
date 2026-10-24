import { commandWorld } from '../../test/commandFixture';
import type { PersonnelResult, PersonnelState } from './types';

export function personnelWorld(): PersonnelState {
  const state = commandWorld();
  state.generals[3] = { ...state.generals[3]!, nationId: 1, cityKey: 1, userId: 'target', dedication: 95 };
  state.generals[4] = { ...state.generals[4]!, nationId: 1, cityKey: 1, officerLevel: 5, userId: 'issuer' };
  return state;
}

export function applied<T>(outcome: PersonnelResult<T>): Extract<PersonnelResult<T>, { ok: true }> {
  if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
  return outcome;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
