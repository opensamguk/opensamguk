import { isProxy } from 'node:util/types';
import { assertStorableJson, type StorableJson } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';

export const MAX_CONTENT_DEPTH = 16;
// get 결과의 meta·content 칸과 결과 표식에 남기는 여유다. HTTP 봉투는 포함하지 않는다.
export const RESULT_FIELD_ALLOWANCE_BYTES = 64;

export interface Limits {
  readonly depthMax: number;
  readonly contentMax: number;
  readonly metaMax: number;
  readonly responseMax: number;
}

export type Content = { [key: string]: StorableJson };
export type JsonSize = { ok: true; bytes: number } | { ok: false };
export type ContentResult = { ok: true; content: Content; bytes: number } | { ok: false };

export function makeLimits(input: Limits): Limits {
  if (
    ![input.depthMax, input.contentMax, input.metaMax, input.responseMax].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    input.depthMax > MAX_CONTENT_DEPTH ||
    input.contentMax > input.responseMax - input.metaMax - RESULT_FIELD_ALLOWANCE_BYTES
  ) {
    throw new RangeError('invalid_resource_limits');
  }
  return Object.freeze({
    depthMax: input.depthMax,
    contentMax: input.contentMax,
    metaMax: input.metaMax,
    responseMax: input.responseMax,
  });
}

// 내장 다섯 판의 compact 최대 54,879바이트를 수용한다. 보고 예산은 wire 한도가 아니다.
// 진단 1,000개가 내용 길이의 문자열을 반복해도 들어가는 보수적 예산이며 실제 호출자는 값을 주입한다.
export const RESOURCE_PAYLOAD_LIMITS = makeLimits({
  depthMax: MAX_CONTENT_DEPTH,
  contentMax: 128 * 1024,
  metaMax: 8 * 1024,
  responseMax: 128 * 1024 * 1024,
});

type Frame =
  | { kind: 'value'; value: unknown; depth: number }
  | { kind: 'container'; object: object; keys: string[]; index: number; array: boolean; depth: number };

// JSON 문자열 전체를 만들지 않고 키·이스케이프·구분자를 포함한 바이트를 센다.
function inspectJson(input: unknown, max: number, depthMax?: number): JsonSize {
  if (!Number.isSafeInteger(max) || max < 1) return { ok: false };
  let bytes = 0;
  const ancestors = new Set<object>();
  const strings = new Map<string, number>();
  const stack: Frame[] = [{ kind: 'value', value: input, depth: 1 }];
  const add = (amount: number): boolean => {
    if (amount > max - bytes) return false;
    bytes += amount;
    return true;
  };
  const string = (value: string): boolean => {
    const cached = strings.get(value);
    if (cached !== undefined) return add(cached);
    const start = bytes;
    if (!add(2)) return false;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      let size: number;
      if (code === 0x22 || code === 0x5c || [8, 9, 10, 12, 13].includes(code)) size = 2;
      else if (code < 0x20) size = 6;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          size = 4;
          index++;
        } else size = 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) size = 6;
      else size = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (!add(size)) return false;
    }
    strings.set(value, bytes - start);
    return true;
  };

  try {
    while (stack.length) {
      const frame = stack.at(-1)!;
      if (frame.kind === 'container') {
        if (frame.index === frame.keys.length) {
          ancestors.delete(frame.object);
          stack.pop();
          continue;
        }
        const key = frame.keys[frame.index]!;
        const descriptor = Object.getOwnPropertyDescriptor(frame.object, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return { ok: false };
        if (frame.index > 0 && !add(1)) return { ok: false };
        if (!frame.array && (!string(key) || !add(1))) return { ok: false };
        frame.index++;
        stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 });
        continue;
      }
      stack.pop();
      const { value, depth } = frame;
      if (value === null) {
        if (!add(4)) return { ok: false };
      } else if (typeof value === 'boolean') {
        if (!add(value ? 4 : 5)) return { ok: false };
      } else if (typeof value === 'string') {
        if (!string(value)) return { ok: false };
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value) || !add(JSON.stringify(value).length)) return { ok: false };
      } else if (typeof value === 'object') {
        // Proxy의 trap과 getter를 실행하지 않는다. 반복 순회와 재귀 검사 사이 값이 바뀌는 것도 막는다.
        if (isProxy(value) || ancestors.has(value) || (depthMax !== undefined && depth > depthMax)) {
          return { ok: false };
        }
        const array = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
          return { ok: false };
        }
        if (!add(2)) return { ok: false };
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.some((key) => typeof key !== 'string')) return { ok: false };
        let keys = ownKeys as string[];
        if (array) {
          const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as number;
          if (keys.length !== length + 1 || keys.at(-1) !== 'length') return { ok: false };
          keys = keys.slice(0, -1);
          if (keys.some((key, index) => key !== String(index))) return { ok: false };
          if (length > 0 && length * 2 - 1 > max - bytes) return { ok: false };
        } else if (keys.length > 0 && keys.length * 5 - 1 > max - bytes) return { ok: false };
        ancestors.add(value);
        stack.push({ kind: 'container', object: value, keys, index: 0, array, depth });
      } else return { ok: false };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false };
  }
}

export function checkContent(input: unknown, inputLimits: Limits): ContentResult {
  try {
    const limits = makeLimits(inputLimits);
    if (input === null || typeof input !== 'object' || isProxy(input) || Array.isArray(input)) {
      return { ok: false };
    }
    const measured = inspectJson(input, limits.contentMax, limits.depthMax);
    if (!measured.ok) return measured;
    assertStorableJson(input, 'resource-content');
    // 두 재귀 함수에는 깊이·크기를 제한하고 descriptor를 확인한 값만 넘긴다.
    hashState(input);
    return { ok: true, content: input as Content, bytes: measured.bytes };
  } catch {
    return { ok: false };
  }
}

export function measureJson(input: unknown, max: number): JsonSize {
  return inspectJson(input, max);
}
