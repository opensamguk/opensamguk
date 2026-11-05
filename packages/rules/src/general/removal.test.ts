import { expect, it } from 'vitest';
import { storedGeneralRemoval } from './removal';

it('AC-INT-23 내보내지 않은 장수는 기존 모양을 유지하고 형식3의 퇴장 tick만 읽는다', () => {
  for (const format of [1, 2, 3, 5]) {
    expect(storedGeneralRemoval({ id: 1, removedAt: null }, format)).toEqual({ id: 1 });
    expect(storedGeneralRemoval({ id: 1 }, format)).toEqual({ id: 1 });
  }
  expect(storedGeneralRemoval({ id: 1, removedAt: 0 }, 3)).toEqual({ id: 1, removedAt: 0 });
  for (const format of [1, 2, 5]) expect(() => storedGeneralRemoval({ removedAt: 1 }, format)).toThrow();
  for (const removedAt of [-1, 0.5, '1', 2_147_483_648]) expect(() => storedGeneralRemoval({ removedAt }, 3)).toThrow();
});
