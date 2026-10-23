import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, nextActionSequence, type Prisma } from '@opensamguk/db';
import { selectWorldCapabilities, settleTreaties } from '@opensamguk/rules';
import { readFixture } from '../../test/readFixture';
import { submitTreatyRequest, readTreatyRequest, type TreatyRequestKind } from './treatyRequests';
// 승인된 실제 생성 경로를 통합 fixture에서만 부른다. production 의존 방향은 바꾸지 않는다.
// eslint-disable-next-line opensamguk/no-cross-package-relative
import { saveInitialWorld } from '../../../engine/src/world/persistence';
// eslint-disable-next-line opensamguk/no-cross-package-relative
import { controlClock } from '../../../engine/src/world/clock';
// 완료 행 준비용 component다. 중앙 consumer·리스·loop의 증거는 아니다.
// eslint-disable-next-line opensamguk/no-cross-package-relative
import { processTreatyInput } from '../../../engine/src/treatyInput';
// eslint-disable-next-line opensamguk/no-cross-package-relative
import { loadWorld } from '../../../engine/src/worldLoader';
// eslint-disable-next-line opensamguk/no-cross-package-relative
import { persistTreatyClosures } from '../../../engine/src/treatyState';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds = new Set<string>();
const users = new Set<string>();
const at = new Date('2026-01-01T00:00:00Z');
const clauses = [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }];
const payload = { toNationId: 2, clauses };
type Identity = Parameters<typeof readTreatyRequest>[1];

afterAll(async () => {
  try {
    if (worlds.size) await db.world.deleteMany({ where: { id: { in: [...worlds] } } });
    if (users.size) await db.user.deleteMany({ where: { id: { in: [...users] } } });
  } finally {
    await db.$disconnect();
  }
});

async function fixture(
  options: {
    policy?: boolean;
    off?: boolean;
    npc?: boolean;
    proposerLevel?: number;
    responderLevel?: number;
    targetGold?: number;
  } = {},
) {
  const initial = await readFixture();
  const userIds = initial.generals.map(() => randomUUID());
  const sessionIds = userIds.map(() => randomUUID());
  userIds.forEach((id) => users.add(id));
  initial.nations = initial.nations.map((nation) => ({
    ...nation,
    gold: nation.id === 2 ? (options.targetGold ?? 1000) : 1000,
    isNpc: options.npc === true && nation.id === 2,
  }));
  initial.nations.push({
    ...initial.nations[1]!,
    id: 3,
    name: '제삼국',
    isNpc: false,
    capitalCityKey: initial.cities[3]!.cityKey,
  });
  initial.cities[2]!.nationId = 1;
  initial.cities[3]!.nationId = 3;
  initial.generals = initial.generals.map((general, index) => ({
    ...general,
    userId: options.npc && index === 1 ? null : userIds[index]!,
    nationId: [1, 2, 3, 1][index]!,
    officerLevel:
      index === 0 ? (options.proposerLevel ?? 12) : index === 1 ? (options.responderLevel ?? 12) : index === 3 ? 1 : 12,
  }));
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
  await db.user.createMany({
    data: userIds.map((id) => ({ id, email: `${id}@example.invalid`, passwordHash: 'test-only' })),
  });
  await db.session.createMany({
    data: userIds.map((userId, index) => ({
      id: sessionIds[index]!,
      userId,
      expiresAt: new Date(at.getTime() + 60_000),
    })),
  });
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '조약 서버 저장 경계',
    turnTermMinutes: 30,
    endYear: null,
    ...(options.policy ? {} : { replayFormat: 'legacy' as const }),
    ...(options.off ? {} : { treatyFormat: 1 as const }),
  });
  worlds.add(worldId);
  await controlClock(db, worldId, 'start', at.getTime());
  const identity = (index = 0, requestId: string = randomUUID()): Identity => ({
    worldId,
    userId: userIds[index]!,
    sessionId: sessionIds[index]!,
    at,
    requestId,
  });
  return { worldId, userIds, sessionIds, identity };
}

