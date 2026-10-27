import { expect, it } from 'vitest';
import { storedGeneralStats } from './generalStats';

it('INT-14 / AC-INT-14 기존 DB의 null은 키 없이 읽고 새 판의 null·범위 오류는 거부한다', () => {
  const old = { id: 1, leadership: 55, strength: 55, intel: 55 };
  expect(storedGeneralStats({ ...old, politics: null, charm: null }, false)).toEqual(old);
  expect(storedGeneralStats({ ...old, politics: 0, charm: 100 }, true)).toEqual({ ...old, politics: 0, charm: 100 });
  for (const row of [
    { ...old, politics: null, charm: null },
    { ...old, politics: 0, charm: null },
    { ...old, politics: 101, charm: 100 },
  ])
    expect(() => storedGeneralStats(row, true)).toThrow();
  expect(() => storedGeneralStats({ ...old, politics: 0, charm: 100 }, false)).toThrow();
});
