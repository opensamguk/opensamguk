export type StorableJson = null | boolean | number | string | StorableJson[] | { [key: string]: StorableJson };

const reserved = new Set(['__proto__', 'constructor', 'prototype']);

export function assertStorableJson(value: unknown, label: string): asserts value is StorableJson {
  const ancestors = new Set<object>();
  const fail = (): never => {
    throw new Error(`저장할 JSON 값을 확인하세요: ${label}`);
  };
  function checkString(value: string) {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) fail();
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
      }
    }
  }
  function visit(input: unknown): void {
    if (input === null || typeof input === 'boolean') return;
    if (typeof input === 'string') return checkString(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0)) fail();
      return;
    }
    if (typeof input !== 'object' || input === null || ancestors.has(input)) fail();
    const object = input as object;
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    const keys = Reflect.ownKeys(object);
    if (array && keys.length !== object.length + 1) fail();
    ancestors.add(object);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail();
      const field = key as string;
      checkString(field);
      if (reserved.has(field)) fail();
      if (array && (!/^(0|[1-9]\d*)$/.test(field) || Number(field) >= object.length)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      visit(descriptor.value);
    }
    ancestors.delete(object);
  }
  visit(value);
}
