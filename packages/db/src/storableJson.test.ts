import { expect, it, vi } from 'vitest';
import { assertStorableJson } from './storableJson';

it('JSONB에서 보존되는 스칼라와 중첩 값을 허용하고 입력을 바꾸지 않는다', () => {
  const shared = Object.freeze({ text: '한글\ud83d\ude00\ufffd', values: Object.freeze([null, false, true, 0, -1.5]) });
  for (const value of [null, true, false, 0, 1e100, '', [], {}, { a: shared, b: shared }, Object.create(null)]) {
    const before = structuredClone(value);
    assertStorableJson(value, 'test');
    expect(value).toEqual(before);
  }
});

const cycle: unknown[] = [];
cycle.push(cycle);
const invalid: unknown[] = [
  undefined,
  { a: undefined },
  NaN,
  Infinity,
  -Infinity,
  -0,
  { nested: [-0] },
  1n,
  () => 1,
  Symbol('value'),
  new Date(0),
  new Map(),
  new Set(),
  cycle,
  Array(1),
  Object.assign([1], { extra: 2 }),
  Object.create({ inherited: true }),
  { [Symbol('key')]: 1 },
  JSON.parse('{"__proto__":1}'),
  { constructor: 1 },
  { prototype: 1 },
  Object.defineProperty({}, 'hidden', { value: 1 }),
];
for (const text of ['\u0000', 'a\u0000b', '\ud800', '\udfff', '\ud800x', '\ud800\ud800', '\udc00\ud800']) {
  invalid.push(text, { nested: [text] }, { [text]: 1 });
}
it.each(invalid.map((value, index) => [index, value] as const))('저장할 수 없는 값 %s를 거부한다', (_index, value) => {
  expect(() => assertStorableJson(value, 'test')).toThrow('저장할 JSON 값을 확인하세요: test');
});

it('getter를 실행하지 않고 속성 기술자를 거부한다', () => {
  const get = vi.fn(() => 'private-value');
  for (const value of [
    Object.defineProperty({}, 'value', { get, enumerable: true }),
    Object.defineProperty([], '0', { get, enumerable: true }),
  ])
    expect(() => assertStorableJson(value, 'test')).toThrow('test');
  expect(get).not.toHaveBeenCalled();
});
