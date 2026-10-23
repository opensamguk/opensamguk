import { randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, notifyWorld, worldChannel, type RealtimeSignal } from '../packages/db/src/index';
import type { inferRouterOutputs } from '@trpc/server';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { appRouter, type AppRouter } from '../apps/server/src/router';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { publishNotice } from './notice-publish';

type Outputs = inferRouterOutputs<AppRouter>;
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const applicationName = `t2-09-${randomUUID()}`;
const app = await buildServer({
  db,
  logging: false,
  realtime: { connectionString: url, applicationName, heartbeatMs: 100, reconnectMs: 50 },
});
const users: Array<{ id: string; cookie: string; sessionId: string }> = [];
let base: string, worldId: string, otherWorldId: string;
const origin = 'http://127.0.0.1:5173';
const actorInput = () => ({ worldId });
async function call<T = unknown>(path: string, data: unknown, user = 0, endpoint = base) {
  const mutation = appRouter._def.procedures[path]?._def.type === 'mutation';
  const encoded = JSON.stringify({ 0: data });
  const response = await fetch(
    `${endpoint}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin,
        ...(user >= 0 ? { cookie: users[user]!.cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const body = (await response.json())[0] as {
    result?: { data: T };
    error?: { message: string; data: { code: string } };
  };
  return {
    status: response.status,
    data: body.result?.data,
    code: body.error?.data.code,
    message: body.error?.message,
  };
}
async function until(predicate: () => boolean | Promise<boolean>, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('예정 시간 안에 조건을 확인하지 못했습니다.');
    await delay(10);
  }
}
const streams: Array<{ abort: () => void; done: () => boolean }> = [];
async function stream(user = 0, endpoint = base, streamWorldId = worldId) {
  const controller = new AbortController();
  const response = await fetch(`${endpoint}/sse?worldId=${streamWorldId}`, {
    headers: { origin, cookie: users[user]!.cookie },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const events: Array<Record<string, unknown>> = [];
  const receivedAt: number[] = [];
  let ended = false,
    heartbeats = 0;
  void (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (packet.startsWith(': hb')) heartbeats++;
          const data = packet.split('\n').find((line) => line.startsWith('data: '));
          if (data) {
            events.push(JSON.parse(data.slice(6)));
            receivedAt.push(Date.now());
          }
        }
      }
    } catch {
      /* The test closes its own HTTP stream. */
    } finally {
      ended = true;
    }
  })();
  const result = {
    events,
    receivedAt,
    done: () => ended,
    abort: () => controller.abort(),
    heartbeats: () => heartbeats,
  };
  streams.push(result);
  await until(() => events.some((event) => event.kind === 'ready'));
  return result;
}
async function signal(value: RealtimeSignal) {
  await notifyWorld(db, worldId, value);
}
async function worker() {
  const child = fork(fileURLToPath(new URL('../apps/server/test/messagingWorker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, TEST_DATABASE_URL: url!, DATABASE_URL: url! },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const endpoint = await new Promise<string>((resolve, reject) => {
    child.once('message', (message) => resolve((message as { base: string }).base));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code) reject(new Error('시험 서버가 종료됐습니다.'));
    });
  });
  return {
    base: endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.send('close');
      }),
  };
}

beforeAll(async () => {
  for (let i = 0; i < 7; i++) {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, passwordHash: 'not-used-by-session-tests' },
    });
    const session = newSession(Date.now());
    await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
    users.push({ id: user.id, cookie: `sid=${session.token}`, sessionId: session.id });
  }
  const initial = await readFixture();
  initial.generals.push({ ...initial.generals[2]!, id: 5 }, { ...initial.generals[0]!, id: 6 });
  initial.generals = initial.generals.map((g, i) => ({
    ...g,
    name: `메시지장수${i + 1}`,
    userId: users[i]!.id,
    officerLevel: [12, 11, 12, 0, 1, 1][i]!,
    nextTurnTick: 500,
  }));
  ({ worldId } = await saveInitialWorld(db, initial, { name: 'T2-09 메시지', turnTermMinutes: 60, endYear: null }));
  ({ worldId: otherWorldId } = await saveInitialWorld(db, initial, {
    name: 'T2-09 다른 월드',
    turnTermMinutes: 60,
    endYear: null,
  }));
  base = await app.listen({ host: '127.0.0.1', port: 0 });
}, 60000);
beforeEach(async () => {
  await db.message.deleteMany({ where: { worldId: { in: [worldId, otherWorldId] } } });
  await db.notice.deleteMany({ where: { worldId: { in: [worldId, otherWorldId] } } });
  await db.nation.updateMany({
    where: { worldId },
    data: { notice: '', noticeRevision: 0, noticeUpdatedAt: null, noticeUpdatedBy: null },
  });
  for (let i = 0; i < 6; i++) {
    await db.general.update({
      where: { worldId_id: { worldId, id: i + 1 } },
      data: { nationId: [1, 1, 2, null, 2, 1][i]!, officerLevel: [12, 11, 12, 0, 1, 1][i]! },
    });
    await db.$executeRaw`UPDATE "General" SET "noticeSeen" = NULL WHERE "worldId" = ${worldId} AND id = ${i + 1}`;
    await db.user.update({ where: { id: users[i]!.id }, data: { status: 'ACTIVE' } });
    await db.session.upsert({
      where: { id: users[i]!.sessionId },
      create: { id: users[i]!.sessionId, userId: users[i]!.id, expiresAt: new Date(Date.now() + 86400000) },
      update: { expiresAt: new Date(Date.now() + 86400000) },
    });
  }
});
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: [worldId, otherWorldId] } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});

describe('T2-09 실제 HTTP 메시지·공지 권한 대조', () => {
  const inputs = () => ({
    'message.list': { worldId, scope: 'PRIVATE' },
    'message.send': { worldId, scope: 'PRIVATE', toGeneralId: 2, body: '권한 시험' },
    'message.markRead': { worldId, ids: [randomUUID()] },
    'message.unread': actorInput(),
    'message.recipients': actorInput(),
    'notice.nation.get': actorInput(),
    'notice.nation.set': { worldId, body: '공지' },
    'notice.nation.markSeen': { worldId, nationId: 1, revision: 0 },
    'notice.world.list': actorInput(),
  });
  for (const path of Object.keys(inputs()))
    for (const category of categories)
      it(
        `${path} ${category}`,
        authzCase(path, category, async () => {
          if (category === 'sanctioned')
            await db.user.update({ where: { id: users[0]!.id }, data: { status: 'SANCTIONED' } });
          const input =
            category === 'invalidInput' ? { unexpected: true } : inputs()[path as keyof ReturnType<typeof inputs>];
          const result = await call(
            path,
            input,
            category === 'unauthenticated' ? -1 : category === 'otherUser' ? 6 : 0,
          );
          expect(result.code).toBe(
            category === 'success'
              ? undefined
              : category === 'otherUser'
                ? 'NOT_FOUND'
                : category === 'invalidInput'
                  ? 'BAD_REQUEST'
                  : 'UNAUTHORIZED',
          );
          if (category === 'success') expect(result.status).toBe(200);
        }),
      );

  it('개인 읽음은 발신·수신 장수만 바꾸며 남의 ID와 다른 월드 ID는 건너뛴다', async () => {
    const sent = (
      await call<Outputs['message']['send']>('message.send', {
        worldId,
        scope: 'PRIVATE',
        toGeneralId: 2,
        body: '<b>평문</b>',
      })
    ).data!.item;
    expect(sent.read).toBe(true);
    expect(sent.direction).toBe('sent');
    expect((await call<Outputs['message']['unread']>('message.unread', { worldId }, 1)).data!.PRIVATE).toBe(1);
    expect(
      (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'PRIVATE' }, 2)).data!.items,
    ).toEqual([]);
    const other = (
      await call<Outputs['message']['send']>('message.send', {
        worldId: otherWorldId,
        scope: 'PRIVATE',
        toGeneralId: 2,
        body: '다른 월드',
      })
    ).data!.item;
    expect(
      (
        await call<Outputs['message']['markRead']>(
          'message.markRead',
          { worldId, ids: [sent.id, other.id, randomUUID()] },
          2,
        )
      ).data!.updated,
    ).toBe(0);
    const read = (
      await call<Outputs['message']['markRead']>('message.markRead', { worldId, ids: [sent.id, sent.id, other.id] }, 1)
    ).data!;
    expect(read.updated).toBe(1);
    expect(read.unread.PRIVATE).toBe(0);
    expect(
      (await call<Outputs['message']['markRead']>('message.markRead', { worldId, ids: [sent.id] }, 1)).data!.updated,
    ).toBe(0);
    const list = (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'PRIVATE' }, 1)).data!;
    expect(list.items[0]).toMatchObject({
      id: sent.id,
      read: true,
      body: '<b>평문</b>',
      direction: 'received',
      from: { generalId: 1, name: '메시지장수1' },
    });
    expect(list.items).toHaveLength(1);
  });
  it('국가·외교 권한은 현재 소속·직책을 따르고 표시용 국명은 발신 시점을 보존한다', async () => {
    expect((await call('message.send', { worldId, scope: 'NATION', body: '국가만' }, 5)).status).toBe(200);
    expect((await call('message.send', { worldId, scope: 'DIPLOMACY', toNationId: 2, body: '외교' }, 5)).code).toBe(
      'FORBIDDEN',
    );
    expect((await call('message.send', { worldId, scope: 'DIPLOMACY', toNationId: 2, body: '외교' }, 1)).status).toBe(
      200,
    );
    expect((await call('message.list', { worldId, scope: 'NATION' }, 3)).code).toBe('FORBIDDEN');
    expect((await call('message.list', { worldId, scope: 'DIPLOMACY' }, 4)).code).toBe('FORBIDDEN');
    expect(
      (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'DIPLOMACY' }, 2)).data!.items,
    ).toHaveLength(1);
    const before = (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'NATION' }, 1)).data!;
    const oldName = before.items[0]!.from.nation!.name;
    await db.nation.update({ where: { worldId_id: { worldId, id: 1 } }, data: { name: '새국호' } });
    expect(
      (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'NATION' }, 1)).data!.items[0]!.from
        .nation!.name,
    ).toBe(oldName);
    await db.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { nationId: 2, officerLevel: 1 } });
    expect(
      (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'NATION' }, 1)).data!.items,
    ).toEqual([]);
    expect((await call('message.list', { worldId, scope: 'DIPLOMACY' }, 1)).code).toBe('FORBIDDEN');
    expect((await call<Outputs['message']['unread']>('message.unread', { worldId }, 3)).data).toEqual({
      PRIVATE: 0,
      NATION: null,
      DIPLOMACY: null,
      WORLD: 0,
    });
  });
  it('입력·수신자·scope와 cursor를 엄격히 검사하고 공개 수신자 목록만 낸다', async () => {
    for (const data of [
      { scope: 'WORLD', body: '금지' },
      { scope: 'PRIVATE', body: '없음' },
      { scope: 'NATION', toGeneralId: 2, body: '잘못' },
      { scope: 'PRIVATE', toGeneralId: 999, body: '없음' },
      { scope: 'PRIVATE', toGeneralId: 2, body: '' },
      { scope: 'PRIVATE', toGeneralId: 2, body: 'a'.repeat(1001) },
      { scope: 'PRIVATE', toGeneralId: 2, body: '위조', generalId: 3 },
    ])
      expect((await call('message.send', { worldId, ...data })).code).toBe('BAD_REQUEST');
    for (const cursor of [
      '',
      'not-a-cursor',
      Buffer.from('["bad","bad"]').toString('base64url'),
      Buffer.from(JSON.stringify(['2026-10-23T00:00:00.000Z', randomUUID()])).toString('base64url') + '=',
    ])
      expect((await call('message.list', { worldId, scope: 'PRIVATE', cursor })).code).toBe('BAD_REQUEST');
    expect((await call('message.markRead', { worldId, ids: [] })).code).toBe('BAD_REQUEST');
    expect(
      (await call('message.markRead', { worldId, ids: Array.from({ length: 101 }, () => randomUUID()) })).code,
    ).toBe('BAD_REQUEST');
    const recipients = (await call<Outputs['message']['recipients']>('message.recipients', { worldId })).data!;
    expect(recipients.generals.map((g) => g.id)).not.toContain(1);
    expect(Object.keys(recipients.generals[0]!).sort()).toEqual(['id', 'name', 'nation']);
    expect(recipients.nations.map((n) => n.id)).toEqual([2]);
  });
  it('같은 시각의 41행을 시간·ID 커서로 빠짐과 중복 없이 읽는다', async () => {
    const time = new Date('2026-10-23T00:00:00.123Z');
    await db.message.createMany({
      data: Array.from({ length: 41 }, () => ({
        id: randomUUID(),
        worldId,
        scope: 'PRIVATE' as const,
        senderId: 2,
        recipientId: 1,
        fromParty: { generalId: 2, name: '발신자', nation: null },
        toParty: { generalId: 1, name: '수신자', nation: null },
        body: '시간 동률',
        sentAt: time,
        year: 191,
        month: 1,
      })),
    });
    const expected = (
      await db.message.findMany({
        where: { worldId },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).map((row) => row.id);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Outputs['message']['list'] = (
        await call<Outputs['message']['list']>('message.list', {
          worldId,
          scope: 'PRIVATE',
          ...(cursor ? { cursor } : {}),
        })
      ).data!;
      ids.push(...page.items.map((item) => item.id));
      cursor = page.next;
    } while (cursor);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(41);
  });
  it('두 실제 서버 프로세스가 동시에 보내도 1분 안에 10개만 저장한다', async () => {
    const child = await worker();
    try {
      const result = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          call(
            'message.send',
            { worldId, scope: 'PRIVATE', toGeneralId: 2, body: `동시${index}` },
            0,
            index % 2 ? child.base : base,
          ),
        ),
      );
      expect(result.filter((r) => r.status === 200)).toHaveLength(10);
      expect(result.filter((r) => r.code === 'TOO_MANY_REQUESTS')).toHaveLength(2);
      expect(await db.message.count({ where: { worldId, senderId: 1 } })).toBe(10);
      await db.message.updateMany({ where: { worldId }, data: { sentAt: new Date(Date.now() - 61000) } });
      expect((await call('message.send', { worldId, scope: 'PRIVATE', toGeneralId: 2, body: '다음 분' })).status).toBe(
        200,
      );
    } finally {
      await child.close();
    }
  }, 120000);
});

describe('T2-09 국가 공지 revision', () => {
  it('이전 판 닫기·역순·중복·미래 판과 빈 본문을 처리한다', async () => {
    await call('notice.nation.set', { worldId, body: '첫 판' });
    const second = (await call<Outputs['notice']['nation']['set']>('notice.nation.set', { worldId, body: '둘째 판' }))
      .data!;
    expect(second!.revision).toBe(2);
    expect(
      (
        await call<Outputs['notice']['nation']['markSeen']>(
          'notice.nation.markSeen',
          { worldId, nationId: 1, revision: 1 },
          1,
        )
      ).data!.unseen,
    ).toBe(true);
    expect(
      (
        await call<Outputs['notice']['nation']['markSeen']>(
          'notice.nation.markSeen',
          { worldId, nationId: 1, revision: 2 },
          1,
        )
      ).data!.unseen,
    ).toBe(false);
    await call('notice.nation.markSeen', { worldId, nationId: 1, revision: 1 }, 1);
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } })).noticeSeen).toEqual({
      nationId: 1,
      revision: 2,
    });
    expect((await call('notice.nation.markSeen', { worldId, nationId: 1, revision: 3 }, 1)).code).toBe('BAD_REQUEST');
    expect((await call('notice.nation.set', { worldId, body: '무권한' }, 5)).code).toBe('FORBIDDEN');
    expect(
      (await call<Outputs['notice']['nation']['set']>('notice.nation.set', { worldId, body: '' })).data!.unseen,
    ).toBe(false);
  });
  it('국가를 옮긴 뒤 온 옛 팝업 닫기는 새 국가를 읽음 처리하지 않는다', async () => {
    await db.nation.updateMany({ where: { worldId }, data: { notice: '같은 판 번호', noticeRevision: 3 } });
    await db.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { nationId: 2 } });
    const old = (
      await call<Outputs['notice']['nation']['markSeen']>(
        'notice.nation.markSeen',
        { worldId, nationId: 1, revision: 3 },
        1,
      )
    ).data!;
    expect(old).toMatchObject({ nationId: 2, revision: 3, unseen: true });
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } })).noticeSeen).toBeNull();
    await call('notice.nation.markSeen', { worldId, nationId: 2, revision: 3 }, 1);
    await call('notice.nation.markSeen', { worldId, nationId: 1, revision: 3 }, 1);
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } })).noticeSeen).toEqual({
      nationId: 2,
      revision: 3,
    });
    await db.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { nationId: null } });
    expect((await call('notice.nation.markSeen', { worldId, nationId: 1, revision: 3 }, 1)).data).toBeNull();
    await db.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { nationId: 1 } });
    expect(
      (
        await call<Outputs['notice']['nation']['markSeen']>(
          'notice.nation.markSeen',
          { worldId, nationId: 1, revision: 3 },
          1,
        )
      ).data!.unseen,
    ).toBe(false);
  });
  it('소속 변경 트랜잭션을 기다린 뒤 새 국가 기준으로 판정한다', async () => {
    await db.nation.updateMany({ where: { worldId }, data: { notice: '판3', noticeRevision: 3 } });
    let unlock!: () => void, locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const change = db.$transaction(async (tx) => {
      await tx.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { nationId: 2 } });
      locked();
      await hold;
    });
    await ready;
    const close = call<Outputs['notice']['nation']['markSeen']>(
      'notice.nation.markSeen',
      { worldId, nationId: 1, revision: 3 },
      1,
    );
    await delay(50);
    unlock();
    await change;
    expect((await close).data).toMatchObject({ nationId: 2, unseen: true });
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } })).noticeSeen).toBeNull();
  });
  it('공지와 읽음 metadata는 게임 상태·재생 입력 해시에 섞이지 않는다', async () => {
    const before = hashState(await readWorldState(db, worldId));
    await call('notice.nation.set', { worldId, body: '규칙 밖 공지' });
    await call('notice.nation.markSeen', { worldId, nationId: 1, revision: 1 }, 1);
    expect(hashState(await readWorldState(db, worldId))).toBe(before);
  });
});

describe('T2-09 실제 PostgreSQL LISTEN·SSE', () => {
  it('다른 사용자가 같은 월드나 다른 월드에 연결해도 기존 연결에 ready를 다시 보내지 않는다', async () => {
    const a = await stream();
    const readyCount = () => a.events.filter((event) => event.kind === 'ready').length;
    expect(readyCount()).toBe(1);
    await stream(1);
    await stream(2, base, otherWorldId);
    await signal({ kind: 'monthly.done', target: 'world' });
    await until(() => a.events.some((event) => event.kind === 'monthly.done'));
    expect(readyCount()).toBe(1);
  });
  it('다른 서버의 두 사용자가 보낸 개인 메시지는 요청 시작부터 2초 안에 상대 SSE에 닿는다', async () => {
    const child = await worker();
    try {
      const local = await stream();
      const remote = await stream(1, child.base);
      for (const [sender, recipient, endpoint, receiver] of [
        [0, 2, base, remote],
        [1, 1, child.base, local],
      ] as const) {
        const started = Date.now();
        const sent = await call<Outputs['message']['send']>(
          'message.send',
          { worldId, scope: 'PRIVATE', toGeneralId: recipient, body: '서버 간 수신 시간' },
          sender,
          endpoint,
        );
        expect(sent.status).toBe(200);
        await until(() => receiver.events.some((event) => event.kind === 'message.new'));
        const index = receiver.events.findIndex((event) => event.kind === 'message.new');
        expect(receiver.receivedAt[index]! - started).toBeLessThan(2000);
        expect(
          (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'PRIVATE' }, 1 - sender)).data!
            .items,
        ).toContainEqual(expect.objectContaining({ id: sent.data!.item.id, body: '서버 간 수신 시간' }));
      }
    } finally {
      await child.close();
    }
  }, 60000);
  it('인증·월드·출처를 검사하고 ready 이후 하트비트를 보낸다', async () => {
    const denied = await fetch(`${base}/sse?worldId=${worldId}`);
    expect(denied.status).toBe(401);
    const bad = await fetch(`${base}/sse?worldId=bad`, { headers: { cookie: users[0]!.cookie } });
    expect(bad.status).toBe(400);
    const foreign = await fetch(`${base}/sse?worldId=${worldId}`, {
      headers: { cookie: users[0]!.cookie, origin: 'https://other.test' },
    });
    expect(foreign.status).toBe(403);
    const s = await stream();
    expect(s.events).toContainEqual({ kind: 'ready' });
    await until(() => s.heartbeats() > 0);
  });
  it('개인·국가·외교·월드 신호는 현재 권한에만 가고 본문·ID는 보내지 않는다', async () => {
    const own = await stream(),
      fellow = await stream(1),
      enemy = await stream(2),
      common = await stream(5);
    await call('message.send', { worldId, scope: 'PRIVATE', toGeneralId: 2, body: '비밀본문' });
    await until(() => fellow.events.some((e) => e.kind === 'message.new'));
    expect(own.events.filter((e) => e.kind === 'message.new')).toEqual([]);
    expect(enemy.events.filter((e) => e.kind === 'message.new')).toEqual([]);
    await call('message.send', { worldId, scope: 'DIPLOMACY', toNationId: 2, body: '외교비밀' });
    await until(() => enemy.events.some((e) => e.scope === 'DIPLOMACY'));
    expect(common.events.some((e) => e.scope === 'DIPLOMACY')).toBe(false);
    await call('message.send', { worldId, scope: 'NATION', body: '국가비밀' });
    await until(() => common.events.some((e) => e.scope === 'NATION'));
    expect(enemy.events.some((e) => e.scope === 'NATION')).toBe(false);
    for (const s of [own, fellow, enemy, common])
      for (const event of s.events)
        expect(Object.keys(event).every((key) => ['kind', 'scope'].includes(key))).toBe(true);
    expect(JSON.stringify([own.events, fellow.events, enemy.events])).not.toContain('비밀');
  });
  it('탈국·직책 해제 뒤 알림을 받지 않고 제재·만료 세션은 닫힌다', async () => {
    const s = await stream(1);
    await db.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { nationId: 2, officerLevel: 1 } });
    await signal({ kind: 'message.new', scope: 'NATION', target: { nationId: 1 } });
    await signal({ kind: 'message.new', scope: 'DIPLOMACY', target: { nationIds: [1, 2], leadersOnly: true } });
    await delay(200);
    expect(s.events.filter((e) => e.kind === 'message.new')).toEqual([]);
    await db.user.update({ where: { id: users[1]!.id }, data: { status: 'SANCTIONED' } });
    await until(s.done);
    const other = await stream(2);
    await db.session.update({ where: { id: users[2]!.sessionId }, data: { expiresAt: new Date(0) } });
    await until(other.done);
  });
  it('로그아웃은 같은 세션의 로컬·다른 프로세스 SSE를 즉시 닫는다', async () => {
    const child = await worker();
    try {
      const local = await stream();
      const remote = await stream(0, child.base);
      expect((await call('auth.logout', undefined)).status).toBe(200);
      await until(() => local.done() && remote.done());
    } finally {
      await child.close();
    }
  }, 60000);
  it('엔진 rollback은 알림을 보내지 않고 별도 pg_notify SQL 실패는 저장을 되돌리지 않는다', async () => {
    const s = await stream();
    await db.world.update({
      where: { id: worldId },
      data: { status: 'RUNNING', clockAnchorAt: new Date(), clockTick: 0 },
    });
    const lease = await acquireLease(db, worldId, randomUUID(), 60000);
    expect(lease).not.toBeNull();
    const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    try {
      await expect(
        new TurnLoop(db, lease!, {
          beforeCommit: async () => {
            throw new Error('rollback');
          },
        }).advanceTo(500),
      ).rejects.toThrow('rollback');
      await delay(150);
      expect(s.events.filter((e) => e.kind === 'turn.result')).toEqual([]);
      expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).nextTurnTick).toBe(
        before.nextTurnTick,
      );
    } finally {
      await db.$transaction((tx) => releaseLease(tx, lease!));
    }
    await db.world.update({ where: { id: worldId }, data: { name: '알림 실패와 독립한 저장' } });
    let warnings = 0;
    const oversize = { kind: 'monthly.done', target: 'world', extra: 'x'.repeat(9000) } as const;
    expect(
      await notifyWorld(db, worldId, oversize, () => {
        warnings++;
      }),
    ).toBe(false);
    expect(warnings).toBe(1);
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).name).toBe('알림 실패와 독립한 저장');
    await signal({ kind: 'monthly.done', target: 'world' });
    await until(() => s.events.some((e) => e.kind === 'monthly.done'));
  });
  it('알림 autocommit 단계의 실제 PG 실패도 이미 저장한 게임과 HTTP 성공을 바꾸지 않는다', async () => {
    await db.$executeRawUnsafe('CREATE SCHEMA t209_notify_failure');
    await db.$executeRawUnsafe('CREATE TABLE t209_notify_failure.parent (id int PRIMARY KEY)');
    await db.$executeRawUnsafe(
      'CREATE TABLE t209_notify_failure.child (id int REFERENCES t209_notify_failure.parent(id) DEFERRABLE INITIALLY DEFERRED)',
    );
    await db.$executeRawUnsafe(
      `CREATE FUNCTION t209_notify_failure.pg_notify(channel text, payload text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_catalog.pg_notify(channel, payload); INSERT INTO t209_notify_failure.child VALUES (1); END $$`,
    );
    const faultUrl = new URL(url!);
    faultUrl.searchParams.set('options', '-c search_path=t209_notify_failure,pg_catalog,public');
    const faultDb = createDb(faultUrl.href);
    const faultApp = await buildServer({ db: faultDb, logging: false });
    try {
      const endpoint = await faultApp.listen({ host: '127.0.0.1', port: 0 });
      const s = await stream(1);
      const sent = await call<Outputs['message']['send']>(
        'message.send',
        { worldId, scope: 'PRIVATE', toGeneralId: 2, body: '알림 commit 오류 뒤에도 저장' },
        0,
        endpoint,
      );
      expect(sent.status).toBe(200);
      expect(await db.message.count({ where: { id: sent.data!.item.id, worldId } })).toBe(1);
      await delay(150);
      expect(s.events.filter((e) => e.kind === 'message.new')).toEqual([]);
      let warnings = 0;
      expect(
        await notifyWorld(faultDb, worldId, { kind: 'monthly.done', target: 'world' }, () => {
          warnings++;
        }),
      ).toBe(false);
      expect(warnings).toBe(1);
      expect(await db.$queryRaw`SELECT * FROM t209_notify_failure.child`).toEqual([]);
    } finally {
      await faultApp.close();
      await faultDb.$disconnect();
      await db.$executeRawUnsafe('DROP SCHEMA t209_notify_failure CASCADE');
    }
  }, 60000);
  it('LISTEN 연결을 실제로 끊으면 재구독 뒤 모든 연결에 ready를 다시 보낸다', async () => {
    const a = await stream(),
      b = await stream(1);
    const counts = [a, b].map((s) => s.events.filter((e) => e.kind === 'ready').length);
    const rows = await db.$queryRaw<
      Array<{ pid: number }>
    >`SELECT pid FROM pg_stat_activity WHERE application_name = ${applicationName}`;
    expect(rows).toHaveLength(1);
    await db.$queryRaw`SELECT pg_terminate_backend(${rows[0]!.pid})`;
    await until(() => [a, b].every((s, i) => s.events.filter((e) => e.kind === 'ready').length > counts[i]!));
    await signal({ kind: 'monthly.done', target: 'world' });
    await until(
      () => a.events.some((e) => e.kind === 'monthly.done') && b.events.some((e) => e.kind === 'monthly.done'),
    );
    a.abort();
    const next = await stream();
    expect(next.events).toContainEqual({ kind: 'ready' });
  });
  it('다른 월드·잘못된 notify 내용은 전달하지 않는다', async () => {
    const s = await stream();
    await notifyWorld(db, otherWorldId, { kind: 'monthly.done', target: 'world' });
    await db.$queryRaw`SELECT pg_notify(${worldChannel(worldId)}, ${JSON.stringify({ kind: 'message.new', target: 'world', scope: 'PRIVATE', body: '누설' })})::text`;
    await delay(200);
    expect(s.events.filter((e) => e.kind !== 'ready')).toEqual([]);
  });
  it('실제 엔진 턴 commit 뒤 해당 장수만 2초 안에 turn.result를 받는다', async () => {
    await db.world.update({
      where: { id: worldId },
      data: { status: 'RUNNING', clockAnchorAt: new Date(), clockTick: 0 },
    });
    const s = await stream();
    const lease = await acquireLease(db, worldId, randomUUID(), 60000);
    expect(lease).not.toBeNull();
    try {
      const commits: number[] = [];
      await new TurnLoop(db, lease!, {
        beforeCommit: async () => {
          commits.push(Date.now());
        },
      }).advanceTo(500);
      await until(() => s.events.some((e) => e.kind === 'turn.result'));
      const index = s.events.findIndex((e) => e.kind === 'turn.result');
      expect(s.receivedAt[index]! - commits[0]!).toBeLessThan(2000);
      expect(s.events.filter((e) => e.kind === 'turn.result')).toHaveLength(1);
    } finally {
      await db.$transaction((tx) => releaseLease(tx, lease!));
    }
  });
});

describe('T2-09 운영자 공지 CLI', () => {
  it('로비·월드·WORLD Message를 분리하고 순서·월드 범위를 보존한다', async () => {
    const lobby = await publishNotice(db, { scope: 'lobby', title: '로비 제목', body: '로비 본문' });
    try {
      await publishNotice(db, { scope: 'world', worldId, body: '예전 고정', pinned: true });
      await publishNotice(db, { scope: 'world', worldId, body: '최신 일반' });
      await publishNotice(db, { scope: 'world', worldId: otherWorldId, body: '다른 월드' });
      const feed = (await call<Outputs['notice']['world']['list']>('notice.world.list', { worldId })).data!;
      expect(feed.items.map((item) => item.body)).toEqual(['예전 고정', '최신 일반']);
      expect(await db.notice.findUnique({ where: { id: lobby.id } })).toMatchObject({
        scope: 'LOBBY',
        title: '로비 제목',
        worldId: null,
        pinned: false,
      });
      const notices = await db.notice.count({ where: { worldId } });
      const s = await stream();
      await publishNotice(db, { scope: 'world-message', worldId, body: '운영자 전체 메시지' });
      await until(() => s.events.some((event) => event.kind === 'message.new' && event.scope === 'WORLD'));
      expect(await db.notice.count({ where: { worldId } })).toBe(notices);
      const message = (await call<Outputs['message']['list']>('message.list', { worldId, scope: 'WORLD' })).data!
        .items[0]!;
      expect(message).toMatchObject({
        scope: 'WORLD',
        direction: 'received',
        from: { generalId: null, name: '운영자', nation: null },
        to: null,
        body: '운영자 전체 메시지',
      });
    } finally {
      await db.notice.delete({ where: { id: lobby.id } });
    }
  });
  it('실제 CLI는 파일 본문만 받고 잘못된 월드·본문·인자를 저장하지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opensamguk-notice-'));
    const file = join(dir, 'body.txt');
    await writeFile(file, '명령줄 평문');
    async function cli(args: string[]) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tools/notice-publish.ts', ...args], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: { ...process.env, DATABASE_URL: url! },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
      });
      return { status, output };
    }
    try {
      expect((await cli(['--scope', 'world', '--world', worldId, '--body-file', file])).status).toBe(0);
      expect(await db.notice.count({ where: { worldId, body: '명령줄 평문' } })).toBe(1);
      const count = await db.notice.count();
      for (const args of [
        ['--scope', 'world', '--world', randomUUID(), '--body-file', file],
        ['--scope', 'lobby', '--body-file', file],
        ['--scope', 'world', '--world', worldId, '--body-file', file, '--body', '금지'],
      ])
        expect((await cli(args)).status).not.toBe(0);
      await writeFile(file, 'x'.repeat(1001));
      const invalid = await cli(['--scope', 'world-message', '--world', worldId, '--body-file', file]);
      expect(invalid.status).not.toBe(0);
      expect(invalid.output).not.toContain('x'.repeat(20));
      expect(await db.notice.count()).toBe(count);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120000);
});
