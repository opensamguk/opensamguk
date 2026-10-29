import { readFileSync } from 'node:fs';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import {
  buildInitialWorld,
  requestWorldResetInput,
  adminResetPayloadSchema,
  adminResetRejectMessages,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { requestWorldReset, getWorldResetRequest } from './worldReset';

const worldId = '00000000-0000-4000-8000-000000000001',
  userId = '00000000-0000-4000-8000-000000000002',
  key = '00000000-0000-4000-8000-000000000003',
  peer = '00000000-0000-4000-8000-000000000004';
const resource = (file: string): unknown =>
  JSON.parse(readFileSync(new URL('../../../../resources/' + file, import.meta.url), 'utf8'));
const initial = buildInitialWorld({
  map: resource('map/che.json'),
  scenario: resource('scenario/1030.json'),
  unitSet: resource('unitset/basic.json'),
  statRules: resource('scenario/default.json'),
  seed: 'source',
});
const origin = {
  version: 3,
  initial,
  initialStateHash: hashState(initial),
  resourceHash: hashState({
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
  }),
};
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
function input() {
  return requestWorldResetInput.parse({
    expectedUserId: userId,
    worldId,
    idempotencyKey: key,
    confirmName: '원본',
    expectedRevision: 2,
    reason: ' 초기화 확인 ',
  });
}
function fixture() {
  const world = {
      id: worldId,
      name: '원본',
      clockRevision: 2,
      replayFormat: 3,
      ruleFeatures: [],
      replayOrigin: structuredClone(origin),
      status: 'PAUSED',
      endedAt: null as Date | null,
      result: null as unknown,
    },
    user = {
      status: 'ACTIVE',
      role: 'ADMIN',
      emailVerifiedAt: new Date(0) as Date | null,
      consents: [
        { docType: 'TERMS', version: 'v1' },
        { docType: 'PRIVACY', version: 'v1' },
      ],
    },
    events: Event[] = [],
    audits: unknown[] = [];
  const forbidden = vi.fn(async () => {
    throw new Error('API 게임 쓰기 금지');
  });
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      return sql.join('').includes('clock_timestamp') ? [{ now: new Date('2026-10-29T00:00:00Z') }] : [{ id: worldId }];
    }),
    session: { findFirst: vi.fn(async () => ({ user })) },
    sanction: { findFirst: vi.fn(async () => null as { id: string } | null) },
    world: {
      findUnique: vi.fn(async () => world),
      create: forbidden,
      update: forbidden,
      updateMany: forbidden,
      delete: forbidden,
    },
    inputEvent: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { worldId_userId_idempotencyKey: { worldId: string; userId: string; idempotencyKey: string } };
        }) =>
          events.find(
            (e) =>
              e.worldId === where.worldId_userId_idempotencyKey.worldId &&
              e.userId === where.worldId_userId_idempotencyKey.userId &&
              e.idempotencyKey === where.worldId_userId_idempotencyKey.idempotencyKey,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Prisma.InputEventUncheckedCreateInput }) => {
        const event = {
          id: BigInt(events.length + 1),
          generalId: null,
          status: 'PENDING',
          sequence: null,
          stepTick: null,
          tick: null,
          result: null,
          createdAt: new Date(0),
          ...data,
        } as Event;
        events.push(event);
        return event;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        audits.push(data);
        return {};
      }),
    },
  };
  const transaction = vi.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const oldEvents = structuredClone(events),
      oldAudits = structuredClone(audits);
    try {
      return await run(tx as unknown as Prisma.TransactionClient);
    } catch (error) {
      events.splice(0, events.length, ...oldEvents);
      audits.splice(0, audits.length, ...oldAudits);
      throw error;
    }
  });
  const ctx = {
    db: { $transaction: transaction } as unknown as PrismaClient,
    user: { id: userId, email: 'fixture@example.test' },
    sessionId: 'own-session',
    emailVerificationRequired: true,
    legalPolicyRequired: true,
    legalPolicy: {
      terms: { version: 'v1', effectiveAt: '2026-01-01T00:00:00Z' },
      privacy: { version: 'v1', effectiveAt: '2026-01-01T00:00:00Z' },
    },
  } as Context;
  return { ctx, tx, user, world, events, audits, transaction, forbidden };
}
function applied(event: Event) {
  const p = adminResetPayloadSchema.parse(event.payload);
  return {
    version: 1,
    sourceWorldId: worldId,
    newWorldId: p.plannedNewWorldId,
    effectiveSeed: p.effectiveSeed,
    before: { status: 'PAUSED', tick: 0, revision: 2 },
    after: { status: 'ENDED', tick: 0, revision: 3 },
    at: '2026-10-29T00:00:00.000Z',
    finalStateHash: 'a'.repeat(64),
    sourceInitialHash: origin.initialStateHash,
    sourceResourceHash: origin.resourceHash,
    sourceSettingsHash: 'b'.repeat(64),
    newInitialHash: 'c'.repeat(64),
    newResourceHash: origin.resourceHash,
    newSettingsHash: 'd'.repeat(64),
    resources: ['MAP', 'PORTRAIT_MAP', 'SCENARIO', 'STAT_RULES', 'UNIT_SET'].map((kind) => ({
      kind,
      name: kind === 'MAP' ? 'che' : kind === 'SCENARIO' ? '1030' : kind === 'UNIT_SET' ? 'basic' : 'selected',
      version: 1,
      contentHash: 'a'.repeat(64),
    })),
    settings: {
      name: '원본',
      scenarioKey: '1030',
      mapKey: 'che',
      unitSetKey: 'basic',
      presetKey: null,
      presetHash: null,
      turnTermMinutes: 30,
      endYear: null,
      ruleFeatures: [],
      featureDataHash: 'a'.repeat(64),
    },
  } as Prisma.JsonObject;
}
it('D1 접수는 현재 권한 아래 PENDING 입력·감사만 쓰고 게임은0회 쓴다 (트랜잭션 대역)', async () => {
  const f = fixture(),
    before = structuredClone(f.world),
    result = await requestWorldReset(f.ctx, input());
  expect(result).toMatchObject({
    userId,
    worldId,
    idempotencyKey: key,
    requestId: '1',
    action: 'reset',
    status: 'PENDING',
    result: null,
  });
  expect(f.events).toHaveLength(1);
  expect(f.audits).toHaveLength(1);
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.world).toEqual(before);
  const sql = f.tx.$queryRaw.mock.calls.map((call) => call[0].join(''));
  expect(sql[0]).toContain('"World"');
  expect(sql[0]).toContain('FOR UPDATE');
  expect(sql[1]).toContain('"User"');
  expect(sql[2]).toContain('"Session"');
  expect(f.tx.session.findFirst.mock.calls[0]).toBeDefined();
  expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 });
});
it('D1 생략 시드와 target UUID는 첫 접수에만 고정하고 같은 키는 그대로 돌려준다', async () => {
  const f = fixture(),
    first = await requestWorldReset(f.ctx, input()),
    payload = structuredClone(f.events[0]!.payload);
  f.world.status = 'ENDED';
  const second = await requestWorldReset(f.ctx, input());
  expect(second).toEqual(first);
  expect(f.events[0]!.payload).toEqual(payload);
  expect(adminResetPayloadSchema.parse(payload).effectiveSeed).toMatch(/^[a-f0-9]{32}$/);
  expect(f.events).toHaveLength(1);
  expect(f.audits).toHaveLength(1);
  expect(f.tx.world.findUnique).toHaveBeenCalledOnce();
});
it('D1 명시 시드의 공백·unicode를 보존한다', async () => {
  const f = fixture();
  await requestWorldReset(f.ctx, { ...input(), seed: ' 새 시드 😀 ' });
  expect(adminResetPayloadSchema.parse(f.events[0]!.payload)).toMatchObject({
    effectiveSeed: ' 새 시드 😀 ',
    intent: { requestedSeed: ' 새 시드 😀 ' },
  });
});
it.each(['reason', 'confirmName', 'expectedRevision', 'seed'] as const)(
  'D1 같은 키의 %s 변경은 CONFLICT이고 추가 접수0이다',
  async (field) => {
    const f = fixture();
    await requestWorldReset(f.ctx, input());
    await expect(
      requestWorldReset(f.ctx, { ...input(), [field]: field === 'expectedRevision' ? 3 : 'other' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.events).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
  },
);
it('D1 다른 관리 kind에 쓴 같은 키를 재사용하지 않는다', async () => {
  const f = fixture();
  await requestWorldReset(f.ctx, input());
  f.events[0]!.kind = 'admin.world.end';
  await expect(requestWorldReset(f.ctx, input())).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.events).toHaveLength(1);
});
it.each(['APPLIED', 'REJECTED'] as const)('D1 이미 ENDED여도 본인 %s 결과를 동일 키로 확인한다', async (status) => {
  const f = fixture();
  await requestWorldReset(f.ctx, input());
  Object.assign(f.events[0]!, {
    status,
    sequence: 1,
    tick: 0,
    result:
      status === 'APPLIED'
        ? applied(f.events[0]!)
        : { code: 'WORLD_STATE_CHANGED', message: adminResetRejectMessages.WORLD_STATE_CHANGED },
  });
  f.world.status = 'ENDED';
  const retried = await requestWorldReset(f.ctx, input()),
    polled = await getWorldResetRequest(f.ctx, { expectedUserId: userId, worldId, idempotencyKey: key });
  expect(polled).toEqual(retried);
  expect(polled.status).toBe(status);
  expect(f.events).toHaveLength(1);
});
it('D1 기대계정 ABA 불일치는 TX 전에 막는다', async () => {
  const f = fixture();
  await expect(requestWorldReset(f.ctx, { ...input(), expectedUserId: peer })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  await expect(
    getWorldResetRequest(f.ctx, { expectedUserId: peer, worldId, idempotencyKey: key }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(f.transaction).not.toHaveBeenCalled();
});
it.each(['inactive', 'role', 'session', 'sanction', 'verification', 'consent', 'policy'] as const)(
  'D1 현재 %s 경계가 거부하면 접수·감사0이다',
  async (mode) => {
    const f = fixture();
    if (mode === 'inactive') f.user.status = 'WITHDRAWN';
    if (mode === 'role') f.user.role = 'USER';
    if (mode === 'session') f.tx.session.findFirst.mockResolvedValueOnce(null as unknown as { user: typeof f.user });
    if (mode === 'sanction') f.tx.sanction.findFirst.mockResolvedValueOnce({ id: 'sanction' });
    if (mode === 'verification') f.user.emailVerifiedAt = null;
    if (mode === 'consent') f.user.consents = [];
    if (mode === 'policy') f.ctx.legalPolicy = null;
    await expect(requestWorldReset(f.ctx, input())).rejects.toMatchObject({
      code:
        mode === 'role' || mode === 'verification' || mode === 'consent'
          ? 'FORBIDDEN'
          : mode === 'policy'
            ? 'SERVICE_UNAVAILABLE'
            : 'UNAUTHORIZED',
    });
    expect(f.events).toHaveLength(0);
    expect(f.audits).toHaveLength(0);
    expect(f.forbidden).not.toHaveBeenCalled();
  },
);
it('D1 접수 뒤 현재 role 회수와 Session 삭제는 본인 조회도 거부한다', async () => {
  const f = fixture();
  await requestWorldReset(f.ctx, input());
  f.user.role = 'USER';
  await expect(
    getWorldResetRequest(f.ctx, { expectedUserId: userId, worldId, idempotencyKey: key }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  f.user.role = 'ADMIN';
  f.tx.session.findFirst.mockResolvedValueOnce(null as unknown as { user: typeof f.user });
  await expect(requestWorldReset(f.ctx, input())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(f.events).toHaveLength(1);
});
it('D1 조회키는 현재 관리자 본인이고 다른 계정 키는 NOT_FOUND다', async () => {
  const f = fixture();
  await requestWorldReset(f.ctx, input());
  f.ctx.user!.id = peer;
  await expect(
    getWorldResetRequest(f.ctx, { expectedUserId: peer, worldId, idempotencyKey: key }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(f.tx.inputEvent.findUnique.mock.calls.at(-1)![0].where.worldId_userId_idempotencyKey.userId).toBe(peer);
});
it.each(['PREOPEN', 'RUNNING', 'ENDED'])('D1 신규 %s 원본은 접수하지 않는다', async (status) => {
  const f = fixture();
  f.world.status = status;
  await expect(requestWorldReset(f.ctx, input())).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.events).toHaveLength(0);
  expect(f.audits).toHaveLength(0);
});
it('D1 이름·revision·기존 종료 결과·endedAt 변경은 신규 요청0이다', async () => {
  for (const change of [{ name: 'changed' }, { clockRevision: 3 }, { result: { worldId } }, { endedAt: new Date(1) }]) {
    const f = fixture();
    Object.assign(f.world, change);
    await expect(requestWorldReset(f.ctx, input())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.events).toHaveLength(0);
  }
});
it('D1 구형·원본해시 변조는 형식 거부이고 원문을 노출하지 않는다', async () => {
  const f = fixture();
  f.world.replayFormat = 1;
  await expect(requestWorldReset(f.ctx, input())).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  const g = fixture();
  g.world.replayOrigin.initialStateHash = 'a'.repeat(64);
  await expect(requestWorldReset(g.ctx, input())).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.events).toHaveLength(0);
  expect(g.events).toHaveLength(0);
});
it('D1 감사 실패는 같은 접수 TX를 거부하고 DB 오류 원문을 응답에 넣지 않는다 (대역)', async () => {
  const f = fixture(),
    error = new Error('private audit refusal');
  f.tx.auditLog.create.mockRejectedValueOnce(error);
  await expect(requestWorldReset(f.ctx, input())).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    message: '월드 초기화 요청을 처리하지 못했습니다.',
  });
  expect(f.events).toHaveLength(0);
  expect(f.audits).toHaveLength(0);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('D1 손상 PENDING 결과와 다른 target의 APPLIED 결과를 성공으로 추측하지 않는다', async () => {
  const f = fixture();
  await requestWorldReset(f.ctx, input());
  f.events[0]!.sequence = 1;
  await expect(
    getWorldResetRequest(f.ctx, { expectedUserId: userId, worldId, idempotencyKey: key }),
  ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  Object.assign(f.events[0]!, { status: 'APPLIED', tick: 0, result: { ...applied(f.events[0]!), newWorldId: peer } });
  await expect(
    getWorldResetRequest(f.ctx, { expectedUserId: userId, worldId, idempotencyKey: key }),
  ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
});
