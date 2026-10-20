import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { buildServer } from '../server';
import { hashPassword } from '../auth/password';
import { hashToken, newSession } from '../auth/session';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_000;
const app = await buildServer({ db, now: () => now, logging: false });
let alice: { id: string; cookie: string };
let bob: { id: string; cookie: string };

async function createUser(email: string, passwordHash: string) {
  const session = newSession(now);
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  return { id: user.id, cookie: `sid=${session.token}` };
}

async function createWorld(status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED', createdAt: Date, id = randomUUID()) {
  return db.world.create({
    data: {
      id,
      name: `월드 ${status}`,
      scenarioKey: 'scenario_191',
      mapKey: 'map_che',
      unitSetKey: 'default',
      seed: 'world-list-test',
      startYear: 191,
      turnTermMinutes: 1,
      status,
      initialStateHash: 'world-list-test',
      statRules: {},
      unitSet: {},
      createdAt,
    },
    select: { id: true, name: true, status: true },
  });
}

async function list(cookie?: string, input?: unknown) {
  const query = input === undefined ? '' : `&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`;
  const response = await app.inject({
    method: 'GET',
    url: `/trpc/world.list?batch=1${query}`,
    headers: cookie ? { cookie } : {},
  });
  const body = response.json()[0] as {
    result?: { data: { worlds: Array<{ id: string; name: string; status: string }> } };
    error?: { data: { code: string } };
  };
  return { response, body };
}

beforeAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  const passwordHash = await hashPassword(randomBytes(24).toString('base64url'));
  alice = await createUser('world-alice@example.com', passwordHash);
  bob = await createUser('world-bob@example.com', passwordHash);
  await app.ready();
});
beforeEach(async () => {
  await db.world.deleteMany();
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany();
  await db.user.deleteMany();
  await db.$disconnect();
});

describe('T1-20 / AC-M1-05 world.list 실제 HTTP·DB', () => {
  it('RUNNING만 만든 순서로 반환하고 같은 시각이면 ID로 정렬한다', async () => {
    const early = new Date('2026-01-01T00:00:00Z');
    const late = new Date('2026-01-02T00:00:00Z');
    const last = await createWorld('RUNNING', late);
    await createWorld('PREOPEN', early);
    const second = await createWorld('RUNNING', early, '00000000-0000-4000-8000-000000000002');
    const first = await createWorld('RUNNING', early, '00000000-0000-4000-8000-000000000001');
    await createWorld('PAUSED', early);
    await createWorld('ENDED', early);

    const result = await list(alice.cookie);
    expect(result.response.statusCode).toBe(200);
    expect(result.body.result?.data).toEqual({ worlds: [first, second, last] });
    expect(Object.keys(result.body.result!.data.worlds[0]!).sort()).toEqual(['id', 'name', 'status']);
  });

  it('월드가 없거나 RUNNING이 없으면 빈 목록을 반환한다', async () => {
    expect((await list(alice.cookie)).body.result?.data).toEqual({ worlds: [] });
    for (const status of ['PREOPEN', 'PAUSED', 'ENDED'] as const) await createWorld(status, new Date(now));
    expect((await list(alice.cookie)).body.result?.data).toEqual({ worlds: [] });
  });

  it('무인증·위조 세션은 목록을 볼 수 없다', async () => {
    await createWorld('RUNNING', new Date(now));
    for (const cookie of [undefined, 'sid=invalid', `sid=${randomBytes(32).toString('base64url')}`]) {
      const result = await list(cookie);
      expect(result.response.statusCode).toBe(401);
      expect(result.body.error?.data.code).toBe('UNAUTHORIZED');
      expect(result.body.result).toBeUndefined();
    }
  });

  it('활성 계정 둘은 같은 공개 월드 목록을 본다', async () => {
    const world = await createWorld('RUNNING', new Date(now));
    for (const user of [alice, bob]) {
      expect((await list(user.cookie)).body.result?.data).toEqual({ worlds: [world] });
    }
  });

  it('입력값과 클라이언트가 지정한 사용자는 받지 않는다', async () => {
    for (const input of [{}, { userId: bob.id }, { status: 'PAUSED' }, null, [], 'RUNNING', 1]) {
      const result = await list(alice.cookie, input);
      expect(result.response.statusCode).toBe(400);
      expect(result.body.error?.data.code).toBe('BAD_REQUEST');
      expect(result.body.result).toBeUndefined();
    }
  });

  it('만료 세션과 로그아웃한 세션은 거부한다', async () => {
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: alice.id, expiresAt: new Date(now) } });
    expect((await list(`sid=${session.token}`)).body.error?.data.code).toBe('UNAUTHORIZED');
    await db.session.update({ where: { id: session.id }, data: { expiresAt: new Date(now + 60_000) } });
    expect((await list(`sid=${session.token}`)).response.statusCode).toBe(200);
    const logout = await app.inject({
      method: 'POST',
      url: '/trpc/auth.logout?batch=1',
      headers: { cookie: `sid=${session.token}` },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect((await list(`sid=${session.token}`)).body.error?.data.code).toBe('UNAUTHORIZED');
    expect(await db.session.findUnique({ where: { id: hashToken(session.token) } })).toBeNull();
  });

  it('제재·탈퇴 계정은 기존 세션으로도 목록을 볼 수 없다', async () => {
    await createWorld('RUNNING', new Date(now));
    try {
      for (const status of ['SANCTIONED', 'WITHDRAWN'] as const) {
        await db.user.update({ where: { id: bob.id }, data: { status } });
        const result = await list(bob.cookie);
        expect(result.response.statusCode).toBe(401);
        expect(result.body.error?.data.code).toBe('UNAUTHORIZED');
        expect(result.body.result).toBeUndefined();
      }
    } finally {
      await db.user.update({ where: { id: bob.id }, data: { status: 'ACTIVE' } });
    }
  });
});
