import { createDb } from '@opensamguk/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeTreatyRequestPayload,
  readTreatyRequest,
  requireLiveSession,
  submitTreatyRequest,
  type TreatyRequestKind,
} from './treatyRequests';

const identity = {
  worldId: 'world',
  userId: 'session-user',
  sessionId: 'session-hash',
  requestId: '10000000-0000-4000-8000-000000000001',
  at: new Date(1000),
};
const clients: ReturnType<typeof createDb>[] = [];
function fixture() {
  // 도달할 수 있는 DB 메서드를 대체한다. 연결을 열지 않는 보조 단위다.
  const db = createDb('postgresql://unused@127.0.0.1:1/unused');
  clients.push(db);
  const session = vi.spyOn(db.session, 'findFirst').mockResolvedValue(null);
  const world = vi.spyOn(db.world, 'findUnique').mockResolvedValue(null);
  const lock = vi.spyOn(db, '$queryRaw').mockResolvedValue([]);
  const create = vi.spyOn(db.inputEvent, 'create').mockImplementation(() => {
    throw new Error('입력 생성에 도달하면 안 됩니다.');
  });
  return { db, session, world, lock, create };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((db) => db.$disconnect()));
});

describe('T2-07 / AC-M2-06 요청의 JSON 저장 표현', () => {
  it('정렬과 NFC 변환은 공개 등록표를 쓰고 raw 사본은 바꾸지 않는다', () => {
    const raw = Object.freeze({
      toNationId: 2,
      clauses: Object.freeze([Object.freeze({ kind: 'note', text: '\u1100\u1161' }), Object.freeze({ kind: 'peace' })]),
    });
    expect(normalizeTreatyRequestPayload('treaty.propose', raw)).toEqual({
      toNationId: 2,
      clauses: [{ kind: 'peace' }, { kind: 'note', text: '가' }],
    });
    expect(raw.clauses[0]).toEqual({ kind: 'note', text: '\u1100\u1161' });
  });

  it('JSONB와 같은 0 표현으로 재전송을 비교한다', () => {
    const fromNegativeZero = normalizeTreatyRequestPayload('treaty.propose', {
      toNationId: 2,
      clauses: [{ kind: 'nonAggression', months: -0 }],
    });
    const fromZero = normalizeTreatyRequestPayload('treaty.propose', {
      toNationId: 2,
      clauses: [{ kind: 'nonAggression', months: 0 }],
    });
    expect(fromNegativeZero).toStrictEqual(fromZero);
    if (!('clauses' in fromNegativeZero)) throw new Error('제안 정규화 결과가 아닙니다.');
    expect(fromNegativeZero.clauses[0]).toStrictEqual({ kind: 'nonAggression', months: 0 });
  });

  it.each([
    { toNationId: 2, clauses: [{ kind: 'peace' }], generalId: 999 },
    { toNationId: 2, clauses: [{ kind: 'peace' }], expiresInMonths: 6 },
    { toNationId: 2, clauses: [{ kind: 'peace' }], cost: 0 },
    { toNationId: NaN, clauses: [{ kind: 'peace' }] },
  ])('추가 actor·비용과 파손된 구조는 고정 오류로 낸다 (%j)', (payload) => {
    expect(() => normalizeTreatyRequestPayload('treaty.propose', payload)).toThrow('조약 요청 내용을 확인하세요.');
  });

  it('구조를 지난 조항의 게임 판정을 API가 대신하지 않는다', () => {
    const payload = { toNationId: 2, clauses: [{ kind: 'trade', months: 1 }] };
    expect(normalizeTreatyRequestPayload('treaty.propose', payload)).toEqual(payload);
  });

  it.each([
    { treatyId: '001', accept: true },
    { treatyId: '10', accept: 'yes' },
    { treatyId: '10', accept: false, userId: '다른 사용자' },
  ])('응답의 정확한 저장 구조를 쓴다 (%j)', (payload) => {
    expect(() => normalizeTreatyRequestPayload('treaty.respond', payload)).toThrow('조약 요청 내용을 확인하세요.');
  });
});

describe('T2-07 / AC-M2-06 연결하지 않는 요청 입구 보조 단위', () => {
  it('세션 소유자·만료 시각·ACTIVE를 조회 조건으로 쓴다', async () => {
    const { db, session } = fixture();
    await expect(requireLiveSession(db, identity)).rejects.toHaveProperty('code', 'UNAUTHORIZED');
    expect(session).toHaveBeenCalledWith({
      where: {
        id: identity.sessionId,
        userId: identity.userId,
        expiresAt: { gt: identity.at },
        user: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
  });

  it.each([{ sessionId: '' }, { userId: '' }, { at: new Date(NaN) }])(
    '잘못된 인증 context로는 조회하지 않는다 (%j)',
    async (patch) => {
      const { db, session } = fixture();
      await expect(requireLiveSession(db, { ...identity, ...patch })).rejects.toHaveProperty('code', 'UNAUTHORIZED');
      expect(session).not.toHaveBeenCalled();
    },
  );

  it('잘못된 UUID와 미등록 kind는 인증·월드·입력 생성에 도달하지 않는다', async () => {
    const { db, session, world, lock, create } = fixture();
    await expect(
      submitTreatyRequest(db, { ...identity, requestId: 'bad', kind: 'treaty.propose', payload: {} }),
    ).rejects.toHaveProperty('code', 'BAD_REQUEST');
    await expect(
      submitTreatyRequest(db, { ...identity, kind: 'treaty.break' as TreatyRequestKind, payload: {} }),
    ).rejects.toHaveProperty('code', 'BAD_REQUEST');
    await expect(readTreatyRequest(db, { ...identity, requestId: 'bad' })).rejects.toHaveProperty(
      'code',
      'BAD_REQUEST',
    );
    expect(session).not.toHaveBeenCalled();
    expect(world).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('유효하지 않은 세션이면 접수와 회수 모두 월드를 읽지 않는다', async () => {
    const { db, world, lock, create } = fixture();
    await expect(submitTreatyRequest(db, { ...identity, kind: 'treaty.propose', payload: {} })).rejects.toHaveProperty(
      'code',
      'UNAUTHORIZED',
    );
    await expect(readTreatyRequest(db, identity)).rejects.toHaveProperty('code', 'UNAUTHORIZED');
    expect(world).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
