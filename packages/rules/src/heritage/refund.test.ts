import { expect, it } from 'vitest';
import { creationRefunds, type HeritageCreationSpend } from './refund';

const spend = (sequence: number, userId = 'account-a', delta = -3): HeritageCreationSpend => ({
  userId,
  sequence,
  delta,
  key: `spend:old-world:${sequence}`,
});
const input = (spends: HeritageCreationSpend[]) => ({
  worldId: 'old-world',
  reason: 'ADMIN_END' as const,
  spends,
  existingKeys: new Set<string>(),
  withdrawnUserIds: new Set<string>(),
});
it.each(['ADMIN_END', 'ADMIN_RESET'] as const)('AC-P2-33 %s는 원본 월드의 각 사용 금액 전액만 반환한다', (reason) => {
  const source = { ...input([spend(10, 'account-z', -6), spend(3), spend(1)]), reason },
    before = structuredClone(source);
  const result = creationRefunds(source);
  expect(result.map(({ userId, key, delta, kind }) => ({ userId, key, delta, kind }))).toEqual([
    { userId: 'account-a', key: 'refund:old-world:1', delta: 3, kind: 'CREATION_REFUND' },
    { userId: 'account-a', key: 'refund:old-world:3', delta: 3, kind: 'CREATION_REFUND' },
    { userId: 'account-z', key: 'refund:old-world:10', delta: 6, kind: 'CREATION_REFUND' },
  ]);
  expect(source).toEqual(before);
  expect(creationRefunds(source)).toEqual(result);
});
it('AC-P2-33 같은 사용의 반환 키가 있으면 재시도해도 새 항목이 없다', () => {
  const source = input([spend(1)]),
    entries = creationRefunds(source);
  expect(creationRefunds({ ...source, existingKeys: new Set(entries.map((row) => row.key)) })).toEqual([]);
});
it('AC-P2-33 탈퇴 뒤 반환은 같은 크기의 몰수와 짝지어 잔액을 되살리지 않는다', () => {
  const source = input([spend(1)]);
  source.withdrawnUserIds.add('account-a');
  const entries = creationRefunds(source);
  expect(entries).toMatchObject([
    { key: 'refund:old-world:1', kind: 'CREATION_REFUND', delta: 3 },
    { key: 'forfeit:refund:old-world:1', kind: 'FORFEIT', delta: -3 },
  ]);
  expect(entries.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
  expect(creationRefunds({ ...source, existingKeys: new Set(entries.map((row) => row.key)) })).toEqual([]);
});
it.each([
  { ...spend(1), delta: 0 },
  { ...spend(1), delta: -7 },
  { ...spend(1), delta: -1.5 },
  { ...spend(1), key: 'spend:new-world:1' },
  spend(0),
])('AC-P2-33 잘못된 사용 원장으로 반환하지 않는다: %j', (row) => {
  expect(() => creationRefunds(input([row]))).toThrow('사용 원장');
});
it('AC-P2-33 중복 사용이나 반환 없이 홀로 있는 몰수 기록은 손상으로 중단한다', () => {
  expect(() => creationRefunds(input([spend(1), spend(1)]))).toThrow('사용 원장');
  expect(() =>
    creationRefunds({ ...input([spend(1)]), existingKeys: new Set(['forfeit:refund:old-world:1']) }),
  ).toThrow('짝을 이루지');
});
