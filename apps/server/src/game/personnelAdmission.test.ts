import type { Prisma } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import { submitPersonnelRequest } from './personnelAdmission';

const identity = {
  worldId: 'world',
  userId: 'user',
  sessionId: 'session',
  at: new Date(1000),
  requestId: '10000000-0000-4000-8000-000000000001',
};
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
function fixture() {
  const world = { id: 'world', status: 'RUNNING', replayFormat: 3, ruleFeatures: ['personnel', 'policy'] };
  const actor = { id: 1, nationId: 1 as number | null, officerLevel: 12, userId: 'user' };
  const target = { id: 3, nationId: 1, officerLevel: 1 };
  let previous: Pick<Event, 'kind' | 'payload'> | null = null;
  let pendingActivity = false;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<number>>(async () => 1),
    session: { findFirst: vi.fn(async (): Promise<object | null> => ({ id: 'session' })) },
    world: { findUnique: vi.fn(async () => world) },
    general: {
      findUnique: vi.fn(async ({ where }: { where: { worldId_userId?: unknown } }) =>
        where.worldId_userId ? actor : target,
      ),
      findFirst: vi.fn(async (): Promise<object | null> => null),
    },
    assignmentOffer: { findUnique: vi.fn(async () => ({ targetGeneralId: 1, status: 'PENDING' })) },
    inputEvent: {
      findUnique: vi.fn(async () => previous),
      findMany: vi.fn(async (): Promise<object[]> => []),
      create: vi.fn(async ({ data }: { data: { kind: string } }) => {
        if (pendingActivity && data.kind === 'general.active') throw new Error('InputEvent_pending_active_unique');
        return {};
      }),
    },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const submit = (
    kind: 'personnel.appoint' | 'personnel.dismiss' | 'offer.respond' = 'personnel.appoint',
    payload: unknown = { generalId: 3, officerLevel: 5 },
  ) => submitPersonnelRequest(client, { ...identity, kind, payload });
  return {
    world,
    actor,
    target,
    tx,
    submit,
    pendingActivity: () => {
      pendingActivity = true;
    },
    previous: (value: typeof previous) => {
      previous = value;
    },
  };
}

function expectActivityInsert(f: ReturnType<typeof fixture>) {
  expect(f.tx.$executeRaw).toHaveBeenCalledOnce();
  const [sql, ...values] = f.tx.$executeRaw.mock.calls[0]!;
  expect(values).toEqual(['world', 'user', 1, `general.active:personnel:${identity.requestId}`]);
  expect(sql.join('?').replace(/\s+/g, ' ').trim()).toBe(
    'INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status) ' +
      "VALUES (?,?,?,'general.active',?,'{}'::jsonb,'PENDING') " +
      'ON CONFLICT ("worldId","generalId") WHERE status=\'PENDING\' AND kind=\'general.active\' DO NOTHING',
  );
}

