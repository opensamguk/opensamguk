import { describe, expect, it } from 'vitest';
import { WORKLOAD_WEIGHTS, userWorkload, workloadChoice } from './workload';

describe('L3 고정 요청 배분', () => {
  it('각1000분위구간이정본요청비율과같다', () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 1000; index++) {
      const key = workloadChoice((index + 0.5) / 1000);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(WORKLOAD_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0)).toBe(1000);
    for (const entry of WORKLOAD_WEIGHTS) expect(counts.get(entry.procedure)).toBe(entry.weight);
  });
  it('사용자별독립시드와1~3초생각시간을재생한다', () => {
    const a = userWorkload('same', 0, 0),
      b = userWorkload('same', 0, 0),
      other = userWorkload('same', 1, 0);
    const first = Array.from({ length: 100 }, () => a.next());
    expect(first).toEqual(Array.from({ length: 100 }, () => b.next()));
    expect(first).not.toEqual(Array.from({ length: 100 }, () => other.next()));
    expect(first.every((entry) => entry.thinkMs >= 1000 && entry.thinkMs <= 3000)).toBe(true);
  });
  it.each([-1, 1, Infinity, NaN])('잘못된난수%s는거부한다', (value) => {
    expect(() => workloadChoice(value)).toThrow('LOAD_RANDOM_FRACTION_INVALID');
  });
});
