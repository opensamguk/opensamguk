import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  TICKS_PER_MONTH,
  officerTitle,
  toGameDate,
  assignmentRejectCost,
  ASSIGNMENT_REJECT_PERCENT,
  canExecuteNationCommand,
} from '../packages/rules/src/index';
import { ASSIGNMENT_EXPIRY_MONTHS } from '../packages/rules/src/personnel/types';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { appRouter } from '../apps/server/src/router';
import { buildServer } from '../apps/server/src/server';
import { readFixture } from '../apps/server/test/readFixture';
import { worldResolver } from '../apps/server/src/game/resolver';
import { submitPersonnelRequest } from '../apps/server/src/game/personnelAdmission';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';

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
  for (let index = 0; index < 4; index++) {
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

async function fixture(path: Path, options: { owner?: number; requestId?: string } = {}) {
  const owner = options.owner ?? 0;
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
    [1, users[owner]!],
    [3, users[1]!],
  ] as const)
    await db.general.update({
      where: { worldId_id: { worldId, id } },
      data: {
        userId,
        defaultPolicy: 'none',
        lastActiveTick: path === 'nationTurns.set' || path === 'nationTurns.edit' ? 105 : 0,
        residenceTick: 105,
        lastActiveAt: new Date(now - 1000),
      },
    });
  if (path.startsWith('nationTurns.')) {
    await db.nationOffice.create({ data: { worldId, nationId: 1, officerLevel: 11, tenure: 2, turnRevision: 4 } });
    await db.nationOfficeTurn.create({
      data: { worldId, nationId: 1, officerLevel: 11, slot: 0, commandKey: 'nation_rest', args: {} },
    });
  }
  const requestId = options.requestId ?? randomUUID();
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
          userId: users[owner]!,
          generalId: 1,
          kind: 'personnel.dismiss',
          idempotencyKey: `personnel:${requestId}`,
          payload: { generalId: 2 },
          createdAt: new Date(now),
        },
        {
          worldId,
          userId: users[owner]!,
          generalId: 1,
          kind: 'general.active',
          idempotencyKey: `general.active:personnel:${requestId}`,
          payload: {},
          createdAt: new Date(now),
        },
      ],
    });
  }
  return { worldId, requestId, offerId, owner };
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
async function readRows(worldId: string) {
  const where = { worldId };
  // 계정·세션도 비교하되 실패 출력에는 원문과 자격 증명을 남기지 않는다.
  return {
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
}
type Rows = Awaited<ReturnType<typeof readRows>>;
function hashes(rows: Rows) {
  return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, digest(value)]));
}
async function snapshot(worldId: string) {
  return hashes(await readRows(worldId));
}
const levels = [12, 11, 10, 9, 8, 7, 6, 5];
const restSlots = () => Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {}, name: '휴식' }));

