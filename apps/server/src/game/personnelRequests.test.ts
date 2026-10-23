import { describe, expect, it, vi } from 'vitest';
import { createDb } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { readPersonnelRecent, readPersonnelRequest, toPersonnelRecord } from './personnelRequests';

const requestId = '10000000-0000-4000-8000-000000000001';
type Event = Parameters<typeof toPersonnelRecord>[0];
function row(changes: Partial<Event> = {}): Event {
  return {
    kind: 'personnel.appoint',
    idempotencyKey: `personnel:${requestId}`,
    status: 'APPLIED',
    result: { tick: 200, generalId: 3, officerLevel: 11, title: '참모' },
    ...changes,
  };
}
describe('인사 요청 화면 응답', () => {
  it('준비 값의 월드가 다르면 DB 메서드에 도달하지 않는다', async () => {
    const db = createDb('postgresql://unused@127.0.0.1:1/unused');
    const findUnique = vi.spyOn(db.inputEvent, 'findUnique').mockImplementation(() => {
      throw new Error('조회에 도달함');
    });
    const findMany = vi.spyOn(db.inputEvent, 'findMany').mockImplementation(() => {
      throw new Error('조회에 도달함');
    });
    try {
      const ready = { worldId: 'other', personnel: 'ready' } as const;
      await expect(
        readPersonnelRequest(db, ready, { worldId: 'world', userId: 'user', requestId }),
      ).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
      await expect(readPersonnelRecent(db, ready, { worldId: 'world', userId: 'user', now: 0 })).rejects.toHaveProperty(
        'code',
        'PRECONDITION_FAILED',
      );
      expect(findUnique).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await db.$disconnect();
    }
  });
  it.each(['personnel.appoint', 'personnel.dismiss'])('%s 결과에서 처리 tick을 뺀다', (kind) => {
    const event = row({ kind });
    expect(toPersonnelRecord(event)).toEqual({
      kind,
      state: { status: 'applied', requestId, result: { generalId: 3, officerLevel: 11, title: '참모' } },
    });
    expect(event.result).toHaveProperty('tick', 200);
  });
  it('PENDING은 결과가 없어도 요청 번호를 유지한다', () => {
    expect(toPersonnelRecord(row({ status: 'PENDING', result: null }))).toEqual({
      kind: 'personnel.appoint',
      state: { status: 'pending', requestId },
    });
  });
  it('거절 결과의 코드와 문장만 남긴다', () => {
    expect(
      toPersonnelRecord(
        row({ status: 'REJECTED', result: { tick: 200, code: 'NOT_RULER', message: '군주만 가능합니다.' } }),
      ),
    ).toEqual({
      kind: 'personnel.appoint',
      state: { status: 'rejected', requestId, code: 'NOT_RULER', message: '군주만 가능합니다.' },
    });
  });
  it.each(['ACCEPTED', 'REJECTED'])('발령 %s는 접수 APPLIED와 구분한다', (offerStatus) => {
    expect(
      toPersonnelRecord(
        row({
          kind: 'offer.respond',
          result: { tick: 200, offerStatus, city: { cityKey: 1, name: '낙양' }, dedicationLost: 9 },
        }),
      ),
    ).toMatchObject({ state: { status: 'applied', result: { offerStatus } } });
  });
  it.each([
    { kind: 'general.create' },
    { idempotencyKey: 'other:10000000-0000-4000-8000-000000000001' },
    { idempotencyKey: 'personnel:no-uuid' },
    { result: null },
    { result: { generalId: 3, officerLevel: 11, title: 12 } },
    { status: 'REJECTED', result: { code: '', message: '오류' } },
  ] satisfies Partial<Event>[])('손상된 표시 칸은 내부 오류로 낸다: %j', (change) => {
    try {
      toPersonnelRecord(row(change));
      throw new Error('거부되지 않음');
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
    }
  });
});