const submit = (identity: Identity, value: unknown = payload, kind: TreatyRequestKind = 'treaty.propose') =>
  db.$transaction((tx) => submitTreatyRequest(tx, { ...identity, kind, payload: value }), {
    isolationLevel: 'ReadCommitted',
  });
const read = (identity: Identity) =>
  db.$transaction((tx) => readTreatyRequest(tx, identity), { isolationLevel: 'RepeatableRead' });
const events = (worldId: string) => db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } });

async function snapshot(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    nations: await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    cities: await db.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    relations: await db.diplomacy.findMany({ where: { worldId }, orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }] }),
    treaties: await db.treaty.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    generalTurns: await db.generalTurn.findMany({
      where: { worldId },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    }),
    nationTurns: await db.nationTurn.findMany({ where: { worldId }, orderBy: [{ nationId: 'asc' }, { slot: 'asc' }] }),
    lease: await db.engineLease.findUnique({ where: { worldId } }),
    heartbeat: await db.engineHeartbeat.findUnique({ where: { worldId } }),
  };
}

async function complete(identity: Identity, tick = 1500) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${identity.worldId} FOR UPDATE`;
    const world = await tx.world.findUniqueOrThrow({ where: { id: identity.worldId } });
    const event = await tx.inputEvent.findUniqueOrThrow({
      where: {
        worldId_userId_idempotencyKey: {
          worldId: identity.worldId,
          userId: identity.userId,
          idempotencyKey: `treaty.propose:${identity.requestId}`,
        },
      },
    });
    await processTreatyInput(tx, world, event, tick);
    return tx.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
  });
}

async function proposal(f: Awaited<ReturnType<typeof fixture>>) {
  const identity = f.identity();
  await submit(identity);
  const event = await complete(identity);
  expect(event.status).toBe('APPLIED');
  return { identity, treatyId: String(event.sequence) };
}

async function completeResponse(identity: Identity, treatyId: string, accept: boolean) {
  await submit(identity, { treatyId, accept }, 'treaty.respond');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${identity.worldId} FOR UPDATE`;
    const world = await tx.world.findUniqueOrThrow({ where: { id: identity.worldId } });
    const event = await tx.inputEvent.findFirstOrThrow({
      where: {
        worldId: identity.worldId,
        userId: identity.userId,
        idempotencyKey: `treaty.respond:${identity.requestId}`,
      },
    });
    await processTreatyInput(tx, world, event, 1501);
  });
}

// 실제 순수 정산과 저장 component로 과거 조회 행을 준비한다. 월간 loop 실행은 아니다.
async function closeTreaties(worldId: string, tick: number) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    const before = await loadWorld(tx, worldId);
    const next = settleTreaties(before, tick);
    const sequence = await nextActionSequence(tx, worldId);
    await persistTreatyClosures(tx, worldId, before, next, { tick, sequence });
  });
}

