import { applyLandScore } from '../construction/land';
import { LAND_FIELDS, type LandField } from '../construction/catalog';
import { BALANCE } from '../balance';
import type { WorldState, WorldView } from '../model/world';
import { cloneWorld } from '../model/clone';

type Change<K extends string, F extends string> = { kind: K; id: number; field: F; op: 'add' | 'set'; value: number };
export type CityField = 'population' | 'agriculture' | 'commerce' | 'security' | 'defence' | 'wall' | 'trust';
export type Effect =
  | { kind: 'world'; state: WorldState }
  | Change<'city', CityField | 'state' | 'stateTerm'>
  | Change<'nation', 'gold' | 'rice' | 'tech'>
  | Change<'general', 'gold' | 'rice' | 'crew' | 'train' | 'atmos' | 'experience' | 'dedication' | 'injury'>;

export function applyEffects(state: WorldView, effects: readonly Effect[]): WorldState {
  let next: WorldState | undefined;
  for (const effect of effects) {
    if (effect.kind === 'world') {
      next = cloneWorld(effect.state);
      continue;
    }
    if (!Number.isFinite(effect.value)) throw new Error('효과 값은 유한한 수여야 합니다.');
    next ??= cloneWorld(state);
    if (
      effect.kind === 'city' &&
      LAND_FIELDS.includes(effect.field as LandField) &&
      applyLandScore(next, effect.id, effect.field as LandField, effect.op, effect.value)
    )
      continue;
    const entity =
      effect.kind === 'city'
        ? next.cities[effect.id]
        : effect.kind === 'nation'
          ? next.nations[effect.id]
          : next.generals[effect.id];
    if (!entity) throw new Error('효과 대상이 없습니다.');
    const values = entity as unknown as Record<string, number>;
    const old = values[effect.field] ?? (['state', 'stateTerm'].includes(effect.field) ? 0 : undefined);
    if (typeof old !== 'number') throw new Error('효과 필드가 올바르지 않습니다.');
    let max = Infinity;
    if (effect.kind === 'city')
      max =
        effect.field === 'trust'
          ? BALANCE.MAX_TRUST
          : effect.field === 'state'
            ? 49
            : effect.field === 'stateTerm'
              ? 2_147_483_647
              : values[`${effect.field}Max`]!;
    if (effect.kind === 'nation' && effect.field === 'tech') max = BALANCE.MAX_TECH;
    if (effect.kind === 'general' && ['train', 'atmos', 'injury'].includes(effect.field)) max = 100;
    const value = Math.max(0, Math.min(max, effect.op === 'add' ? old + effect.value : effect.value));
    values[effect.field] = ['trust', 'tech'].includes(effect.field) ? value : Math.round(value);
  }
  return next ?? cloneWorld(state);
}
