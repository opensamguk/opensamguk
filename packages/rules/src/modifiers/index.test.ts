import { describe, expect, it } from 'vitest';
import * as publicRules from '../index';
import { commandWorld } from '../../test/commandFixture';
import type { DeepReadonly } from '../model/world';
import {
  applyModifiers,
  collectModifiers,
  collectModifiersWith,
  type Modifier,
  type ModifierContext,
  type ModifierProvider,
} from './index';
import { modifierProviders } from './providers';

function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
const add = (source: string, value: number): Modifier => ({ source, op: 'add', value });
const mul = (source: string, value: number): Modifier => ({ source, op: 'mul', value });

describe('T4-18 수정자 합산', () => {
  it.each([0, 5.5, -0, -5, NaN, Infinity, -Infinity])('A1: 빈 수정자는 %s와 부호를 검사 없이 보존한다', (base) => {
    expect(Object.is(applyModifiers(base, [], { min: 0 }), base)).toBe(true);
    expect(Object.is(applyModifiers(base, [], { min: NaN }), base)).toBe(true);
  });

  it('A2: source 순서대로 왼쪽부터 더해 부동소수 결합 순서를 고정한다', () => {
    const values = [add('test:a', 0.1), add('test:b', 0.2)];
    expect(applyModifiers(0.3, values)).toBe(0.6000000000000001);
    expect(applyModifiers(0.3, values.toReversed())).toBe(0.6000000000000001);
  });

  it('A3: source 순서대로 왼쪽부터 곱한다', () => {
    const values = [mul('test:a', 1.1), mul('test:b', 0.3)];
    expect(applyModifiers(10, values)).toBe(3.3);
    expect(applyModifiers(10, values.toReversed())).toBe(3.3);
  });

  it('A4: 같은 source의 두 연산을 허용하고 모든 덧셈 뒤에 곱셈한다', () => {
    const values = [mul('test:b', 0.9), add('test:a', 5), mul('test:a', 1.1), add('test:b', -2.5)];
    expect(applyModifiers(100, values)).toBe(101.47500000000001);
    expect(applyModifiers(100, values.toReversed())).toBe(101.47500000000001);
  });

  it('UTF-16 코드 단위로 정렬하고 locale 정렬에 기대지 않는다', () => {
    const values = [add('aa:x', 1), add('a_:x', -1e16), add('a0:x', 1e16)];
    expect(applyModifiers(0, values)).toBe(1);
  });

  it('A5: 수정자가 있을 때만 하한을 적용하고 반올림이나 상한은 걸지 않는다', () => {
    expect(applyModifiers(28, [add('test:a', -100)], { min: 0 })).toBe(0);
    expect(applyModifiers(28, [add('test:a', -100)])).toBe(-72);
    expect(applyModifiers(0.25, [mul('test:a', 1.5)])).toBe(0.375);
    expect(applyModifiers(12000, [add('test:a', 100)])).toBe(12100);
    expect(applyModifiers(-10, [mul('test:a', 1)], { min: -5 })).toBe(-5);
  });

  it('A6: 얼린 배열과 수정자를 바꾸지 않는다', () => {
    const values = freeze([mul('test:z', 2), add('test:a', 1)]);
    const before = structuredClone(values);
    expect(applyModifiers(3, values)).toBe(8);
    expect(values).toEqual(before);
  });

  it('0 배수와 48자 ID는 유효하다', () => {
    expect(applyModifiers(20, [mul('test:a', 0)])).toBe(0);
    expect(applyModifiers(20, [add(`item:${'a'.repeat(48)}`, 0.5)])).toBe(20.5);
  });

  const invalid: Array<[string, number, unknown, unknown?]> = [
    ...[NaN, Infinity, -Infinity, '2'].map((value): [string, number, unknown] => [
      `비정상 value ${value}`,
      1,
      [{ source: 'test:a', op: 'add', value }],
    ]),
    ['음수 배수', 1, [mul('test:a', -0.5)]],
    ['중복 덧셈', 1, [add('test:a', 1), add('test:a', 2)]],
    ['중복 곱셈', 1, [mul('test:a', 1), mul('test:a', 2)]],
    ...['', 'item', 'Item:1', 'item:', 'item:a b', `item:${'a'.repeat(49)}`, 'item:a\n'].map(
      (source): [string, number, unknown] => [`비정상 source ${source}`, 1, [add(source, 1)]],
    ),
    ['문자열 아닌 source', 1, [{ source: ['test:a'], op: 'add', value: 1 }]],
    ['없는 연산', 1, [{ source: 'test:a', op: 'set', value: 1 }]],
    ['결과 overflow', 1e308, [mul('test:a', 10)]],
    ...[NaN, Infinity, -Infinity].map((base): [string, number, unknown] => [
      `비정상 base ${base}`,
      base,
      [add('test:a', 1)],
    ]),
    ...[NaN, Infinity, -Infinity, '0'].map((min): [string, number, unknown, unknown] => [
      `비정상 min ${min}`,
      1,
      [add('test:a', 1)],
      { min },
    ]),
  ];
  it.each(invalid)('X: %s를 거부한다', (_, base, modifiers, options) => {
    expect(() => applyModifiers(base, modifiers as Modifier[], options as { min?: number })).toThrow(Error);
  });
});

