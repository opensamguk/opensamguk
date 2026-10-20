import { describe, expect, it } from 'vitest';
import { createRng, rngFor } from './rng';

describe('고정된 시드 RNG', () => {
  it('FNV-1a + Mulberry32 test 시드의 첫 5개 값을 고정한다', () => {
    const rng = createRng('test');
    expect(Array.from({ length: 5 }, () => rng.next())).toEqual([
      0.7171058997046202, 0.3465085106436163, 0.26757614384405315,
      0.2510541402734816, 0.8766860503237695,
    ]);
  });
  it('범위 안 정수와 목록 원소만 고르고 잘못된 범위는 거부한다', () => {
    const rng = createRng('bounds');
    for (let i = 0; i < 1000; i++) {
      const n = rng.next();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
      expect([-2, -1, 0, 1, 2]).toContain(rng.int(-2, 2));
      expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
    }
    expect(rng.int(7, 7)).toBe(7);
    expect(() => rng.int(2, 1)).toThrow();
    expect(() => rng.int(0.5, 3)).toThrow();
    expect(() => rng.pick([])).toThrow();
  });
  it('용도별 스트림은 독립적이며 범위 경계가 섞이지 않는다', () => {
    const bootstrap = rngFor('world', 'bootstrap');
    const expected = bootstrap.next();
    rngFor('world', 'turn', 1).next();
    expect(rngFor('world', 'bootstrap').next()).toBe(expected);
    expect(rngFor('world', 'a', 'bc').next()).not.toBe(rngFor('world', 'ab', 'c').next());
    expect(rngFor('world', 1).next()).not.toBe(rngFor('world', '1').next());
  });
});