function expectRead(path: Path, data: unknown, f: Fixture, rows: Rows, foreign = false) {
  const actor = rows.generals.find((general) => general.userId === users[foreign ? 1 : f.owner])!;
  if (path === 'personnel.officers') {
    const members = rows.generals
      .filter((general) => general.nationId === actor.nationId)
      .sort((a, b) => b.officerLevel - a.officerLevel || a.id - b.id);
    expect(data).toEqual({
      appoint: { ok: true },
      levels: levels.slice(1).map((officerLevel) => ({
        officerLevel,
        title: officerTitle(officerLevel),
        holderId: members.find((general) => general.officerLevel === officerLevel)?.id ?? null,
      })),
      members: members.map((general) => {
        const city = rows.cities.find((row) => row.cityKey === general.cityKey)!;
        return {
          generalId: general.id,
          name: general.name,
          officerLevel: general.officerLevel,
          title: officerTitle(general.officerLevel),
          isHuman: general.userId !== null,
          city: { cityKey: city.cityKey, name: city.name },
          dedication: general.dedication,
        };
      }),
    });
  } else if (path === 'personnel.request') {
    expect(data).toEqual({ kind: 'personnel.dismiss', state: { status: 'pending', requestId: f.requestId } });
  } else if (path === 'personnel.recent') {
    expect(data).toEqual(
      foreign ? [] : [{ kind: 'personnel.dismiss', state: { status: 'pending', requestId: f.requestId } }],
    );
  } else if (path === 'offers.mine') {
    expect(data).toEqual(
      rows.offers
        .filter((offer) => offer.targetGeneralId === actor.id)
        .map((offer) => {
          const issuer = rows.generals.find((general) => general.id === offer.issuerGeneralId)!;
          const city = rows.cities.find((row) => row.cityKey === offer.cityKey)!;
          return {
            id: offer.id,
            issuer: { generalId: issuer.id, name: issuer.name },
            targetCity: { cityKey: city.cityKey, name: city.name },
            expires: { ...toGameDate(rows.world.startYear, offer.expiresTick), monthsLeft: ASSIGNMENT_EXPIRY_MONTHS },
            rejectCost: {
              dedicationPercent: ASSIGNMENT_REJECT_PERCENT,
              dedication: assignmentRejectCost(actor.dedication),
            },
            respond: { ok: true },
          };
        }),
    );
  } else if (path === 'nationTurns.get') {
    expect(data).toEqual({
      tabs: levels.map((officerLevel) => {
        const office = rows.offices.find((row) => row.nationId === actor.nationId && row.officerLevel === officerLevel);
        const holder = rows.generals.find(
          (general) => general.nationId === actor.nationId && general.officerLevel === officerLevel,
        );
        return {
          office: { nationId: actor.nationId, officerLevel, tenure: office?.tenure ?? 0 },
          officerLevel,
          title: officerTitle(officerLevel),
          holder: holder ? { generalId: holder.id, name: holder.name } : null,
          edit:
            actor.officerLevel === officerLevel
              ? { ok: true }
              : { ok: false, reason: '자기 직책 칸만 고칠 수 있습니다.' },
          revision: office?.turnRevision ?? 0,
          slots: restSlots(),
        };
      }),
    });
  } else if (path === 'nationCommands.list') {
    // 명령 카탈로그의 자료형은 허용하되 응답 객체와 중첩 JSON schema에 DB 칸을 더할 수 없다.
    expect(data).toEqual(
      worldResolver(rows.world)
        .resolver.list('nation')
        .filter((def) => canExecuteNationCommand(actor.officerLevel, def.key))
        .map((def) => ({ key: def.key, name: def.name, argsSchema: def.args.toJSONSchema({ io: 'input' }) })),
    );
  } else if (path === 'nationCommands.precheck') {
    expect(data).toEqual({ ok: true });
  } else throw new Error(`조회 검증이 없는 경로: ${path}`);
}