describe('T4-18 제공자 수집', () => {
  it('운영 목록은 비어 있고 모든 단계에서 새 빈 배열을 낸다', () => {
    const view = freeze(commandWorld());
    expect(modifierProviders).toEqual([]);
    for (const stage of ['domestic.score', 'battle.dealt', 'battle.taken'] as const) {
      const context = { stage, commandKey: stage === 'domestic.score' ? 'farm' : 'attack' };
      const result = collectModifiers(view, 1, context);
      expect(result).toEqual([]);
      expect(collectModifiers(view, 1, context)).not.toBe(result);
    }
  });

  it('제공자 목록 순서와 입력을 보존하며 결정적인 새 배열을 만든다', () => {
    const view = freeze(commandWorld());
    const before = structuredClone(view);
    const context = freeze<ModifierContext>({ stage: 'domestic.score', commandKey: 'farm' });
    const first = freeze([mul('test:z', 1.5)]);
    const second = freeze([add('test:a', 2)]);
    const calls: string[] = [];
    const providers = Object.freeze<ModifierProvider[]>([
      (receivedView, id, receivedContext) => {
        expect(receivedView).toBe(view);
        expect(id).toBe(1);
        expect(receivedContext).toBe(context);
        calls.push('first');
        return first;
      },
      () => {
        calls.push('second');
        return second;
      },
    ]);
    const result = collectModifiersWith(providers, view, 1, context);
    expect(result).toEqual([...first, ...second]);
    expect(result).not.toBe(first);
    expect(result).not.toBe(second);
    expect(collectModifiersWith(providers, view, 1, context)).toEqual(result);
    expect(calls).toEqual(['first', 'second', 'first', 'second']);
    result.pop();
    expect(second).toHaveLength(1);
    expect(view).toEqual(before);
  });

  it('없는 상태에서 빈 배열을 내는 제공자를 수집해도 빈 배열이다', () => {
    const view = freeze(commandWorld());
    const provider: ModifierProvider = (state) => (state.ext ? [add('test:a', 1)] : []);
    expect(collectModifiersWith([provider], view, 1, { stage: 'battle.dealt', commandKey: 'attack' })).toEqual([]);
  });

  it('공개 rules export에 시험 helper와 운영 등록부가 없다', () => {
    for (const key of [
      'collectModifiersWith',
      'collectModifiers',
      'modifierProviders',
      'makeInvestmentWithProviders',
      'createAttackWithProviders',
    ]) {
      expect(publicRules).not.toHaveProperty(key);
    }
  });
});
