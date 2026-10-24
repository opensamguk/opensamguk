import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { ASSIGNMENT_EXPIRY_MONTHS } from '../packages/rules/src/personnel/types';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { appRouter } from '../apps/server/src/router';
import { buildServer } from '../apps/server/src/server';
import { readFixture } from '../apps/server/test/readFixture';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_000;
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, now: () => now, publicOrigin: origin, logging: false });
const paths = [
  'personnel.officers',
  'personnel.appoint',
  'personnel.dismiss',
  'personnel.request',
  'personnel.recent',
  'offers.mine',
  'offers.respond',
  'nationTurns.get',
  'nationTurns.set',
  'nationTurns.edit',
  'nationCommands.list',
  'nationCommands.precheck',
] as const;
type Path = (typeof paths)[number];
type Fixture = Awaited<ReturnType<typeof fixture>>;
const worldIds = new Set<string>();
const users: string[] = [];
const cookies: string[] = [];
let base: string;
let initial: Awaited<ReturnType<typeof readFixture>>;

beforeAll(async () => {
  const passwordHash = await hashPassword(randomUUID());
  for (let index = 0; index < 3; index++) {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, passwordHash, status: index === 2 ? 'SANCTIONED' : 'ACTIVE' },
    });
    users.push(user.id);
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
    cookies.push(`sid=${session.token}`);
  }
  initial = await readFixture();
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await db.world.deleteMany({ where: { id: { in: [...worldIds] } } });
  worldIds.clear();
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: [...worldIds] } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

async function fixture(path: Path) {
  const state = structuredClone(initial);
  // 형식 3의 기원은 NPC만 담는다. 접속 계정 연결은 생성 후 현재 DB 상태에만 둔다.
  for (const general of state.generals) general.userId = null;
  state.generals[0]!.officerLevel = path.startsWith('offers.') ? 5 : 12;
  state.generals[1]!.officerLevel = path.startsWith('offers.') ? 12 : 5;
  state.generals[2]!.officerLevel = 12;
  state.generals[2]!.cityKey = state.cities[1]!.cityKey;
  state.generals[3]!.officerLevel = 1;
  state.cities[2]!.nationId = 1;
  const { worldId } = await saveInitialWorld(db, state, {
    name: '인사 HTTP 권한 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: ['personnel', 'policy'],
  });
  worldIds.add(worldId);
  await db.world.update({
    where: { id: worldId },
    data: { status: 'RUNNING', clockTick: 100, clockAnchorAt: new Date(now) },
  });
  for (const [id, userId] of [
    [1, users[0]!],
    [3, users[1]!],
  ] as const)
    await db.general.update({
      where: { worldId_id: { worldId, id } },
      data: { userId, defaultPolicy: 'none', lastActiveTick: 0, residenceTick: 0 },
    });
  const requestId = randomUUID();
  const offerId = '0-2-1';
  if (path.startsWith('offers.'))
    await db.assignmentOffer.create({
      data: {
        worldId,
        id: offerId,
        nationId: 1,
        issuerGeneralId: 2,
        targetGeneralId: 1,
        cityKey: state.cities[2]!.cityKey,
        status: 'PENDING',
        createdTick: 0,
        expiresTick: ASSIGNMENT_EXPIRY_MONTHS * TICKS_PER_MONTH,
      },
    });
  if (path === 'personnel.request' || path === 'personnel.recent') {
    // 조회 사례의 기존 접수 내역. 엔진 적용 결과를 꾸며 넣지 않는다.
    await db.inputEvent.createMany({
      data: [
        {
          worldId,
          userId: users[0]!,
          generalId: 1,
          kind: 'personnel.dismiss',
          idempotencyKey: `personnel:${requestId}`,
          payload: { generalId: 2 },
          createdAt: new Date(now),
        },
        {
          worldId,
          userId: users[0]!,
          generalId: 1,
          kind: 'general.active',
          idempotencyKey: `general.active:personnel:${requestId}`,
          payload: {},
          createdAt: new Date(now),
        },
      ],
    });
  }
  return { worldId, requestId, offerId };
}