async function expectWrite(path: Path, data: unknown, f: Fixture, before: Rows) {
  const after = await readRows(f.worldId);
  const events = after.inputs;
  const expected = structuredClone(before);
  if (path === 'personnel.appoint' || path === 'personnel.dismiss' || path === 'offers.respond') {
    expect(data).toEqual({ status: 'pending', requestId: f.requestId });
    expect(events).toHaveLength(2);
    const admission = events[0]!;
    const activity = events[1]!;
    expect(admission).toEqual({
      id: admission.id,
      worldId: f.worldId,
      createdAt: admission.createdAt,
      userId: users[f.owner],
      generalId: 1,
      kind: path === 'offers.respond' ? 'offer.respond' : path,
      status: 'PENDING',
      sequence: null,
      tick: null,
      stepTick: null,
      result: null,
      idempotencyKey: `personnel:${f.requestId}`,
      payload:
        path === 'personnel.appoint'
          ? { generalId: 2, officerLevel: 11 }
          : path === 'personnel.dismiss'
            ? { generalId: 2 }
            : { offerId: f.offerId, accept: true },
    });
    expect(activity).toEqual({
      id: activity.id,
      worldId: f.worldId,
      createdAt: activity.createdAt,
      userId: users[f.owner],
      generalId: 1,
      kind: 'general.active',
      status: 'PENDING',
      sequence: null,
      tick: null,
      stepTick: null,
      result: null,
      payload: {},
      idempotencyKey: `general.active:personnel:${f.requestId}`,
    });
    expected.inputs = events;
  } else {
    expect(data).toEqual({ ok: true, revision: 1, slots: restSlots() });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.idempotencyKey).toMatch(/^nationTurns\.set:[0-9a-f-]{36}$/);
    expect(event).toEqual({
      id: event.id,
      worldId: f.worldId,
      userId: users[f.owner],
      generalId: 1,
      kind: 'nationTurns.set',
      idempotencyKey: event.idempotencyKey,
      status: 'APPLIED',
      sequence: 1,
      tick: 100,
      stepTick: null,
      payload: {
        office: { nationId: 1, officerLevel: 12, tenure: 0 },
        revision: 0,
        turns: restSlots().map(({ commandKey, args }) => ({ commandKey, args })),
      },
      result: { revision: 1, activeTick: 100 },
      createdAt: event.createdAt,
    });
    // 허용된 칸만 기대 상태에 반영한다. 나머지 World/General 칸과 다른 장수도 전부 비교한다.
    expected.world.actionSequence = 1;
    const actor = expected.generals.find((general) => general.id === 1)!;
    actor.lastActiveTick = 105;
    actor.lastActiveAt = event.createdAt;
    // digest는 JSON 키 순서도 읽으므로 Prisma 반환 열 순서를 따른다. 비교하는 칸과 값은 그대로다.
    expected.offices.push({ worldId: f.worldId, nationId: 1, officerLevel: 12, turnRevision: 1, tenure: 0 });
    expected.offices.sort((a, b) => a.nationId - b.nationId || a.officerLevel - b.officerLevel);
    expected.officeTurns.push(
      ...restSlots().map(({ commandKey, args }, slot) => ({
        worldId: f.worldId,
        nationId: 1,
        officerLevel: 12,
        slot,
        commandKey,
        args,
      })),
    );
    expected.officeTurns.sort((a, b) => a.nationId - b.nationId || a.officerLevel - b.officerLevel || a.slot - b.slot);
    expected.inputs.push(event);
  }
  expect(hashes(after)).toEqual(hashes(expected));
}

async function expectNoWriteRejection(
  path: Path,
  data: Record<string, unknown>,
  f: Fixture,
  code: string,
  status: number,
  cookie = cookies[0],
) {
  const before = await snapshot(f.worldId);
  const result = await request(path, data, cookie);
  expect(result.code).toBe(code);
  expect(result.status).toBe(status);
  expect(await snapshot(f.worldId)).toEqual(before);
}

async function expectRetryBoundary(path: Path, f: Fixture, first: unknown) {
  const before = await snapshot(f.worldId);
  const retry = await request(path, input(path, f), cookies[0]);
  expect(retry.code).toBeUndefined();
  expect(retry.status).toBe(200);
  if (path === 'nationTurns.set' || path === 'nationTurns.edit') {
    expect(retry.data).toEqual({ ok: false, reason: 'STALE', revision: 1, slots: restSlots() });
  } else {
    expect(retry.data).toEqual(first);
    const changed =
      path === 'personnel.appoint'
        ? { officerLevel: 10 }
        : path === 'personnel.dismiss'
          ? { generalId: 4 }
          : { accept: false };
    await expectNoWriteRejection(path, { ...input(path, f), ...changed }, f, 'CONFLICT', 409);
    const otherKind = path === 'personnel.dismiss' ? 'personnel.appoint' : 'personnel.dismiss';
    await expectNoWriteRejection(otherKind, input(otherKind, f), f, 'CONFLICT', 409);
    await expectNoWriteRejection(path, { ...input(path, f), requestId: randomUUID() }, f, 'CONFLICT', 409);
  }
  expect(await snapshot(f.worldId)).toEqual(before);
}

