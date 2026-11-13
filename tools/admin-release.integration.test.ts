import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const db = createDb(url.href);
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, publicOrigin: origin, logging: false });
const expectedRevision = 'a'.repeat(40);
const targetRevision = 'b'.repeat(40);
const manifestSha256 = 'c'.repeat(64);
const ids: string[] = [];
const requested: string[] = [];
let address: string;
let admin: Awaited<ReturnType<typeof user>>;
let ordinary: Awaited<ReturnType<typeof user>>;
let sanctioned: Awaited<ReturnType<typeof user>>;

async function user(role: 'ADMIN' | 'USER', status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE') {
  const record = await db.user.create({
    data: { email: randomUUID() + '@example.test', role, status, passwordHash: 'unused' },
  });
  ids.push(record.id);
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: record.id, expiresAt: session.expiresAt } });
  return { id: record.id, cookie: 'sid=' + session.token };
}
function requestInput(expectedUserId: string) {
  const id = randomUUID();
  requested.push(id);
  return {
    id,
    expectedUserId,
    operation: 'DEPLOY' as const,
    expectedRevision,
    targetRevision,
    manifestSha256,
    reason: '릴리스 검증',
  };
}
async function call(path: string, input: unknown, cookie?: string) {
  const mutation = path === 'admin.release.request';
  const encoded = JSON.stringify(input);
  const url = address + '/trpc/' + path + (mutation ? '' : '?input=' + encodeURIComponent(encoded));
  const response = await fetch(url, {
    method: mutation ? 'POST' : 'GET',
    headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
    ...(mutation ? { body: encoded } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { result?: { data: unknown }; error?: { data: { code: string } } };
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
async function publish(seenAt = new Date()) {
  const row = {
    currentRevision: expectedRevision,
    candidates: [{ revision: targetRevision, manifestSha256, operation: 'DEPLOY' }],
    seenAt,
  };
  await db.releaseControl.upsert({ where: { id: 'production' }, create: { id: 'production', ...row }, update: row });
}

beforeAll(async () => {
  admin = await user('ADMIN');
  ordinary = await user('USER');
  sanctioned = await user('ADMIN', 'SANCTIONED');
  await publish();
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app.close();
    await db.releaseRequest.deleteMany({ where: { id: { in: requested } } });
    await db.releaseControl.deleteMany({ where: { id: 'production', currentRevision: expectedRevision } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
});

for (const path of ['admin.release.status', 'admin.release.request']) {
  for (const category of categories) {
    it(
      path + ' ' + category,
      authzCase(path, category, async () => {
        const actor = category === 'otherUser' ? ordinary : category === 'sanctioned' ? sanctioned : admin;
        const input =
          category === 'invalidInput'
            ? { path: 'C:/Windows/System32' }
            : path === 'admin.release.request'
              ? requestInput(actor.id)
              : { expectedUserId: actor.id };
        const expected = { success: 200, unauthenticated: 401, otherUser: 403, sanctioned: 401, invalidInput: 400 }[
          category
        ];
        const result = await call(path, input, category === 'unauthenticated' ? undefined : actor.cookie);
        expect(result.status).toBe(expected);
        if (category === 'success' && 'id' in input) {
          expect(await db.auditLog.count({ where: { targetId: input.id, action: 'release.request' } })).toBe(1);
          await db.releaseRequest.delete({ where: { id: input.id! } });
        }
      }),
    );
  }
}

it('AC-M2-08 승인된 버전만 접수하고 중복 요청과 현재 버전 변경을 구분한다', async () => {
  await publish();
  const first = requestInput(admin.id);
  const second = requestInput(admin.id);
  expect(await call('admin.release.status', { expectedUserId: ordinary.id }, admin.cookie)).toMatchObject({
    status: 401,
  });
  expect(await call('admin.release.request', { ...first, operation: 'ROLLBACK' }, admin.cookie)).toMatchObject({
    status: 409,
  });
  expect(await call('admin.release.request', { ...first, manifestSha256: 'd'.repeat(64) }, admin.cookie)).toMatchObject(
    { status: 409 },
  );
  const pair = await Promise.all([first, second].map((input) => call('admin.release.request', input, admin.cookie)));
  expect(pair.map((result) => result.status).sort()).toEqual([200, 409]);
  const winner = pair[0]?.status === 200 ? first : second;
  expect(await call('admin.release.request', winner, admin.cookie)).toMatchObject({
    status: 200,
    data: { id: winner.id, status: 'QUEUED' },
  });
  expect(await call('admin.release.request', { ...winner, reason: '다른 작업' }, admin.cookie)).toMatchObject({
    status: 409,
  });
  expect(await db.auditLog.count({ where: { targetId: winner.id, action: 'release.request' } })).toBe(1);
  await publish(new Date(Date.now() - 31_000));
  expect(await call('admin.release.status', { expectedUserId: admin.id }, admin.cookie)).toMatchObject({
    status: 200,
    data: { control: null },
  });
  expect(await call('admin.release.request', requestInput(admin.id), admin.cookie)).toMatchObject({ status: 412 });
});