describe('인사 접수 B7 활동 경계', () => {
  it.each(['personnel.appoint', 'personnel.dismiss', 'offer.respond'] as const)(
    '새 %s 접수에만 같은 트랜잭션에서 활동 한 건을 접수한다',
    async (kind) => {
      const f = fixture();
      if (kind === 'personnel.dismiss') f.target.officerLevel = 5;
      const payload =
        kind === 'offer.respond'
          ? { offerId: 'offer:1', accept: false }
          : kind === 'personnel.dismiss'
            ? { generalId: 3 }
            : { generalId: 3, officerLevel: 5 };
      expect(await f.submit(kind, payload)).toEqual({ created: true });
      expect(f.tx.inputEvent.create).toHaveBeenCalledOnce();
      expect(f.tx.inputEvent.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({ generalId: 1, kind, payload, status: 'PENDING', sequence: null }),
      });
      expectActivityInsert(f);
    },
  );
  it('정책을 끄면 인사 접수만 만든다', async () => {
    const f = fixture();
    f.world.ruleFeatures = ['personnel'];
    await f.submit();
    expect(f.tx.inputEvent.create).toHaveBeenCalledOnce();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each(['personnel.appoint', 'personnel.dismiss', 'offer.respond'] as const)(
    '기존 PENDING 활동과 충돌한 %s도 접수하고 기존 활동을 덮어쓰지 않는다',
    async (kind) => {
      const f = fixture();
      if (kind === 'personnel.dismiss') f.target.officerLevel = 5;
      f.pendingActivity();
      f.tx.$executeRaw.mockResolvedValue(0);
      const payload =
        kind === 'offer.respond'
          ? { offerId: 'offer:1', accept: true }
          : kind === 'personnel.dismiss'
            ? { generalId: 3 }
            : { generalId: 3, officerLevel: 5 };
      expect(await f.submit(kind, payload)).toEqual({ created: true });
      expect(f.tx.inputEvent.create).toHaveBeenCalledOnce();
      expectActivityInsert(f);
      // 별도 활동 조회 뒤 갱신하는 대신 INSERT의 고유 제약으로 원자적으로 합친다.
      expect(f.tx.inputEvent.findMany).toHaveBeenCalledOnce();
    },
  );
  it('기존 형식에는 인사·활동 접수를 모두 쓰지 않는다', async () => {
    const f = fixture();
    f.world.replayFormat = 1;
    await expect(f.submit()).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('종료·강등 뒤의 같은 요청 재전송도 새 접수나 활동을 만들지 않는다', async () => {
    const f = fixture();
    f.world.status = 'ENDED';
    f.actor.officerLevel = 1;
    f.previous({ kind: 'personnel.appoint', payload: { generalId: 3, officerLevel: 5 } });
    expect(await f.submit()).toEqual({ created: false });
    expect(f.tx.general.findUnique).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each([
    { kind: 'personnel.dismiss', payload: { generalId: 3 } },
    { kind: 'personnel.appoint', payload: { generalId: 4, officerLevel: 5 } },
  ])('같은 UUID의 다른 종류·내용은 활동 없이 거부한다 (%j)', async (previous) => {
    const f = fixture();
    f.previous(previous);
    await expect(f.submit()).rejects.toHaveProperty('code', 'CONFLICT');
    expect(f.tx.general.findUnique).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('권한 없는 행위자는 대상 조회와 접수·활동 없이 거부한다', async () => {
    const f = fixture();
    f.actor.officerLevel = 11;
    await expect(f.submit()).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(f.tx.general.findUnique).toHaveBeenCalledOnce();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each([
    { generalId: 3, officerLevel: 12 },
    { generalId: 3, officerLevel: 5, userId: 'spoof' },
  ])('잘못된 입력은 인사·활동을 모두 쓰지 않는다 (%j)', async (payload) => {
    const f = fixture();
    await expect(f.submit('personnel.appoint', payload)).rejects.toHaveProperty('code', 'BAD_REQUEST');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each(['PREOPEN', 'PAUSED', 'ENDED'])('%s 월드는 새 접수나 활동을 쓰지 않는다', async (status) => {
    const f = fixture();
    f.world.status = status;
    await expect(f.submit()).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('제재·만료 세션은 월드를 읽기 전에 거부한다', async () => {
    const f = fixture();
    f.tx.session.findFirst.mockResolvedValue(null);
    await expect(f.submit()).rejects.toHaveProperty('code', 'UNAUTHORIZED');
    expect(f.tx.world.findUnique).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    expect(f.tx.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user', expiresAt: { gt: identity.at }, user: { status: 'ACTIVE' } }),
      }),
    );
  });
  it('다른 요청 번호의 PENDING도 중복 접수와 활동을 막는다', async () => {
    const f = fixture();
    f.tx.inputEvent.findMany.mockResolvedValue([{ id: 10n }]);
    await expect(f.submit()).rejects.toHaveProperty('code', 'CONFLICT');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('다른 장수의 발령과 이미 끝난 발령은 각각 NOT_FOUND와 CONFLICT다', async () => {
    const f = fixture();
    f.tx.assignmentOffer.findUnique.mockResolvedValue({ targetGeneralId: 3, status: 'PENDING' });
    await expect(f.submit('offer.respond', { offerId: 'offer:1', accept: true })).rejects.toHaveProperty(
      'code',
      'NOT_FOUND',
    );
    f.tx.assignmentOffer.findUnique.mockResolvedValue({ targetGeneralId: 1, status: 'ACCEPTED' });
    await expect(f.submit('offer.respond', { offerId: 'offer:1', accept: true })).rejects.toHaveProperty(
      'code',
      'CONFLICT',
    );
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('동반 활동 저장 실패는 삼키지 않고 호출자 트랜잭션으로 전파한다', async () => {
    const f = fixture();
    f.tx.$executeRaw.mockRejectedValueOnce(new Error('activity storage failure'));
    await expect(f.submit()).rejects.toThrow('activity storage failure');
    expect(f.tx.inputEvent.create).toHaveBeenCalledOnce();
  });
  it('활동의 다른 고유 제약 오류도 삼키지 않는다', async () => {
    const f = fixture();
    const failure = Object.assign(new Error('idempotency unique violation'), {
      code: '23505',
      constraint: 'InputEvent_worldId_userId_idempotencyKey_key',
    });
    f.tx.$executeRaw.mockRejectedValueOnce(failure);
    await expect(f.submit()).rejects.toBe(failure);
    expect(f.tx.inputEvent.create).toHaveBeenCalledOnce();
  });
});
