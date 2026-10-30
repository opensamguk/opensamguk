import { expect, it } from 'vitest';
import { allocationLimit, allocationStorageKey, readAllocation, forgetAllocation } from './cityResourceRequest';
it('INT-18C AC-INT-18C pending은 계정/월드별 같은 UUID와 정수 payload만 복구한다', () => {
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const payload = { cityKey: 2, unitId: 3, crewType: 1100, amount: 50 };
  const read = (value: unknown) => readAllocation({ getItem: () => JSON.stringify(value) }, 'key');
  expect(read({ requestId, payload })).toEqual({ requestId, payload });
  for (const invalid of [
    { requestId: 'not-uuid', payload },
    { requestId, payload: { ...payload, amount: -1 } },
    { requestId, payload: { ...payload, amount: 1.5 } },
    { requestId, payload: { ...payload, expectedUserId: 'other' } },
  ])
    expect(read(invalid)).toBeNull();
  expect(allocationStorageKey('A', 'one')).not.toBe(allocationStorageKey('B', 'one'));
  expect(allocationStorageKey('A', 'one')).not.toBe(allocationStorageKey('A', 'two'));
});
it('INT-18C AC-INT-18C 오래된 미접수 정리는 다른 UUID나 payload의 기록을 지우지 않는다', () => {
  const request = {
    requestId: '12345678-1234-4234-8234-123456789abc',
    payload: { cityKey: 2, unitId: 3, crewType: 1100, amount: 50 },
  };
  let raw = JSON.stringify({ ...request, requestId: '22345678-1234-4234-8234-123456789abc' });
  let removed = 0;
  const storage = {
    getItem: () => raw,
    removeItem: () => {
      removed++;
      raw = 'null';
    },
  };
  expect(forgetAllocation(storage, 'key', request)).toBe(false);
  raw = JSON.stringify({ ...request, payload: { ...request.payload, amount: 51 } });
  expect(forgetAllocation(storage, 'key', request)).toBe(false);
  expect(removed).toBe(0);
  raw = JSON.stringify(request);
  expect(forgetAllocation(storage, 'key', request)).toBe(true);
  expect(removed).toBe(1);
});
it('INT-18C AC-INT-18C 배속 상한은 도시 병종 잔량과 실제 지휘관 전체 병력에서 계산한다', () => {
  const board = {
    targets: [{ id: 7, crewType: 1100, capacity: 1000, commanded: 950 }],
    resources: { garrison: [{ crewType: 1100, troops: 90 }] },
  };
  expect(allocationLimit(board, 7, 1100)).toBe(50);
  expect(allocationLimit(board, 7, 1200)).toBe(0);
  expect(allocationLimit(board, 8, 1100)).toBe(0);
  board.targets[0]!.commanded = 1100;
  expect(allocationLimit(board, 7, 1100)).toBe(0);
});