function input(path: Path, f: Fixture): Record<string, unknown> {
  const { worldId, requestId, offerId } = f;
  if (path === 'personnel.appoint') return { worldId, requestId, generalId: 2, officerLevel: 11 };
  if (path === 'personnel.dismiss') return { worldId, requestId, generalId: 2 };
  if (path === 'personnel.request') return { worldId, requestId };
  if (path === 'offers.respond') return { worldId, requestId, offerId, accept: true };
  const office = { nationId: 1, officerLevel: 12, tenure: 0 };
  if (path === 'nationTurns.set')
    return { worldId, office, revision: 0, slots: Array.from({ length: 12 }, () => null) };
  if (path === 'nationTurns.edit') return { worldId, office, revision: 0, op: { shift: 1 } };
  if (path === 'nationCommands.precheck') return { worldId, commandKey: 'nation_rest', args: {} };
  return { worldId };
}

function isMutation(path: Path) {
  const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  const procedure = procedures[path];
  if (!procedure) throw new Error(`실제 AppRouter에 없는 경로: ${path}`);
  return procedure._def.type === 'mutation';
}
async function request(path: Path, data: unknown, cookie?: string) {
  const mutation = isMutation(path);
  const encoded = JSON.stringify({ 0: data });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const body = (await response.json()) as Array<{ result?: { data: unknown }; error?: { data: { code: string } } }>;
  const first = body[0];
  if (!first) throw new Error('HTTP 응답에 tRPC 결과가 없습니다.');
  return { status: response.status, code: first.error?.data.code, data: first.result?.data };
}

function digest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
    .digest('hex');
}
async function snapshot(worldId: string) {
  const where = { worldId };
  // 계정·세션도 비교하되 실패 출력에는 원문과 자격 증명을 남기지 않는다.
  const rows = {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    generals: await db.general.findMany({ where, orderBy: { id: 'asc' } }),
    cities: await db.city.findMany({ where, orderBy: { cityKey: 'asc' } }),
    nations: await db.nation.findMany({ where, orderBy: { id: 'asc' } }),
    generalTurns: await db.generalTurn.findMany({ where, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    offices: await db.nationOffice.findMany({ where, orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }] }),
    officeTurns: await db.nationOfficeTurn.findMany({
      where,
      orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }, { slot: 'asc' }],
    }),
    offers: await db.assignmentOffer.findMany({ where, orderBy: { id: 'asc' } }),
    inputs: await db.inputEvent.findMany({ where, orderBy: { id: 'asc' } }),
    accounts: await db.user.findMany({ where: { id: { in: users } }, orderBy: { id: 'asc' } }),
    sessions: await db.session.findMany({ where: { userId: { in: users } }, orderBy: { id: 'asc' } }),
  };
  return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, digest(value)]));
}

function expectRead(path: Path, data: unknown, f: Fixture, foreign = false) {
  if (path === 'personnel.officers') {
    expect(data).toMatchObject({ appoint: { ok: true } });
    expect(data).toHaveProperty(
      'members',
      foreign
        ? [expect.objectContaining({ generalId: 3 })]
        : [expect.objectContaining({ generalId: 1 }), expect.objectContaining({ generalId: 2 })],
    );
  } else if (path === 'personnel.request') {
    expect(data).toEqual({ kind: 'personnel.dismiss', state: { status: 'pending', requestId: f.requestId } });
  } else if (path === 'personnel.recent') {
    expect(data).toEqual(
      foreign ? [] : [{ kind: 'personnel.dismiss', state: { status: 'pending', requestId: f.requestId } }],
    );
  } else if (path === 'offers.mine') {
    expect(data).toEqual(foreign ? [] : [expect.objectContaining({ id: f.offerId, respond: { ok: true } })]);
  } else if (path === 'nationTurns.get') {
    const tabs = (data as { tabs: Array<{ office: { nationId: number }; slots: unknown[]; edit: { ok: boolean } }> })
      .tabs;
    expect(tabs).toHaveLength(8);
    expect(tabs.every((tab) => tab.office.nationId === (foreign ? 2 : 1) && tab.slots.length === 12)).toBe(true);
    expect(tabs.filter((tab) => tab.edit.ok)).toHaveLength(1);
  } else if (path === 'nationCommands.list') {
    expect(data).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'nation_rest' })]));
  } else if (path === 'nationCommands.precheck') {
    expect(data).toEqual({ ok: true });
  } else throw new Error(`조회 검증이 없는 경로: ${path}`);
}

