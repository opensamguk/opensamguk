import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { RELATIONS_FEATURE, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { createWorldFromCli } from '../apps/engine/src/admin/creation';
import { composeInitialWorld, readInitialResources } from '../apps/engine/src/world/resources';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { buildServer } from '../apps/server/src/server';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw new Error('loopback 시험 서버가 필요합니다.');
const db = createDb(url.href);
const now = Date.now();
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, now: () => now, publicOrigin: origin, logging: false });
const path = 'relations.list';
const worldIds: string[] = [];
const userIds: string[] = [];
let base: string;
let worldId: string;
let offWorldId: string;
let owner: string;
let observer: string;
let restricted: string;
let year: number;
let nationCount: number;

async function createSession() {
  const id = randomUUID();
  const session = newSession(now);
  await db.user.create({
    data: { id, email: `${id}@example.test`, passwordHash: 'not-a-login-hash' },
  });
  userIds.push(id);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, cookie: `sid=${session.token}` };
}

async function request(input: unknown, cookie?: string) {
  const response = await fetch(`${base}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, {
    headers: { origin, ...(cookie ? { cookie } : {}) },
  });
  const body = (await response.json()) as { result?: { data: unknown }; error?: { data: { code: string } } };
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}

beforeAll(async () => {
  const resources = await readInitialResources(db, { scenario: '1030', map: 'che' });
  const initial = composeInitialWorld(resources, 'relations-list-1030');
  year = initial.startYear;
  nationCount = initial.nations.length;
  const options = { name: '관계 조회 검증', turnTermMinutes: 60, endYear: null, replayFormat: 3 } as const;
  ({ worldId } = await createWorldFromCli(db, initial, { ...options, ruleFeatures: [RELATIONS_FEATURE] }, resources));
  worldIds.push(worldId);
  ({ worldId: offWorldId } = await createWorldFromCli(db, initial, options, resources));
  worldIds.push(offWorldId);

  const player = await createSession();
  owner = player.cookie;
  observer = (await createSession()).cookie;
  const sanctioned = await createSession();
  restricted = sanctioned.cookie;
  await db.general.update({
    where: { worldId_id: { worldId, id: 281 } },
    data: { userId: player.id, activeFromYear: year },
  });
  await db.general.update({
    where: { worldId_id: { worldId, id: 370 } },
    data: { activeFromYear: year + 1 },
  });
  await db.sanction.create({
    data: { userId: sanctioned.id, worldId, reason: '관계 조회 제재', createdBy: player.id },
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.sanction.deleteMany({ where: { worldId: { in: worldIds } } });
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

const sworn = { a: { id: 47, name: '관우' }, b: { id: 281, name: '유비' }, kind: 'sworn' };
const future = { a: { id: 281, name: '유비' }, b: { id: 370, name: '제갈량' }, kind: 'lord' };

it(
  'AC-P2-20 관계를 켠 월드는 등장한 장수의 관계 종류만 반환하고 끈 월드는 빈 결과를 반환한다',
  authzCase(path, 'success', async () => {
    const result = await request({ worldId }, owner);
    expect(result).toMatchObject({ status: 200, data: { enabled: true } });
    const { items } = result.data as { items: unknown[] };
    expect(items).toContainEqual(sworn);
    expect(items).not.toContainEqual(future);
    expect(JSON.stringify(items)).not.toContain('제갈량');
    expect(await request({ worldId: offWorldId }, owner)).toMatchObject({
      status: 200,
      data: { enabled: false, items: [] },
    });
  }),
);
it(
  'AC-P2-20 월드에 장수가 없는 다른 정상 계정도 같은 공개 관계를 읽는다',
  authzCase(path, 'otherUser', async () => {
    expect(await request({ worldId }, observer)).toEqual(await request({ worldId }, owner));
  }),
);
it(
  'AC-P2-20 세션 없는 관계 조회를 거부한다',
  authzCase(path, 'unauthenticated', async () => {
    expect(await request({ worldId })).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  }),
);
it(
  'AC-P2-20 월드 제재 계정의 관계 조회를 거부한다',
  authzCase(path, 'sanctioned', async () => {
    expect(await request({ worldId }, restricted)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await request({ worldId: offWorldId }, restricted)).status).toBe(200);
  }),
);
it(
  'AC-P2-20 잘못된 월드 ID와 추가 입력을 거부한다',
  authzCase(path, 'invalidInput', async () => {
    expect(await request({ worldId: 'invalid' }, owner)).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    expect(await request({ worldId, nationId: 1 }, owner)).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
  }),
);

it('AC-P2-20 같은 연도 경계에서 진행 월드는 새 관계를 표시하고 직전 연도에 종료한 월드는 가린다', async () => {
  const boundary = 12 * TICKS_PER_MONTH;
  await db.world.update({ where: { id: worldId }, data: { monthlyTick: boundary, status: 'RUNNING' } });
  const running = await request({ worldId }, owner);
  expect(running).toMatchObject({ status: 200, data: { enabled: true } });
  expect((running.data as { items: unknown[] }).items).toContainEqual(future);

  await db.general.update({
    where: { worldId_id: { worldId, id: 47 } },
    data: { removedAt: boundary },
  });
  await db.$transaction([
    db.world.update({ where: { id: worldId }, data: { status: 'ENDED' } }),
    db.worldResult.create({
      data: {
        worldId,
        reason: 'END_YEAR',
        endedYear: year,
        endedMonth: 12,
        endedTick: boundary,
        endedSequence: 1,
        remainingNations: nationCount,
        finalStateHash: 'relations-list-boundary',
        endedAt: new Date(now),
      },
    }),
  ]);
  const ended = await request({ worldId }, owner);
  expect(ended).toMatchObject({ status: 200, data: { enabled: true } });
  const { items } = ended.data as { items: unknown[] };
  expect(items.length).toBeGreaterThan(0);
  expect(JSON.stringify(items)).not.toMatch(/관우|제갈량/);
});
