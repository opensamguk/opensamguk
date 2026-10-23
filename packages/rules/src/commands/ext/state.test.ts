import { expect, it, vi } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandInitial, commandWorld } from '../../../test/commandFixture';
import { cloneWorld, cloneWorldWithRegistry } from '../../model/clone';
import { toWorldState, toWorldStateWithRegistry, type JsonValue } from '../../model/world';
import { createExtState, createExtStateWithRegistry, type ExtStateRegistry, type ExtSlice } from './state';

function fixture() {
  const slices: ExtSlice[] = ['s_shared', 's_a', 's_n'].map((key) => ({
    key,
    create: vi.fn(() => ({ nested: [1] })),
    clone: (value) => structuredClone(value) as JsonValue,
    validate: (value): value is JsonValue => value !== null && typeof value === 'object' && 'nested' in value,
  }));
  const bindings: ExtStateRegistry['bindings'] = [
    { commandKey: 't_a', target: 'general', sliceKeys: ['s_shared', 's_a'] },
    { commandKey: 't_b', target: 'general', sliceKeys: ['s_shared'] },
    { commandKey: 't_free', target: 'general', sliceKeys: [] },
    { commandKey: 't_n', target: 'nation', sliceKeys: ['s_n'] },
  ];
  return { slices, bindings };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const enabled = { general: ['t_a', 't_b'], nation: ['t_n'] };

it('운영 등록은 비어 있고 끈 월드·빈 목록·상태 없는 명령은 조각을 만들지 않는다', () => {
  const registry = fixture();
  for (const input of [null, { general: [], nation: [] }, { general: ['t_free'], nation: [] }]) {
    expect(createExtStateWithRegistry(input, commandWorld(), registry)).toBeUndefined();
  }
  for (const slice of registry.slices) expect(slice.create).not.toHaveBeenCalled();
  expect(createExtState(null, commandWorld())).toBeUndefined();
  expect(() => createExtState({ general: ['farm'], nation: [] }, commandWorld())).toThrow('farm');
});

it('켠 명령의 합집합만 등록 순서로 한 번 만들고 enabled 순서에 영향받지 않는다', () => {
  const registry = fixture();
  const one = createExtStateWithRegistry({ general: ['t_b'], nation: [] }, commandWorld(), registry)!;
  expect(Object.keys(one)).toEqual(['s_shared']);
  expect(registry.slices[1]!.create).not.toHaveBeenCalled();
  expect(registry.slices[2]!.create).not.toHaveBeenCalled();
  const all = fixture();
  const first = createExtStateWithRegistry(enabled, commandWorld(), all)!;
  expect(Object.keys(first)).toEqual(['s_shared', 's_a', 's_n']);
  for (const slice of all.slices) expect(slice.create).toHaveBeenCalledTimes(1);
  expect(createExtStateWithRegistry({ ...enabled, general: ['t_b', 't_a'] }, commandWorld(), fixture())).toEqual(first);
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
});

it('깊게 얼린 입력은 그대로이고 초기화와 복제는 서로 가변 참조를 나누지 않는다', () => {
  const context = freeze(commandWorld());
  const before = structuredClone(context);
  const rng = rngFor('ext-purity');
  const registry = fixture();
  const shared = { nested: [1] };
  for (const slice of registry.slices) slice.create = () => shared;
  const first = createExtStateWithRegistry(enabled, context, registry)!;
  const second = createExtStateWithRegistry(enabled, context, registry)!;
  const input = { ...commandInitial(), ext: first };
  const world = toWorldStateWithRegistry(input, registry);
  const clone = cloneWorldWithRegistry(freeze(world), registry);
  (clone.ext!.s_shared as { nested: number[] }).nested.push(2);
  (first.s_a as { nested: number[] }).nested.push(3);
  expect(shared).toEqual({ nested: [1] });
  expect(first.s_shared).toEqual({ nested: [1] });
  expect(world.ext!.s_a).toEqual({ nested: [1] });
  expect(second.s_a).toEqual({ nested: [1] });
  expect(context).toEqual(before);
  expect(rng.next()).toBe(rngFor('ext-purity').next());
});

it('없는·중복·대상이 다른 enabled key를 거부한다', () => {
  for (const general of [['farm'], ['missing'], ['t_a', 't_a'], ['t_n']]) {
    expect(() => createExtStateWithRegistry({ general, nation: [] }, commandWorld(), fixture())).toThrow(general[0]);
  }
});

it('중복 조각·중복 행·행 안 중복·없는 참조는 null에서도 거부한다', () => {
  const { slices, bindings } = fixture();
  for (const registry of [
    { slices: [...slices, slices[0]!], bindings },
    { slices, bindings: [...bindings, bindings[0]!] },
    { slices, bindings: [{ ...bindings[0]!, sliceKeys: ['s_a', 's_a'] }] },
    { slices, bindings: [{ ...bindings[0]!, sliceKeys: ['missing'] }] },
  ])
    expect(() => createExtStateWithRegistry(null, commandWorld(), registry)).toThrow();
});

it('빈 ext와 미등록 조각은 초기화·복제에서 거부하고 끈 월드는 키가 없다', () => {
  for (const ext of [{}, { missing: 1 }]) {
    expect(() => cloneWorld({ ...commandWorld(), ext })).toThrow();
    expect(() => toWorldState({ ...commandInitial(), ext })).toThrow();
  }
  expect(Object.hasOwn(commandInitial(), 'ext')).toBe(false);
  expect(Object.hasOwn(toWorldState(commandInitial()), 'ext')).toBe(false);
  expect(Object.hasOwn(cloneWorld(commandWorld()), 'ext')).toBe(false);
});

const cyclic: unknown[] = [];
cyclic.push(cyclic);
const sparse = Array(2);
const invalid: unknown[] = [
  undefined,
  { bad: undefined },
  NaN,
  Infinity,
  Object.create(Date.prototype),
  new Map(),
  new Set(),
  () => 1,
  1n,
  Object.create({ inherited: true }),
  { [Symbol('key')]: 1 },
  cyclic,
  sparse,
  JSON.parse('{"__proto__":1}'),
  { constructor: 1 },
  { prototype: 1 },
  Object.defineProperty({}, 'value', { get: () => 1, enumerable: true }),
  Object.assign([1], { extra: 2 }),
];
for (const [index, value] of invalid.entries())
  it(`JSON이 아닌 조각 ${index}는 생성·복제 입력·복제 결과에서 거부한다`, () => {
    const registry = fixture();
    registry.slices = [
      {
        ...registry.slices[0]!,
        validate: (value): value is JsonValue => Boolean([value]),
        create: () => value as JsonValue,
      },
    ];
    registry.bindings = [{ commandKey: 't_b', target: 'general', sliceKeys: ['s_shared'] }];
    expect(() => createExtStateWithRegistry({ general: ['t_b'], nation: [] }, commandWorld(), registry)).toThrow(
      's_shared',
    );
    expect(() =>
      cloneWorldWithRegistry({ ...commandWorld(), ext: { s_shared: value as JsonValue } }, registry),
    ).toThrow('s_shared');
    registry.slices = [{ ...registry.slices[0]!, clone: () => value as JsonValue }];
    expect(() => cloneWorldWithRegistry({ ...commandWorld(), ext: { s_shared: { nested: [1] } } }, registry)).toThrow(
      's_shared',
    );
  });

it('조각 validate가 거부하는 생성값·복제 입력·복제 결과도 거부한다', () => {
  const registry = fixture();
  registry.slices[0] = { ...registry.slices[0]!, create: () => 5 };
  expect(() => createExtStateWithRegistry(enabled, commandWorld(), registry)).toThrow('s_shared');
  expect(() => cloneWorldWithRegistry({ ...commandWorld(), ext: { s_shared: 5 } }, registry)).toThrow('s_shared');
  registry.slices[0] = { ...registry.slices[0]!, clone: () => 5 };
  expect(() => cloneWorldWithRegistry({ ...commandWorld(), ext: { s_shared: { nested: [] } } }, registry)).toThrow(
    's_shared',
  );
});

it('JSON 스칼라·빈 배열·빈 객체·null 원형 객체는 생성과 복제에서 허용한다', () => {
  for (const value of [null, false, 0, 'text', [], {}, Object.assign(Object.create(null), { value: [1] })]) {
    const registry: ExtStateRegistry = {
      slices: [
        {
          key: 'json',
          create: () => value,
          clone: (input) => structuredClone(input) as JsonValue,
          validate: (input): input is JsonValue => Boolean([input]),
        },
      ],
      bindings: [{ commandKey: 't_json', target: 'general', sliceKeys: ['json'] }],
    };
    const ext = createExtStateWithRegistry({ general: ['t_json'], nation: [] }, commandWorld(), registry)!;
    expect(ext.json).toEqual(value);
    expect(cloneWorldWithRegistry({ ...commandWorld(), ext }, registry).ext).toEqual(ext);
  }
});