async function expectWrite(path: Path, data: unknown, f: Fixture, before: Awaited<ReturnType<typeof snapshot>>) {
  const events = await db.inputEvent.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  const after = await snapshot(f.worldId);
  if (path === 'personnel.appoint' || path === 'personnel.dismiss' || path === 'offers.respond') {
    expect(data).toEqual({ status: 'pending', requestId: f.requestId });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      userId: users[0],
      generalId: 1,
      kind: path === 'offers.respond' ? 'offer.respond' : path,
      status: 'PENDING',
      sequence: null,
      idempotencyKey: `personnel:${f.requestId}`,
      payload:
        path === 'personnel.appoint'
          ? { generalId: 2, officerLevel: 11 }
          : path === 'personnel.dismiss'
            ? { generalId: 2 }
            : { offerId: f.offerId, accept: true },
    });
    expect(events[1]).toMatchObject({
      userId: users[0],
      generalId: 1,
      kind: 'general.active',
      status: 'PENDING',
      sequence: null,
      idempotencyKey: `general.active:personnel:${f.requestId}`,
    });
    expect({ ...after, inputs: before.inputs }).toEqual(before);
  } else {
    expect(data).toMatchObject({ ok: true, revision: 1 });
    expect(data).toHaveProperty(
      'slots',
      Array.from({ length: 12 }, () => expect.objectContaining({ commandKey: 'nation_rest', args: {} })),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: users[0],
      generalId: 1,
      kind: 'nationTurns.set',
      status: 'APPLIED',
      sequence: 1,
      tick: 100,
    });
    expect(await db.nationOffice.findMany({ where: { worldId: f.worldId } })).toEqual([
      { worldId: f.worldId, nationId: 1, officerLevel: 12, tenure: 0, turnRevision: 1 },
    ]);
    expect(await db.nationOfficeTurn.count({ where: { worldId: f.worldId, nationId: 1, officerLevel: 12 } })).toBe(12);
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).toMatchObject({
      lastActiveTick: 100,
      residenceTick: 0,
    });
    expect(await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).toMatchObject({
      actionSequence: 1,
      clockTick: 100,
    });
    for (const key of ['world', 'generals', 'offices', 'officeTurns', 'inputs']) after[key] = before[key]!;
    expect(after).toEqual(before);
  }
}

describe('B7 실제 HTTP·PostgreSQL 인가 기록', () => {
  for (const path of paths)
    for (const category of categories) {
      it(
        `${path} ${category}`,
        authzCase(path, category, async () => {
          const f = await fixture(path);
          const cookie =
            category === 'unauthenticated'
              ? undefined
              : cookies[category === 'sanctioned' ? 2 : category === 'otherUser' ? 1 : 0];
          const data = category === 'invalidInput' ? { ...input(path, f), userId: users[1] } : input(path, f);
          const before = await snapshot(f.worldId);
          const result = await request(path, data, cookie);
          if (category === 'success') {
            expect(result.status).toBe(200);
            expect(result.code).toBeUndefined();
            if (isMutation(path)) await expectWrite(path, result.data, f, before);
            else {
              expectRead(path, result.data, f);
              expect(await snapshot(f.worldId)).toEqual(before);
            }
          } else if (category === 'otherUser') {
            const rejection =
              path === 'personnel.appoint' || path === 'personnel.dismiss'
                ? (['BAD_REQUEST', 400] as const)
                : path === 'personnel.request' || path === 'offers.respond'
                  ? (['NOT_FOUND', 404] as const)
                  : path === 'nationTurns.set' || path === 'nationTurns.edit'
                    ? (['PRECONDITION_FAILED', 412] as const)
                    : null;
            if (rejection) {
              expect(result.code).toBe(rejection[0]);
              expect(result.status).toBe(rejection[1]);
            } else {
              expect(result.status).toBe(200);
              expect(result.code).toBeUndefined();
              expectRead(path, result.data, f, true);
            }
            expect(await snapshot(f.worldId)).toEqual(before);
          } else {
            expect(result.code).toBe(category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED');
            expect(result.status).toBe(category === 'invalidInput' ? 400 : 401);
            expect(await snapshot(f.worldId)).toEqual(before);
          }
        }),
      );
    }
});