async function expectCrossWorld(path: Path, f: Fixture) {
  // 같은 요청·제안·직책 번호를 다른 소유자의 월드에도 두어 월드와 세션을 함께 대조한다.
  const other = await fixture(path, { owner: 3, requestId: f.requestId });
  const before = [await snapshot(f.worldId), await snapshot(other.worldId)];
  for (const [target, source, cookie] of [
    [other, f, cookies[0]],
    [f, other, cookies[3]],
  ] as const) {
    const result = await request(path, { ...input(path, source), worldId: target.worldId }, cookie);
    if (path === 'personnel.recent') {
      expect(result.status).toBe(200);
      expect(result.code).toBeUndefined();
      expect(result.data).toEqual([]);
    } else {
      expect(result.status).toBe(404);
      expect(result.code).toBe('NOT_FOUND');
    }
  }
  expect([await snapshot(f.worldId), await snapshot(other.worldId)]).toEqual(before);
}

async function expectLowerRole(path: Path, f: Fixture) {
  if (
    ![
      'personnel.appoint',
      'personnel.dismiss',
      'nationTurns.get',
      'nationTurns.set',
      'nationTurns.edit',
      'nationCommands.list',
      'nationCommands.precheck',
    ].includes(path)
  )
    return;
  for (const nationId of [1, null]) {
    await db.general.update({
      where: { worldId_id: { worldId: f.worldId, id: 3 } },
      data: { nationId, officerLevel: nationId === null ? 0 : 1 },
    });
    await expectNoWriteRejection(path, input(path, f), f, 'FORBIDDEN', 403, cookies[1]);
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
          const beforeRows = await readRows(f.worldId);
          const before = hashes(beforeRows);
          const result = await request(path, data, cookie);
          if (category === 'success') {
            expect(result.status).toBe(200);
            expect(result.code).toBeUndefined();
            if (isMutation(path)) {
              await expectWrite(path, result.data, f, beforeRows);
              await expectRetryBoundary(path, f, result.data);
            } else {
              expectRead(path, result.data, f, beforeRows);
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
              expectRead(path, result.data, f, beforeRows, true);
            }
            expect(await snapshot(f.worldId)).toEqual(before);
            await expectCrossWorld(path, f);
            await expectLowerRole(path, f);
          } else {
            expect(result.code).toBe(category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED');
            expect(result.status).toBe(category === 'invalidInput' ? 400 : 401);
            expect(await snapshot(f.worldId)).toEqual(before);
          }
        }),
      );
    }
});

