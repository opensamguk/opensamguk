export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
}

// FNV-1a over UTF-16 code units, then Mulberry32. Changing either breaks replay.
export function createRng(seed: string): Rng {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  const int = (min: number, max: number) => {
    const span = max - min + 1;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || span < 1 || span > 0x1_0000_0000) {
      throw new Error('RNG 정수 범위가 올바르지 않습니다.');
    }
    return min + Math.floor(next() * span);
  };
  return {
    next,
    int,
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) throw new Error('빈 목록에서는 고를 수 없습니다.');
      return values[int(0, values.length - 1)]!;
    },
  };
}

export function rngFor(seed: string, ...scope: readonly (string | number)[]): Rng {
  return createRng(JSON.stringify([seed, ...scope]));
}
