import { expect, it } from 'vitest';
import { storedGeneralRemoval, removedGeneralResult } from './removal';
import { validatePersonnelRecord } from '../personnel/inputs';
import { decodeTreatyRecord, validateTreatyRecord } from '../diplomacy/treaty';

it('AC-INT-23 내보내지 않은 장수는 기존 모양을 유지하고 형식3의 퇴장 tick만 읽는다', () => {
  for (const format of [1, 2, 3, 5]) {
    expect(storedGeneralRemoval({ id: 1, removedAt: null }, format)).toEqual({ id: 1 });
    expect(storedGeneralRemoval({ id: 1 }, format)).toEqual({ id: 1 });
  }
  expect(storedGeneralRemoval({ id: 1, removedAt: 0 }, 3)).toEqual({ id: 1, removedAt: 0 });
  for (const format of [1, 2, 5]) expect(() => storedGeneralRemoval({ removedAt: 1 }, format)).toThrow();
  for (const removedAt of [-1, 0.5, '1', 2_147_483_648]) expect(() => storedGeneralRemoval({ removedAt }, 3)).toThrow();
});

it('AC-INT-23 퇴장 거절도 인사·조약 6종의 엄격한 코드·처리 tick 계약을 지킨다', () => {
  for (const [kind, payload] of [
    ['personnel.appoint', { generalId: 2, officerLevel: 11 }],
    ['personnel.dismiss', { generalId: 2 }],
    ['offer.respond', { offerId: 'old-offer', accept: false }],
  ] as const) {
    const record = {
      sequence: 1,
      generalId: 1,
      kind,
      status: 'REJECTED',
      payload,
      result: removedGeneralResult(kind, 10),
    };
    expect(validatePersonnelRecord(record, { monthlyTick: 0 }).result).toMatchObject({
      code: 'GENERAL_REMOVED',
      tick: 10,
    });
    expect(() =>
      validatePersonnelRecord({ ...record, result: { code: 'GENERAL_REMOVED', message: '퇴장' } }, { monthlyTick: 0 }),
    ).toThrow();
  }
  for (const [kind, payload] of [
    ['treaty.propose', { toNationId: 2, clauses: [{ kind: 'note', text: '회귀 검증' }] }],
    ['treaty.respond', { treatyId: '1', accept: false }],
    ['treaty.break', { treatyId: '1' }],
  ] as const) {
    const record = {
      sequence: 2,
      generalId: 1,
      kind,
      status: 'REJECTED',
      payload,
      result: removedGeneralResult(kind, 10),
    };
    expect(decodeTreatyRecord(record).result).toMatchObject({ code: 'GENERAL_REMOVED', tick: 10 });
    expect(
      validateTreatyRecord(record, { treaty: { version: 1 }, treatyBreak: { version: 1 }, monthlyTick: 0 }).result,
    ).toMatchObject({ code: 'GENERAL_REMOVED', tick: 10 });
    expect(() => decodeTreatyRecord({ ...record, result: { code: 'GENERAL_REMOVED', message: '퇴장' } })).toThrow();
  }
  expect(removedGeneralResult('general.setPolicy', 10)).toEqual({
    code: 'GENERAL_REMOVED',
    message: '내보낸 장수의 요청은 처리할 수 없습니다.',
  });
});