describe('B7 기존 대기 활동과 새 인사 접수의 실제 DB 회귀', () => {
  it.each(['personnel.appoint', 'personnel.dismiss', 'offers.respond'] as const)(
    '%s는 기존 활동을 보존해 접수하고 엔진에서 잠근 tick으로 처리한다',
    async (path) => {
      const f = await fixture(path);
      await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { lastActiveTick: 105 } });
      const existing = await db.inputEvent.create({
        data: {
          worldId: f.worldId,
          userId: users[0]!,
          generalId: 1,
          kind: 'general.active',
          idempotencyKey: `general.active:${randomUUID()}`,
          payload: {},
          createdAt: new Date(now - 2000),
        },
      });
      const before = await readRows(f.worldId);
      const kind = path === 'offers.respond' ? 'offer.respond' : path;
      const { worldId, requestId, ...payload } = input(path, f);
      // 합쳐진 활동도 접수와 같은 트랜잭션에 속하며, 뒤의 오류는 새 접수만 전부 취소한다.
      await expect(
        db.$transaction(async (tx) => {
          expect(
            await submitPersonnelRequest(tx, {
              worldId: f.worldId,
              requestId: f.requestId,
              kind,
              payload,
              userId: users[0]!,
              sessionId: before.sessions.find((session) => session.userId === users[0])!.id,
              at: new Date(now),
            }),
          ).toEqual({ created: true });
          throw new Error('coalesced admission rollback');
        }),
      ).rejects.toThrow('coalesced admission rollback');
      expect(await snapshot(f.worldId)).toEqual(hashes(before));
      expect({ worldId, requestId }).toEqual({ worldId: f.worldId, requestId: f.requestId });

      // 엔진을 아직 돌리지 않은 상태에서 정확히 같은 UUID의 두 HTTP 요청을 보낸다.
      const replies = await Promise.all([
        request(path, input(path, f), cookies[0]),
        request(path, input(path, f), cookies[0]),
      ]);
      for (const reply of replies)
        expect(reply).toEqual({ status: 200, code: undefined, data: { status: 'pending', requestId: f.requestId } });
      const queued = await readRows(f.worldId);
      expect(queued.inputs).toHaveLength(2);
      expect(queued.inputs[0]).toEqual(existing);
      const admission = queued.inputs[1]!;
      expect(admission).toEqual({
        id: admission.id,
        worldId: f.worldId,
        userId: users[0],
        generalId: 1,
        kind,
        idempotencyKey: `personnel:${f.requestId}`,
        payload,
        status: 'PENDING',
        sequence: null,
        stepTick: null,
        tick: null,
        result: null,
        createdAt: admission.createdAt,
      });
      const expectedQueued = structuredClone(before);
      expectedQueued.inputs.push(admission);
      expect(hashes(queued)).toEqual(hashes(expectedQueued));

      const lease = await acquireLease(db, f.worldId);
      if (!lease) throw new Error('인사 회귀 시험 실행권이 없습니다.');
      try {
        expect(await new TurnLoop(db, lease).advanceTo(100)).toEqual([]);
        const applied = await readRows(f.worldId);
        expect(applied.inputs).toHaveLength(2);
        expect(applied.inputs[0]).toEqual({
          ...existing,
          status: 'APPLIED',
          sequence: 1,
          tick: 100,
          result: { activeTick: 100 },
        });
        const destination = before.cities.find((city) => city.cityKey === before.offers[0]?.cityKey);
        const result =
          path === 'offers.respond'
            ? {
                offerStatus: 'ACCEPTED',
                city: { cityKey: destination!.cityKey, name: destination!.name },
                dedicationLost: 0,
              }
            : {
                generalId: 2,
                officerLevel: path === 'personnel.appoint' ? 11 : 1,
                title: path === 'personnel.appoint' ? '참모' : '장수',
              };
        expect(applied.inputs[1]).toEqual({ ...admission, status: 'APPLIED', sequence: 2, tick: 100, result });
        const expectedGenerals = structuredClone(before.generals);
        const actor = expectedGenerals.find((general) => general.id === 1)!;
        actor.lastActiveTick = 105;
        actor.lastActiveAt = existing.createdAt;
        if (path === 'offers.respond') {
          actor.cityKey = destination!.cityKey;
          actor.residenceTick = 100;
          expect(applied.offers).toEqual([
            { ...before.offers[0]!, status: 'ACCEPTED', resolvedBy: 'RESPONSE', resolvedTick: 100 },
          ]);
        } else
          expectedGenerals.find((general) => general.id === 2)!.officerLevel = path === 'personnel.appoint' ? 11 : 1;
        expect(digest(applied.generals)).toBe(digest(expectedGenerals));
        expect(applied.world).toMatchObject({ clockTick: 100, actionSequence: 2 });
        expect(applied.generalTurns).toEqual(before.generalTurns);
        expect(applied.cities).toEqual(before.cities);
        expect(applied.nations).toEqual(before.nations);
        expect(applied.accounts.map(digest)).toEqual(before.accounts.map(digest));
        expect(applied.sessions.map(digest)).toEqual(before.sessions.map(digest));
        const after = await snapshot(f.worldId);
        expect(await request(path, input(path, f), cookies[0])).toEqual({
          status: 200,
          code: undefined,
          data: { status: 'applied', requestId: f.requestId, result },
        });
        expect(await snapshot(f.worldId)).toEqual(after);
      } finally {
        await releaseLease(db, lease);
      }
    },
  );
});
