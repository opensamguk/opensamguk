// 리뷰 전용 탐침 (T1-20 독립 리뷰, 병합 대상 아님). 실제 TCP 소켓과 PostgreSQL로 world.list를 확인한다.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { buildServer } from '../server';
import { hashPassword } from '../auth/password';
import { newSession } from '../auth/session';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = Date.now();
const secretSeed = `probe-secret-seed-${randomBytes(6).toString('hex')}`;
const secretHash = `probe-secret-hash-${randomBytes(6).toString('hex')}`;
const app = await buildServer({ db, logging: false });
let address = '';
let a: { id: string; email: string; cookie: string };
let b: { id: string; email: string; cookie: string };
const ids: Record<string, string> = {};

async function mkUser(email: string, passwordHash: string) {
  const session = newSession(now);
  const user = await db.user.create({
    data: { email, passwordHash, sessions: { create: { id: session.id, expiresAt: session.expiresAt } } },
  });
  return { id: user.id, email, cookie: `sid=${session.token}` };
}

async function mkWorld(status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED', createdAt: string, name: string) {
  const world = await db.world.create({
    data: {
      id: randomUUID(),
      name,
      scenarioKey: 'probe_scenario_key',
      mapKey: 'probe_map_key',
      unitSetKey: 'probe_unit_key',
      seed: secretSeed,
      startYear: 191,
      turnTermMinutes: 7,
      status,
      initialStateHash: secretHash,
      statRules: { probeStatRule: 1 },
      unitSet: { probeUnit: 1 },
      createdAt: new Date(createdAt),
    },
  });
  ids[name] = world.id;
}

async function get(path: string, cookie?: string) {
  const response = await fetch(address + path, { headers: cookie ? { cookie } : {} });
  return { status: response.status, text: await response.text(), setCookie: response.headers.get('set-cookie') };
}

beforeAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany();
  const passwordHash = await hashPassword(randomBytes(24).toString('base64url'));
  a = await mkUser('probe-a@example.com', passwordHash);
  b = await mkUser('probe-b@example.com', passwordHash);
  await mkWorld('RUNNING', '2026-03-01T00:00:00Z', 'third');
  await mkWorld('PAUSED', '2025-01-01T00:00:00Z', 'paused-world');
  await mkWorld('RUNNING', '2026-01-01T00:00:00Z', 'first');
  await mkWorld('PREOPEN', '2025-01-01T00:00:00Z', 'preopen-world');
  await mkWorld('ENDED', '2025-01-01T00:00:00Z', 'ended-world');
  await mkWorld('RUNNING', '2026-02-01T00:00:00Z', 'second');
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany();
  await db.user.deleteMany();
  await db.$disconnect();
});

describe('T1-20 리뷰 탐침: 실제 소켓 HTTP', () => {
  it('RUNNING만 만든 순서로, 공개 필드만 준다', async () => {
    const r = await get('/trpc/world.list', a.cookie);
    expect(r.status).toBe(200);
    const worlds = (JSON.parse(r.text) as { result: { data: { worlds: Array<Record<string, string>> } } }).result.data
      .worlds;
    expect(worlds.map((w) => w.id)).toEqual([ids.first, ids.second, ids.third]);
    for (const w of worlds) {
      expect(Object.keys(w).sort()).toEqual(['id', 'name', 'status']);
      expect(w.status).toBe('RUNNING');
    }
    const forbidden = [
      secretSeed,
      secretHash,
      'probe_scenario_key',
      'probe_map_key',
      'probe_unit_key',
      'probeStatRule',
      'probeUnit',
      'createdAt',
      'clockTick',
      a.email,
      a.id,
      'passwordHash',
      'paused-world',
      'preopen-world',
      'ended-world',
    ];
    for (const s of forbidden) expect(r.text).not.toContain(s);
    console.log(`[probe] body ${r.text}`);

    const other = await get('/trpc/world.list?batch=1', b.cookie);
    expect((JSON.parse(other.text) as Array<{ result: { data: { worlds: unknown } } }>)[0]!.result.data.worlds).toEqual(
      worlds,
    );
  });

  it('무인증·위조 쿠키는 401이고 목록과 세션 쿠키가 없다', async () => {
    for (const cookie of [undefined, 'sid=xyz', `sid=${randomBytes(32).toString('base64url')}`]) {
      const r = await get('/trpc/world.list', cookie);
      expect(r.status).toBe(401);
      expect(r.text).toContain('UNAUTHORIZED');
      expect(r.text).not.toContain('"worlds"');
      expect(r.setCookie).toBeNull();
    }
  });

  it('입력값과 잘못된 메서드는 거부한다', async () => {
    for (const input of [{ userId: 'x' }, { status: 'PAUSED' }, {}]) {
      const r = await get(`/trpc/world.list?input=${encodeURIComponent(JSON.stringify(input))}`, a.cookie);
      expect(r.status).toBe(400);
      expect(r.text).toContain('BAD_REQUEST');
      expect(r.text).not.toContain('"worlds"');
    }
    const post = await fetch(`${address}/trpc/world.list`, {
      method: 'POST',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    const text = await post.text();
    console.log(`[probe] POST status ${post.status}`);
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toContain('"worlds"');
  });

  it('제재·탈퇴·만료 세션은 401이다', async () => {
    try {
      for (const status of ['SANCTIONED', 'WITHDRAWN'] as const) {
        await db.user.update({ where: { id: b.id }, data: { status } });
        const r = await get('/trpc/world.list', b.cookie);
        expect(r.status).toBe(401);
        expect(r.text).not.toContain('"worlds"');
      }
    } finally {
      await db.user.update({ where: { id: b.id }, data: { status: 'ACTIVE' } });
    }
    const expired = newSession(now);
    await db.session.create({ data: { id: expired.id, userId: a.id, expiresAt: new Date(now - 1000) } });
    expect((await get('/trpc/world.list', `sid=${expired.token}`)).status).toBe(401);
  });

  it('RUNNING이 없으면 빈 목록이다', async () => {
    await db.world.updateMany({ data: { status: 'PAUSED' } });
    const r = await get('/trpc/world.list', a.cookie);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ result: { data: { worlds: [] } } });
  });
});
