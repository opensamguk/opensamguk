export type ArrayEdit<T> =
  | { put: { from: number; to: number; value: T } }
  | { shift: number }
  | { repeat: { from: number; to: number; times: number } };

// 길이와 원본을 보존한다. 빈 값의 의미는 호출자가 정한다.
export function editArray<T>(source: readonly T[], op: ArrayEdit<T>, empty: () => T): T[] {
  const size = source.length;
  const index = (n: number) => Number.isSafeInteger(n) && n >= 0 && n < size;
  if ('shift' in op) {
    if (!Number.isSafeInteger(op.shift) || op.shift === 0 || Math.abs(op.shift) >= size)
      throw new Error('Invalid shift');
    return Array.from({ length: size }, (_, i) => {
      const old = i - op.shift;
      return old >= 0 && old < size ? structuredClone(source[old]!) : empty();
    });
  }
  const { from, to } = 'put' in op ? op.put : op.repeat;
  if (!index(from) || !index(to) || from > to) throw new Error('Invalid range');
  const result = structuredClone([...source]);
  if ('put' in op) {
    for (let i = from; i <= to; i++) result[i] = structuredClone(op.put.value);
  } else {
    const { times } = op.repeat;
    if (to === size - 1 || !Number.isSafeInteger(times) || times < 1 || times >= size)
      throw new Error('Invalid repeat');
    const length = to - from + 1;
    for (let i = to + 1; i < Math.min(size, to + 1 + length * times); i++)
      result[i] = structuredClone(source[from + ((i - to - 1) % length)]!);
  }
  return result;
}
