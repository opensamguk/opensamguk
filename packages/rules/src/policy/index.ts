import type { WorldView } from '../model/world';
import { commandRegistry } from '../commands/registry';
import { TICKS_PER_MONTH } from '../clock/constants';

export const POLICY_KEYS = ['farm', 'commerce', 'security', 'defend', 'drill', 'none'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];
export const INACTIVE_AFTER_DAYS = 14;

const definitions: Record<PolicyKey, { name: string; first: string; then?: string }> = {
  farm: { name: '권농', first: 'farm' },
  commerce: { name: '중상', first: 'commerce' },
  security: { name: '치안', first: 'security' },
  defend: { name: '수비', first: 'defence', then: 'wall' },
  drill: { name: '훈련', first: 'train', then: 'morale' },
  none: { name: '없음', first: 'rest' },
};

export function isPolicyKey(value: unknown): value is PolicyKey {
  return typeof value === 'string' && Object.hasOwn(definitions, value);
}

export function policyOptions() {
  const ref = (key: string) => ({ key, name: commandRegistry.get(key)!.name });
  return POLICY_KEYS.map((key) => ({
    key,
    name: definitions[key].name,
    emptyCommand: ref(definitions[key].first),
    thenCommand: definitions[key].then ? ref(definitions[key].then) : null,
  }));
}

export function isInactive(lastActiveTick: number, tick: number, turnTermMinutes: number): boolean {
  if (
    !Number.isSafeInteger(lastActiveTick) ||
    lastActiveTick < 0 ||
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    !Number.isSafeInteger(turnTermMinutes) ||
    turnTermMinutes <= 0
  )
    throw new Error('활동 tick과 턴 간격을 확인하세요.');
  return BigInt(tick - lastActiveTick) * BigInt(turnTermMinutes) > BigInt(INACTIVE_AFTER_DAYS * 1440 * TICKS_PER_MONTH);
}

export interface PolicySlot {
  commandKey: string;
  args: unknown;
  explicit: boolean;
}

// explicit이 없는 옛 휴식도 직접 넣은 휴식으로 읽는다.
export function normalizeSlot(slot: { commandKey: string; args: unknown; explicit?: boolean }): PolicySlot {
  return { ...slot, explicit: slot.explicit ?? true };
}

function equalArgs(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equalArgs(v, b[i]));
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalArgs(left[key], right[key]))
  );
}

export function sameSlot(a: PolicySlot, b: PolicySlot): boolean {
  if (!a.explicit || !b.explicit) return a.explicit === b.explicit;
  return a.commandKey === b.commandKey && equalArgs(a.args, b.args);
}

export function choosePolicyCommand(view: WorldView, generalId: number, policy: PolicyKey) {
  const general = view.generals[generalId];
  if (!general || general.userId === null) return null;
  const city = view.cities[general.cityKey];
  const maximum =
    policy === 'defend'
      ? city !== undefined && city.defence >= city.defenceMax
      : policy === 'drill' && general.train >= 100;
  const definition = definitions[policy];
  return { commandKey: maximum && definition.then ? definition.then : definition.first, args: {} };
}
