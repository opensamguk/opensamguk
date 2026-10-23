import type { WorldView } from '../model/world';
import { modifierProviders } from './providers';

export type ModifierStage = 'domestic.score' | 'battle.dealt' | 'battle.taken';
export type ModifierOp = 'add' | 'mul';
export interface Modifier {
  source: string;
  op: ModifierOp;
  value: number;
}
export interface ModifierContext {
  stage: ModifierStage;
  commandKey: string;
}
export type ModifierProvider = (view: WorldView, generalId: number, context: ModifierContext) => readonly Modifier[];
export interface BattleModifiers {
  dealt?: readonly Modifier[];
  taken?: readonly Modifier[];
}

export function applyModifiers(base: number, modifiers: readonly Modifier[], options?: { min?: number }): number {
  if (modifiers.length === 0) return base;
  if (!Number.isFinite(base) || (options?.min !== undefined && !Number.isFinite(options.min))) {
    throw new Error('수정할 값과 하한은 유한한 수여야 합니다.');
  }
  const seen = new Set<string>();
  for (const modifier of modifiers) {
    if (
      typeof modifier.source !== 'string' ||
      /^[a-z][a-z0-9_]*:[a-z0-9_-]{1,48}$/.exec(modifier.source)?.[0] !== modifier.source ||
      (modifier.op !== 'add' && modifier.op !== 'mul') ||
      !Number.isFinite(modifier.value) ||
      (modifier.op === 'mul' && modifier.value < 0)
    ) {
      throw new Error('수정자 형식이 올바르지 않습니다.');
    }
    const key = `${modifier.source}:${modifier.op}`;
    if (seen.has(key)) throw new Error('같은 출처의 수정 연산이 중복됐습니다.');
    seen.add(key);
  }
  const ordered = [...modifiers].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.op === b.op ? 0 : a.op === 'add' ? -1 : 1,
  );
  let value = base;
  for (const modifier of ordered) if (modifier.op === 'add') value += modifier.value;
  for (const modifier of ordered) if (modifier.op === 'mul') value *= modifier.value;
  if (!Number.isFinite(value)) throw new Error('수정 결과가 유한한 수 범위를 넘었습니다.');
  return options?.min === undefined ? value : Math.max(options.min, value);
}

export function collectModifiers(view: WorldView, generalId: number, context: ModifierContext): Modifier[] {
  return collectModifiersWith(modifierProviders, view, generalId, context);
}

export function collectModifiersWith(
  providers: readonly ModifierProvider[],
  view: WorldView,
  generalId: number,
  context: ModifierContext,
): Modifier[] {
  return providers.flatMap((provider) => [...provider(view, generalId, context)]);
}