describe('T2-07 / AC-M2-06 서버 조약 leaf 실제 PostgreSQL 경계', () => {
  it.each([false, true])('실제 factory의 origin6와 policy 선택을 확인한다 (F0 %s)', async (policy) => {
    const f = await fixture({ policy });
    const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
    expect(world.treatyFormat).toBe(1);
    expect(world.replayOrigin).toMatchObject({ version: 6, capabilities: { version: 1, treaty: { version: 1 } } });
    expect(selectWorldCapabilities(world).kind).toBe('caps');
    expect(world.policyFromSequence).toBe(policy ? 0 : null);
    expect(await db.treaty.count({ where: { worldId: f.worldId } })).toBe(0);
    const identity = f.identity();
    expect(await submit(identity)).toEqual({ created: true });
    expect(await read(identity)).toEqual({ status: 'pending', requestId: identity.requestId, kind: 'treaty.propose' });
  });

  it.each([12, 11])('직위 %i 접수는 게임 상태를 보존하고 SQL NULL 대기 입력 하나만 쓴다', async (officerLevel) => {
    const f = await fixture({ proposerLevel: officerLevel });
    const before = await snapshot(f.worldId);
    await submit(f.identity());
    expect(await snapshot(f.worldId)).toEqual(before);
    const rows = await events(f.worldId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: f.userIds[0],
      generalId: 1,
      kind: 'treaty.propose',
      status: 'PENDING',
      sequence: null,
      result: null,
    });
    expect(
      await db.$queryRaw`SELECT "sequence" IS NULL AS seq, "result" IS NULL AS result FROM "InputEvent" WHERE id = ${rows[0]!.id}`,
    ).toEqual([{ seq: true, result: true }]);
  });

  it('조항 순서·NFC·JSON 음수 영을 같은 nonce의 저장 표현으로 비교한다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity, { toNationId: 2, clauses: [{ kind: 'note', text: '가' }, ...clauses] });
    expect(
      await submit(identity, { clauses: [...clauses.toReversed(), { kind: 'note', text: '가' }], toNationId: 2 }),
    ).toEqual({ created: false });
    const zero = f.identity();
    await submit(zero, { toNationId: 3, clauses: [{ kind: 'nonAggression', months: -0 }] });
    expect(await submit(zero, { toNationId: 3, clauses: [{ kind: 'nonAggression', months: 0 }] })).toEqual({
      created: false,
    });
    expect((await events(f.worldId))[1]!.payload).toMatchObject({ clauses: [{ kind: 'nonAggression', months: 0 }] });
  });

  it('같은 nonce는 직위·소속·월드 종료 뒤에도 기존 요청을 돌려준다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity);
    await db.general.update({
      where: { worldId_id: { worldId: f.worldId, id: 1 } },
      data: { officerLevel: 1, nationId: null },
    });
    await db.world.update({ where: { id: f.worldId }, data: { status: 'ENDED', monthlyTick: 90000 } });
    expect(await submit(identity)).toEqual({ created: false });
    expect(await read(identity)).toEqual({ status: 'pending', requestId: identity.requestId, kind: 'treaty.propose' });
    await expect(submit(f.identity())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await events(f.worldId)).toHaveLength(1);
  });

  it('같은 nonce의 다른 payload와 다른 kind를 거절한다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity);
    await expect(submit(identity, { ...payload, toNationId: 3 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(submit(identity, { treatyId: '1', accept: true }, 'treaty.respond')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await events(f.worldId)).toHaveLength(1);
  });

  it('두 정확 nonce key가 함께 있으면 접수와 회수를 모두 거절한다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity);
    await db.inputEvent.create({
      data: {
        worldId: f.worldId,
        userId: identity.userId,
        generalId: 1,
        kind: 'treaty.respond',
        idempotencyKey: `treaty.respond:${identity.requestId}`,
        payload: { treatyId: '1', accept: false },
      },
    });
    await expect(submit(identity)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(read(identity)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([true, false])('독립 TX 둘을 World 잠금으로 직렬화한다 (같은 nonce %s)', async (sameNonce) => {
    const f = await fixture();
    const first = f.identity();
    const second = sameNonce ? first : f.identity();
    const outcomes = await Promise.allSettled([submit(first), submit(second)]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(sameNonce ? 2 : 1);
    if (sameNonce)
      expect(outcomes.map((entry) => entry.status === 'fulfilled' && entry.value.created).sort()).toEqual([
        false,
        true,
      ]);
    else expect(outcomes.find((entry) => entry.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
    expect(await events(f.worldId)).toHaveLength(1);
  });

  it('다른 UUID의 같은 대상은 대기 중에만 막고 완료 뒤에는 받는다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity);
    await expect(submit(f.identity())).rejects.toMatchObject({ code: 'CONFLICT' });
    await complete(identity);
    expect(await submit(f.identity())).toEqual({ created: true });
    expect(await events(f.worldId)).toHaveLength(2);
  });

  it.each(['missing', 'expired', 'logout', 'sanctioned', 'withdrawn', 'owner'] as const)(
    '현재 세션이 유효하지 않으면 접수와 회수를 막는다 (%s)',
    async (mode) => {
      const f = await fixture();
      const identity = f.identity();
      await submit(identity);
      if (mode === 'missing') identity.sessionId = randomUUID();
      if (mode === 'expired') await db.session.update({ where: { id: identity.sessionId }, data: { expiresAt: at } });
      if (mode === 'logout') await db.session.delete({ where: { id: identity.sessionId } });
      if (mode === 'sanctioned' || mode === 'withdrawn')
        await db.user.update({
          where: { id: identity.userId },
          data: { status: mode === 'sanctioned' ? 'SANCTIONED' : 'WITHDRAWN' },
        });
      if (mode === 'owner') identity.sessionId = f.sessionIds[1]!;
      const before = await events(f.worldId);
      await expect(submit(identity)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(read(identity)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(await events(f.worldId)).toEqual(before);
    },
  );

  it.each([1, 10])('직위 %i 새 접수를 막는다', async (officerLevel) => {
    const f = await fixture({ proposerLevel: officerLevel });
    await expect(submit(f.identity())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await events(f.worldId)).toEqual([]);
  });

  it.each(['general', 'nation'] as const)('현재 %s가 없으면 새 접수를 막는다', async (mode) => {
    const f = await fixture();
    if (mode === 'general') await db.general.delete({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
    else await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { nationId: null } });
    await expect(submit(f.identity())).rejects.toMatchObject({ code: mode === 'general' ? 'NOT_FOUND' : 'FORBIDDEN' });
    expect(await events(f.worldId)).toEqual([]);
  });

  it.each([
    { ...payload, generalId: 2 },
    { ...payload, cost: 0 },
    { toNationId: 2, clauses: [{ kind: 'peace', private: true }] },
    { toNationId: -1, clauses },
  ])('잘못된 요청 구조는 입력을 쓰지 않는다 (%j)', async (value) => {
    const f = await fixture();
    await expect(submit(f.identity(), value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await events(f.worldId)).toEqual([]);
  });

  it('다른 월드에만 있는 조약 ID로 응답하지 못한다', async () => {
    const f = await fixture();
    const p = await proposal(f);
    const other = await fixture();
    await expect(
      submit(other.identity(1), { treatyId: p.treatyId, accept: true }, 'treaty.respond'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: '응답할 조약이 없습니다.' });
    expect(await events(other.worldId)).toEqual([]);
  });

  it('다른 사용자·다른 월드·추측 nonce로 요청을 읽지 못한다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity);
    const other = await fixture();
    for (const attempt of [f.identity(1, identity.requestId), f.identity(), { ...identity, worldId: other.worldId }])
      await expect(read(attempt)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['0', '2147483648', '2'])('응답 대상 %s의 구조·범위와 비당사자 접근을 막는다', async (treatyId) => {
    const f = await fixture();
    const p = await proposal(f);
    await expect(submit(f.identity(2), { treatyId: p.treatyId, accept: true }, 'treaty.respond')).rejects.toMatchObject(
      { code: 'NOT_FOUND', message: '응답할 조약이 없습니다.' },
    );
    await expect(submit(f.identity(1), { treatyId, accept: true }, 'treaty.respond')).rejects.toMatchObject(
      treatyId === '0' ? { code: 'BAD_REQUEST' } : { code: 'NOT_FOUND', message: '응답할 조약이 없습니다.' },
    );
    expect(await events(f.worldId)).toHaveLength(1);
  });

  it.each([12, 11])('직위 %i 응답 접수도 상태를 보존하고 중복 대상을 막는다', async (officerLevel) => {
    const f = await fixture({ responderLevel: officerLevel });
    const p = await proposal(f);
    const identity = f.identity(1);
    const before = await snapshot(f.worldId);
    expect(await submit(identity, { treatyId: p.treatyId, accept: false }, 'treaty.respond')).toEqual({
      created: true,
    });
    expect(await snapshot(f.worldId)).toEqual(before);
    expect(await submit(identity, { accept: false, treatyId: p.treatyId }, 'treaty.respond')).toEqual({
      created: false,
    });
    await expect(submit(f.identity(1), { treatyId: p.treatyId, accept: true }, 'treaty.respond')).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
  });

  it.each([true, false])('완료 응답에서 APPLIED 수락·거절과 허용 상세만 읽는다 (수락 %s)', async (accept) => {
    const f = await fixture();
    const p = await proposal(f);
    const identity = f.identity(1);
    await completeResponse(identity, p.treatyId, accept);
    const result = await read(identity);
    expect(result).toMatchObject({
      status: 'applied',
      outcome: accept ? 'ACCEPTED' : 'DECLINED',
      treatyId: p.treatyId,
      treaty: { id: p.treatyId, incoming: true, status: accept ? 'ACTIVE' : 'REJECTED', respondByTick: null },
    });
    if (result.status !== 'applied' || !result.treaty) throw new Error('상세 준비 실패');
    expect(Object.keys(result).sort()).toEqual(['kind', 'outcome', 'requestId', 'status', 'treaty', 'treatyId']);
    expect(Object.keys(result.treaty).sort()).toEqual([
      'clauses',
      'cost',
      'endTick',
      'fromNationId',
      'id',
      'incoming',
      'proposedTick',
      'respondByTick',
      'startTick',
      'status',
      'toNationId',
    ]);
    expect(result.treaty.cost).toEqual(accept ? { from: 17, to: 9 } : null);
  });

  it('InputEvent REJECTED를 APPLIED DECLINED와 구별하고 원래 사유를 읽는다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity, { toNationId: 999, clauses });
    const event = await complete(identity);
    expect(event.status).toBe('REJECTED');
    expect(await read(identity)).toMatchObject({ status: 'rejected', code: 'BAD_TARGET' });
    expect(await read(identity)).not.toHaveProperty('treaty');
    await db.world.update({ where: { id: f.worldId }, data: { status: 'ENDED', monthlyTick: 90000 } });
    await db.general.delete({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
    expect(await read(identity)).toEqual({
      status: 'rejected',
      requestId: identity.requestId,
      kind: 'treaty.propose',
      code: 'BAD_TARGET',
      reason: '조약 상대 국가를 확인하세요.',
    });
  });

  it.each(['EXPIRED', 'ENDED'] as const)('실제 정산으로 닫힌 %s 이력을 원래 완료 입력에서 읽는다', async (status) => {
    const f = await fixture();
    const p = await proposal(f);
    if (status === 'ENDED') await completeResponse(f.identity(1), p.treatyId, true);
    await closeTreaties(f.worldId, 70000);
    await db.world.update({ where: { id: f.worldId }, data: { monthlyTick: 90000, status: 'ENDED' } });
    const result = await read(p.identity);
    expect(result).toMatchObject({ status: 'applied', outcome: 'PROPOSED', treaty: { status, respondByTick: null } });
    if (result.status !== 'applied' || !result.treaty) throw new Error('닫힌 이력 준비 실패');
    expect(result.treaty.cost).toEqual(status === 'ENDED' ? { from: 17, to: 9 } : null);
  });

  it.each([true, false])('NPC 최대 마감의 이력을 현재 NPC flag로 재판정하지 않는다 (수락 %s)', async (accept) => {
    const f = await fixture({ npc: true, targetGold: accept ? 1000 : 0 });
    const identity = f.identity();
    await submit(identity);
    expect((await complete(identity, 2147423647)).status).toBe('APPLIED');
    if (accept) await closeTreaties(f.worldId, 2147440000);
    await db.nation.update({ where: { worldId_id: { worldId: f.worldId, id: 2 } }, data: { isNpc: false } });
    await db.world.update({ where: { id: f.worldId }, data: { monthlyTick: 2147470000, status: 'ENDED' } });
    expect(await read(identity)).toMatchObject({
      status: 'applied',
      outcome: accept ? 'ACCEPTED' : 'DECLINED',
      treaty: { status: accept ? 'ENDED' : 'REJECTED', proposedTick: 2147423647, respondByTick: null },
    });
    expect((await db.treaty.findFirstOrThrow({ where: { worldId: f.worldId } })).respondByTick).toBe(2147483647);
  });

  it.each(['role', 'nation', 'general'] as const)(
    '월간·종료 뒤 과거 결과를 현재 %s 조건으로 재판정하지 않는다',
    async (mode) => {
      const f = await fixture();
      const p = await proposal(f);
      await db.world.update({
        where: { id: f.worldId },
        data: { monthlyTick: 90000, status: 'ENDED', clockTick: 90000 },
      });
      if (mode === 'general') await db.general.delete({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
      else
        await db.general.update({
          where: { worldId_id: { worldId: f.worldId, id: 1 } },
          data: mode === 'role' ? { officerLevel: 1 } : { nationId: 3 },
        });
      const result = await read(p.identity);
      expect(result).toMatchObject({ status: 'applied', outcome: 'PROPOSED', treatyId: p.treatyId });
      if (result.status !== 'applied') throw new Error('과거 기록 준비 실패');
      expect(result.treaty === null).toBe(mode !== 'role');
      expect(await submit(p.identity)).toEqual({ created: false });
    },
  );

  it.each(['generalZero', 'generalMissing', 'kind', 'payload'] as const)(
    '파손 PENDING %s는 고정 오류로 닫는다',
    async (field) => {
      const f = await fixture();
      const identity = f.identity();
      await submit(identity);
      const event = (await events(f.worldId))[0]!;
      // completion CHECK를 지킨 채 서버가 거절할 파손 행을 만든다.
      const data: Prisma.InputEventUpdateInput =
        field === 'generalZero'
          ? { generalId: 0 }
          : field === 'generalMissing'
            ? { generalId: null }
            : field === 'kind'
              ? { kind: 'unrelated' }
              : { payload: { private: '노출 금지' } };
      await db.inputEvent.update({ where: { id: event.id }, data });
      await expect(read(identity)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: '조약 요청 기록을 확인하지 못했습니다.',
      });
    },
  );

  it.each(['closedSequence', 'clauses', 'costFrom'] as const)(
    '파손 완료 조약 %s를 상세로 내보내지 않는다',
    async (field) => {
      const f = await fixture();
      const p = await proposal(f);
      const response = f.identity(1);
      await completeResponse(response, p.treatyId, false);
      const data =
        field === 'closedSequence'
          ? { closedSequence: 0 }
          : field === 'clauses'
            ? { clauses: [{ kind: 'note', text: '기록' }, { kind: 'peace' }] }
            : { costFrom: 5 };
      await db.treaty.update({ where: { worldId_id: { worldId: f.worldId, id: Number(p.treatyId) } }, data });
      await expect(read(response)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: '저장된 조약을 확인하지 못했습니다.',
      });
    },
  );

  it.each(['sequence', 'outcome', 'payload', 'kind'] as const)(
    '파손 완료 입력 %s는 내부 필드를 숨긴 고정 오류로 닫는다',
    async (field) => {
      const f = await fixture();
      const p = await proposal(f);
      const event = (await events(f.worldId))[0]!;
      // 양수 2는 DB 제약을 지나지만 제안 결과의 treatyId 1과 맞지 않는다.
      const data: Prisma.InputEventUpdateInput =
        field === 'sequence'
          ? { sequence: 2 }
          : field === 'outcome'
            ? { result: { outcome: 'ACCEPTED', private: '노출 금지' } }
            : field === 'payload'
              ? { payload: { toNationId: 2, clauses, private: '노출 금지' } }
              : { kind: 'unrelated' };
      await db.inputEvent.update({ where: { id: event.id }, data });
      await expect(read(p.identity)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: '조약 요청 기록을 확인하지 못했습니다.',
      });
    },
  );

  it('실제 off factory는 기능 전제 오류로 닫는다', async () => {
    const f = await fixture({ off: true });
    await expect(submit(f.identity())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(read(f.identity())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await events(f.worldId)).toEqual([]);
  });

  it('실제 생성 뒤 저장 flag를 파손하면 접수와 회수를 고정 내부 오류로 닫는다', async () => {
    const f = await fixture();
    const identity = f.identity();
    await submit(identity);
    await db.world.update({ where: { id: f.worldId }, data: { treatyFormat: null } });
    await expect(submit(identity)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: '저장된 조약을 확인하지 못했습니다.',
    });
    await expect(read(identity)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: '저장된 조약을 확인하지 못했습니다.',
    });
  });
});
