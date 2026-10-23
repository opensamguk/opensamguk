import type { DeepReadonly, JsonValue, WorldExt, WorldState } from '../../model/world';
import type { EnabledCommands } from '../resolve';

export type ExtInitContext = DeepReadonly<Omit<WorldState, 'ext'>>;
export interface ExtSlice<T extends JsonValue = JsonValue> {
  key: string;
  create(context: ExtInitContext): T;
  clone(value: DeepReadonly<T>): T;
  validate(value: unknown): value is T;
}
export interface ExtStateRegistry {
  slices: readonly ExtSlice[];
  bindings: readonly {
    commandKey: string;
    target: 'general' | 'nation';
    sliceKeys: readonly string[];
  }[];
}
export const extSlices: readonly ExtSlice[] = [];
export const extCommandBindings: ExtStateRegistry['bindings'] = [];
const reserved = new Set(['__proto__', 'constructor', 'prototype']);

function fail(key: string): never {
  throw new Error(`확장 상태를 확인하세요: ${key}`);
}

function assertJson(value: unknown, key: string, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) fail(key);
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail(key);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) fail(key);
  ancestors.add(value);
  for (const field of keys) {
    if (array && field === 'length') continue;
    if (typeof field !== 'string' || reserved.has(field)) fail(key);
    if (array && (!/^(0|[1-9]\d*)$/.test(field) || Number(field) >= value.length)) fail(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, field)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(key);
    assertJson(descriptor.value, key, ancestors);
  }
  ancestors.delete(value);
}

function validateValue(slice: ExtSlice, value: unknown): asserts value is JsonValue {
  assertJson(value, slice.key);
  if (!slice.validate(value)) fail(slice.key);
}

function validateRegistry(registry: ExtStateRegistry) {
  const slices = new Map<string, ExtSlice>();
  for (const slice of registry.slices) {
    if (slices.has(slice.key) || reserved.has(slice.key)) fail(slice.key);
    slices.set(slice.key, slice);
  }
  const commands = new Set<string>();
  for (const binding of registry.bindings) {
    if (commands.has(binding.commandKey)) fail(binding.commandKey);
    commands.add(binding.commandKey);
    const seen = new Set<string>();
    for (const key of binding.sliceKeys) {
      if (!slices.has(key) || seen.has(key)) fail(`${binding.commandKey}/${key}`);
      seen.add(key);
    }
  }
}

export function createExtState(enabled: EnabledCommands | null, context: ExtInitContext): WorldExt | undefined {
  return createExtStateWithRegistry(enabled, context, { slices: extSlices, bindings: extCommandBindings });
}

export function extSliceKeys(enabled: EnabledCommands | null): string[] {
  return extSliceKeysWithRegistry(enabled, { slices: extSlices, bindings: extCommandBindings });
}

export function extSliceKeysWithRegistry(enabled: EnabledCommands | null, registry: ExtStateRegistry): string[] {
  validateRegistry(registry);
  if (enabled === null) return [];
  const bindings = new Map(registry.bindings.map((binding) => [binding.commandKey, binding]));
  const selected = new Set<string>();
  const seen = new Set<string>();
  for (const target of ['general', 'nation'] as const) {
    for (const key of enabled[target]) {
      const binding = bindings.get(key);
      if (!binding || binding.target !== target || seen.has(key)) fail(key);
      seen.add(key);
      for (const sliceKey of binding.sliceKeys) selected.add(sliceKey);
    }
  }
  return [...selected].sort();
}

export function restoreExtState(enabled: EnabledCommands | null, raw: unknown): WorldExt | undefined {
  return restoreExtStateWithRegistry(enabled, raw, { slices: extSlices, bindings: extCommandBindings });
}

export function restoreExtStateWithRegistry(
  enabled: EnabledCommands | null,
  raw: unknown,
  registry: ExtStateRegistry,
): WorldExt | undefined {
  const expected = extSliceKeysWithRegistry(enabled, registry);
  if (expected.length === 0) {
    if (raw !== undefined) fail('ext');
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') fail('ext');
  const actual = Reflect.ownKeys(raw);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(raw, key))) fail('ext');
  return cloneExtStateWithRegistry(raw, registry);
}

// 내부 helper는 시험에서만 다른 목록을 받는다. 명령 정의를 import하면 clone 경로가 순환한다.
export function createExtStateWithRegistry(
  enabled: EnabledCommands | null,
  context: ExtInitContext,
  registry: ExtStateRegistry,
): WorldExt | undefined {
  const selected = new Set(extSliceKeysWithRegistry(enabled, registry));
  if (selected.size === 0) return undefined;
  const ext: WorldExt = {};
  for (const slice of registry.slices) {
    if (!selected.has(slice.key)) continue;
    const value = slice.create(context);
    validateValue(slice, value);
    const detached = structuredClone(value);
    validateValue(slice, detached);
    ext[slice.key] = detached;
  }
  return ext;
}

export function cloneExtStateWithRegistry(ext: unknown, registry: ExtStateRegistry): WorldExt {
  validateRegistry(registry);
  if (ext === null || typeof ext !== 'object') fail('ext');
  const proto = Object.getPrototypeOf(ext);
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(ext).length === 0) fail('ext');
  const known = new Set(registry.slices.map((slice) => slice.key));
  for (const key of Reflect.ownKeys(ext)) {
    if (typeof key !== 'string') fail('ext');
    if (!known.has(key)) fail(key);
    const descriptor = Object.getOwnPropertyDescriptor(ext, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(key);
  }
  const result: WorldExt = {};
  for (const slice of registry.slices) {
    if (!Object.hasOwn(ext, slice.key)) continue;
    const value: unknown = Object.getOwnPropertyDescriptor(ext, slice.key)!.value;
    validateValue(slice, value);
    const cloned = slice.clone(value);
    validateValue(slice, cloned);
    const detached = structuredClone(cloned);
    validateValue(slice, detached);
    result[slice.key] = detached;
  }
  return result;
}
