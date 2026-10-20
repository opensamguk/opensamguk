import { describe, expect, it } from 'vitest';
import { hashState } from './hashState';

describe('상태 해시', () => {
  it('키를 정렬한 JSON의 SHA-256을 사용한다', () => {
    expect(hashState({ b: 2, a: 1 })).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
    expect(hashState({ z: { b: 2, a: 1 }, a: [2, 1] })).toBe(hashState({ a: [2, 1], z: { a: 1, b: 2 } }));
  });
  it('배열 순서는 보존하고 모호하게 직렬화되는 값은 거부한다', () => {
    expect(hashState([1, 2])).not.toBe(hashState([2, 1]));
    for (const value of [undefined, NaN, Infinity, { a: undefined }, [undefined], new Map()]) {
      expect(() => hashState(value)).toThrow();
    }
  });
});
