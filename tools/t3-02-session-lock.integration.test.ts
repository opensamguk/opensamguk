import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { issueAccountToken, resetPasswordToken } from '../apps/server/src/auth/accountTokenStore';
import { newSession } from '../apps/server/src/auth/session';
import { buildServer } from '../apps/server/src/server';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const users = new Set<string>(),
  worlds = new Set<string>();
afterEach(async () => {
  await db.world.deleteMany({ where: { id: { in: [...worlds] } } });
  worlds.clear();
  await db.user.deleteMany({ where: { id: { in: [...users] } } });
  users.clear();
});
afterAll(() => db.$disconnect());
function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForLock(applicationName: string) {
  const deadline = Date.now() + 3000;
  do {
    const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name=${applicationName} AND wait_event_type='Lock' AND state='active') AS waiting`;
    if (rows[0]?.waiting) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('시험 요청이 행 잠금 대기에 도달하지 않았습니다.');
}

it.each(['message', 'sse'] as const)(
  '재설정이 먼저 시작되면 %s 조회는 교착 없이 폐기된 세션을 거부한다',
  async (mode) => {
    const now = Date.now();
    const actor = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, passwordHash: 'before-reset' },
    });
    users.add(actor.id);
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: actor.id, expiresAt: session.expiresAt } });
    const initial = commandInitial();
    initial.generals[0]!.userId = actor.id;
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '세션 잠금 전용',
      turnTermMinutes: 1,
      endYear: null,
      replayFormat: 3,
      ruleFeatures: ['policy'],
    });
    worlds.add(worldId);
    const suffix = randomUUID().replaceAll('-', '');
    const resetName = `t302_session_reset_${suffix}`,
      messageName = `t302_session_message_${suffix}`;
    const resetUrl = new URL(url!),
      messageUrl = new URL(url!);
    resetUrl.searchParams.set('application_name', resetName);
    messageUrl.searchParams.set('application_name', messageName);
    const resetDb = createDb(resetUrl.href),
      messageDb = createDb(messageUrl.href);
    const gateDb = createDb(url!),
      held = deferred(),
      release = deferred();
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const requests: Promise<unknown>[] = [],
      failures: unknown[] = [];
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    let logs = '';
    try {
      app = await buildServer({
        db: messageDb,
        realtime: { connectionString: url!, heartbeatMs: 60_000 },
        logStream: new Writable({
          write(chunk, _encoding, done) {
            logs += String(chunk);
            done();
          },
        }),
      });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const gate = settled(
        gateDb.$transaction(async (tx) => {
          // 공유 잠금은 메시지 조회를 허용하며 재설정의 세션 삭제만 기다리게 한다.
          await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${session.id} FOR SHARE`;
          held.resolve();
          await release.promise;
        }),
      );
      requests.push(gate);
      await Promise.race([
        held.promise,
        gate.then((result) => {
          if (result.status === 'rejected') throw result.reason;
          throw new Error('Session 잠금 준비 전에 트랜잭션이 끝났습니다.');
        }),
      ]);
      const reset = settled(resetPasswordToken(resetDb, issued.token, randomUUID(), now + 1));
      requests.push(reset);
      await waitForLock(resetName);
      const message = settled(
        mode === 'message'
          ? app
              .inject({
                method: 'POST',
                url: '/trpc/message.send?batch=1',
                headers: { origin: 'http://127.0.0.1:5173', cookie: `sid=${session.token}` },
                payload: { 0: { worldId, scope: 'NATION', body: '폐기 뒤 저장 금지' } },
              })
              .then((response) => ({ statusCode: response.statusCode, body: response.body }))
          : fetch(`${base}/sse?worldId=${worldId}`, {
              headers: { origin: 'http://127.0.0.1:5173', cookie: `sid=${session.token}` },
              signal: AbortSignal.timeout(8000),
            }).then(async (response) => ({ statusCode: response.status, body: await response.text() })),
      );
      requests.push(message);
      await waitForLock(messageName);
      release.resolve();
      const resetResult = await reset,
        messageResult = await message;
      if (resetResult.status === 'rejected') throw resetResult.reason;
      if (messageResult.status === 'rejected') throw messageResult.reason;
      expect(resetResult.value).toBe(true);
      expect(messageResult.value.statusCode).toBe(mode === 'message' ? 401 : 200);
      if (mode === 'sse') {
        expect(messageResult.value.body).toBe('');
        expect(logs).not.toContain('실시간 알림 연결 실패');
      }
      for (const secret of [session.token, issued.token, actor.email]) expect(logs).not.toContain(secret);
      expect(await db.session.count({ where: { userId: actor.id } })).toBe(0);
      expect(await db.message.count({ where: { worldId } })).toBe(0);
    } catch (error) {
      failures.push(error);
    } finally {
      release.resolve();
      for (const result of (await Promise.all(requests)) as PromiseSettledResult<unknown>[])
        if (result.status === 'rejected') failures.push(result.reason);
      for (const result of await Promise.allSettled([
        app?.close(),
        gateDb.$disconnect(),
        resetDb.$disconnect(),
        messageDb.$disconnect(),
      ]))
        if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, '재설정·메시지 경합 검사 또는 정리에 실패했습니다.');
  },
);
