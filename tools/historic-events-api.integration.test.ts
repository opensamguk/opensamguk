import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { testDatabaseUrl } from './test-database';

const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
const now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
const userId = randomUUID();
const session = newSession(now);
const path = 'historicEvents.list';
let worldId: string;

beforeAll(async () => {
  await db.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'test-only' } });
  await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
  ({ worldId } = await saveInitialWorld(db, await monthlyFixture(), {
    replayFormat: 3,
    name: '역사 사건 조회',
    turnTermMinutes: 60,
    endYear: null,
  }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.sanction.deleteMany({ where: { userId } });
  if (worldId) await db.world.delete({ where: { id: worldId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

function list(input: unknown, cookie = `sid=${session.token}`, server = app) {
  return server.inject({
    method: 'GET',
    url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    headers: { origin: 'http://127.0.0.1:5173', ...(cookie ? { cookie } : {}) },
  });
}

it(
  'AC-P2-21 사건 기능을 끈 월드는 빈 응답을 보낸다',
  authzCase(path, 'success', async () => {
    const response = await list({ worldId });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data).toEqual({ enabled: false, mine: [], done: [] });
  }),
);

it(
  'AC-P2-21 세션이 없는 조회를 거부한다',
  authzCase(path, 'unauthenticated', async () => {
    const response = await list({ worldId }, '');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.data.code).toBe('UNAUTHORIZED');
  }),
);

it(
  'AC-P2-21 조회 국가를 입력으로 바꿀 수 없다',
  authzCase(path, 'otherUser', async () => {
    const response = await list({ worldId, nationId: 1, generalId: 1 });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.data.code).toBe('BAD_REQUEST');
  }),
);

it(
  'AC-P2-21 월드 번호가 없으면 조회를 거부한다',
  authzCase(path, 'invalidInput', async () => {
    const response = await list({ worldId: '' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.data.code).toBe('BAD_REQUEST');
  }),
);

it(
  'AC-P2-21 월드 이용이 제한된 계정의 조회를 거부한다',
  authzCase(path, 'sanctioned', async () => {
    const sanction = await db.sanction.create({ data: { userId, worldId, reason: '시험', createdBy: userId } });
    try {
      const response = await list({ worldId });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.data.code).toBe('FORBIDDEN');
    } finally {
      await db.sanction.delete({ where: { id: sanction.id } });
    }
  }),
);

it('AC-P2-21 인증 뒤 폐기된 세션은 조회 트랜잭션에서 거부한다', async () => {
  const revoked = newSession(now);
  await db.session.create({ data: { id: revoked.id, userId, expiresAt: revoked.expiresAt } });
  let revokedAfterAuth = false;
  const observed = db.$extends({
    query: {
      sanction: {
        async findFirst({ args, query }) {
          const result = await query(args);
          if (args.where?.worldId === worldId && args.where?.userId === userId) {
            await db.session.delete({ where: { id: revoked.id } });
            revokedAfterAuth = true;
          }
          return result;
        },
      },
    },
  });
  // Prisma 확장은 실제 질의와 트랜잭션을 쓰지만 클라이언트 전체 타입은 노출하지 않는다.
  const server = await buildServer({ db: observed as unknown as typeof db, now: () => now, logging: false });
  try {
    const response = await list({ worldId }, `sid=${revoked.token}`, server);
    expect(revokedAfterAuth).toBe(true);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.data.code).toBe('UNAUTHORIZED');
  } finally {
    await server.close();
  }
});
