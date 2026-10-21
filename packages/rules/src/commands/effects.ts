import { BALANCE } from '../balance';
import type { WorldState } from '../model/world';

type Change<K extends string, F extends string> = { kind: K; id: number; field: F; op: 'add' | 'set'; value: number };
export type CityField = 'population' | 'agriculture' | 'commerce' | 'security' | 'defence' | 'wall' | 'trust';
export type Effect =
  | { kind: 'world'; state: WorldState }
  | Change<'city', CityField>
  | Change<'nation', 'gold' | 'rice' | 'tech'>
  | Change<'general', 'gold' | 'rice' | 'crew' | 'train' | 'atmos' | 'experience' | 'dedication' | 'injury'>;

export function applyEffects(state: WorldState, effects: readonly Effect[]): WorldState {
  let next = structuredClone(state);
  for (const effect of effects) {
    if (effect.kind === 'world') {
      next = structuredClone(effect.state);
      continue;
    }
    if (!Number.isFinite(effect.value)) throw new Error('효과 값은 유한한 수여야 합니다.');
    const entity =
      effect.kind === 'city'
        ? next.cities[effect.id]
        : effect.kind === 'nation'
          ? next.nations[effect.id]
          : next.generals[effect.id];
    if (!entity) throw new Error('효과 대상이 없습니다.');
    const values = entity as unknown as Record<string, number>;
    const old = values[effect.field];
    if (typeof old !== 'number') throw new Error('효과 필드가 올바르지 않습니다.');
    let max = Infinity;
    if (effect.kind === 'city') max = effect.field === 'trust' ? BALANCE.MAX_TRUST : values[`${effect.field}Max`]!;
    if (effect.kind === 'nation' && effect.field === 'tech') max = BALANCE.MAX_TECH;
    if (effect.kind === 'general' && ['train', 'atmos', 'injury'].includes(effect.field)) max = 100;
    const value = Math.max(0, Math.min(max, effect.op === 'add' ? old + effect.value : effect.value));
    values[effect.field] = ['trust', 'tech'].includes(effect.field) ? value : Math.round(value);
  }
  return next;
}
