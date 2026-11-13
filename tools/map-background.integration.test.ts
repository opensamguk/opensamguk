import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { registerMapBackground, readMapBackgrounds } from '../apps/server/src/resourceAdmin/mapBackground';
import { hashState } from '../packages/shared/src/node/hashState';
import { confirmDisconnectedDatabase } from './test-db-close';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('전용 시험 DB가 필요합니다.');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw Error('자기 loopback 시험 DB가 필요합니다.');
const name = 'map_background_' + randomUUID().replaceAll('-', '') + '_test';
const target = new URL(url),
  adminUrl = new URL(url);
target.pathname = '/' + name;
adminUrl.pathname = '/postgres';
type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
const admin = new Client({ connectionString: adminUrl.href }),
  gate = new Client({ connectionString: target.href });
const db = createDb(target.href),
  epoch = Date.now();
let now = epoch,
  address: string,
  cookie: string;
let oid: string | undefined,
  ready = false,
  failed = false;
const app = await buildServer({ db, now: () => now, logging: false });
const userId = randomUUID();
const prefix = 'bg_' + randomUUID().replaceAll('-', '').slice(0, 20);
const image = { sha256: 'a'.repeat(64), bytes: 100, width: 2100, height: 1500, imageCommit: 'b'.repeat(40) };
async function resource(
  name: string,
  version = 1,
  status: 'PUBLISHED' | 'DRAFT' = 'PUBLISHED',
  kind: 'MAP' | 'SCENARIO' = 'MAP',
) {
  const content = { id: name, cities: [] };
  const row = await db.gameResource.create({
    data: {
      name,
      version,
      kind,
      status,
      publishedAt: status === 'PUBLISHED' ? new Date(epoch) : null,
      content,
      contentHash: hashState(content),
      source: '시험용 지도',
    },
  });
  return row;
}
async function world(mapKey: string, status: 'RUNNING' | 'PAUSED' | 'PREOPEN' | 'ENDED' = 'RUNNING') {
  const row = await db.world.create({
    data: {
      name: '바탕 그림 조회',
      scenarioKey: 'fixture',
      mapKey,
      unitSetKey: 'basic',
      seed: 'background',
      startYear: 191,
      turnTermMinutes: 60,
      status,
      initialStateHash: 'fixture',
      statRules: {},
      unitSet: {},
    },
  });
  return row.id;
}
async function rpc(path: string, input?: unknown, authenticated = false) {
  const encoded = input === undefined ? '' : '&input=' + encodeURIComponent(JSON.stringify({ 0: input }));
  const response = await fetch(`${address}/trpc/${path}?batch=1${encoded}`, {
    headers: authenticated ? { cookie } : {},
    signal: AbortSignal.timeout(10000),
  });
  const [body] = await response.json();
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
beforeAll(async () => {
  await admin.connect();
  expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
  await admin.query(`CREATE DATABASE "${name}"`);
  oid = String((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows[0]!.oid);
  await gate.connect();
  const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
  for (const entry of (await readdir(migrations)).filter((value) => /^\d{14}_/.test(value)).sort())
    await gate.query(await readFile(new URL(entry + '/migration.sql', migrations), 'utf8'));
  const session = newSession(now);
  await db.user.create({
    data: {
      id: userId,
      email: userId + '@example.test',
      passwordHash: 'test-only',
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  cookie = 'sid=' + session.token;
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  ready = true;
});
afterEach(({ task }) => {
  if (task.result?.state === 'fail') failed = true;
});
afterAll(async () => {
  const errors: unknown[] = [];
  for (const close of [() => app.close(), () => db.$disconnect(), () => gate.end()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  let dropped = false;
  try {
    if (oid) {
      await confirmDisconnectedDatabase(admin, name, oid);
      if (ready && !failed && !errors.length) {
        await admin.query(`DROP DATABASE "${name}"`);
        dropped = true;
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await admin.end();
  } catch (error) {
    errors.push(error);
  }
  console.info(
    JSON.stringify({ event: 'map-background-cleanup', name, oid, ready, failed, dropped, errors: errors.length }),
  );
  if (errors.length) throw new AggregateError(errors, '지도 그림 시험의 자기 DB 정리 실패');
});

it('AC-P2-28 등록은 게시 MAP의 정확한 판에 한 번만 연결하고 같은 값의 동시 재등록은 멱등이다', async () => {
  const name = prefix + 'a';
  const first = await resource(name),
    second = await resource(name, 2),
    draft = await resource(name, 3, 'DRAFT');
  await resource(prefix + 'scenario', 1, 'PUBLISHED', 'SCENARIO');
  expect(await registerMapBackground(db, { mapKey: prefix + 'missing', ...image })).toEqual({
    ok: false,
    reason: 'NOT_FOUND',
  });
  expect(await registerMapBackground(db, { mapKey: prefix + 'scenario', ...image })).toEqual({
    ok: false,
    reason: 'NOT_FOUND',
  });
  expect(await registerMapBackground(db, { mapKey: name + '@3', ...image })).toEqual({
    ok: false,
    reason: 'NOT_PUBLISHED',
  });
  const input = { mapKey: name + '@2', ...image };
  const outcomes = await Promise.all([registerMapBackground(db, input), registerMapBackground(db, input)]);
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  expect(outcomes.filter((outcome) => outcome.ok && !outcome.existing)).toHaveLength(1);
  expect(await registerMapBackground(db, { ...input, sha256: 'c'.repeat(64) })).toEqual({
    ok: false,
    reason: 'DIFFERENT_EXISTS',
  });
  expect(await db.mapBackground.count({ where: { resourceId: second.id } })).toBe(1);
  for (const row of [first, second, draft])
    expect(await db.gameResource.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  expect(await readMapBackgrounds(db, [name, name + '@2', name + '@3'])).toEqual(
    new Map([[name + '@2', { path: `maps/${name}@2/base.webp`, width: 2100, height: 1500 }]]),
  );
  for (const mapKey of [name + '@1', name + '@02', '../x', 'https://example.test/map', name + '\n'])
    await expect(registerMapBackground(db, { mapKey, ...image })).rejects.toThrow();
});

it('AC-P2-28 지도 권한·다른 판·메타데이터 공개 범위와 공개 사본 지연을 보존한다', async () => {
  const name = prefix + 'b';
  await resource(name);
  await resource(name, 2);
  await registerMapBackground(db, { mapKey: name + '@2', ...image });
  const oldWorld = await world(name),
    newWorld = await world(name + '@2'),
    hidden = await world(name + '@2', 'PREOPEN');
  const expected = { path: `maps/${name}@2/base.webp`, width: 2100, height: 1500 };
  expect((await rpc('world.map', { worldId: newWorld })).code).toBe('UNAUTHORIZED');
  expect((await rpc('world.map', { worldId: oldWorld }, true)).data.background).toBeNull();
  const privateMap = await rpc('world.map', { worldId: newWorld }, true);
  expect(privateMap.status).toBe(200);
  expect(privateMap.data).toEqual({ cities: [], nations: [], generals: [], background: expected });
  await db.publicMapSnapshot.create({
    data: {
      worldId: newWorld,
      takenAt: new Date(now),
      tick: 0,
      year: 191,
      month: 1,
      data: { cities: [], nations: [], background: { path: 'https://invalid.test/' } },
    },
  });
  const early = (await rpc('world.publicMaps')).data;
  expect(early.worlds.find((row: { id: string }) => row.id === newWorld)).toMatchObject({
    background: expected,
    map: null,
  });
  expect(early.worlds.find((row: { id: string }) => row.id === oldWorld)).toMatchObject({ background: null });
  expect(early.worlds.some((row: { id: string }) => row.id === hidden)).toBe(false);
  now += early.delayMinutes * 60_000;
  const exposed = (await rpc('world.publicMaps')).data.worlds.find((row: { id: string }) => row.id === newWorld);
  expect(exposed.background).toEqual(expected);
  expect(Object.keys(exposed.background).sort()).toEqual(['height', 'path', 'width']);
  expect(exposed.map).toEqual({ takenAt: new Date(epoch).toISOString(), year: 191, month: 1, cities: [], nations: [] });
});

it('AC-P2-28 지도 해시가 바뀌거나 키가 비정규면 그림을 내지 않고 DB는 잘못된 메타데이터를 거부한다', async () => {
  const name = prefix + 'c',
    row = await resource(name);
  await registerMapBackground(db, { mapKey: name, ...image });
  await expect(
    db.gameResource.update({ where: { id: row.id }, data: { contentHash: 'd'.repeat(64) } }),
  ).rejects.toThrow();
  await db.mapBackground.update({ where: { resourceId: row.id }, data: { mapContentHash: 'd'.repeat(64) } });
  expect(await readMapBackgrounds(db, [name, name + '@1', '../x'])).toEqual(new Map());
  const other = await resource(prefix + 'constraints');
  for (const changes of [
    { sha256: 'A'.repeat(64) },
    { imageCommit: 'b'.repeat(39) },
    { mapContentHash: 'z'.repeat(64) },
    { width: 0 },
    { height: -1 },
    { bytes: 0 },
  ])
    await expect(
      db.mapBackground.create({
        data: { resourceId: other.id, mapContentHash: other.contentHash, ...image, ...changes },
      }),
    ).rejects.toThrow();
  expect(await db.mapBackground.count({ where: { resourceId: other.id } })).toBe(0);
});
