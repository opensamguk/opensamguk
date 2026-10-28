import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { processInputs } from '../apps/engine/src/inputs';
import { hashPassword, verifyPassword } from '../apps/server/src/auth/password';
import { issueAccountToken, resetPasswordToken } from '../apps/server/src/auth/accountTokenStore';
import { buildServer } from '../apps/server/src/server';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = Date.UTC(2026, 9, 28);
const users = new Set<string>(),
  worlds = new Set<string>();
async function user() {
  const created = await db.user.create({
    data: { email: `${randomUUID()}@example.test`, passwordHash: 'before-reset' },
  });
  users.add(created.id);
  return created;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

async function waitForLock(applicationName: string) {
  const deadline = Date.now() + 2000;
  do {
    const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name=${applicationName} AND wait_event_type='Lock' AND state='active') AS waiting`;
    if (rows[0]?.waiting) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('시험 요청이 행 잠금 대기에 도달하지 않았습니다.');
}

it.each([false, true])(
  '장수의 로그인과 World를 잠근 실제 엔진 입력은 교착 없이 함께 저장된다(재설정 대기 %s)',
  async (resetWaiting) => {
    const actor = await user();
    const password = randomUUID();
    await db.user.update({ where: { id: actor.id }, data: { passwordHash: await hashPassword(password) } });
    const initial = commandInitial();
    initial.generals[0]!.userId = actor.id;
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '로그인 잠금 전용',
      turnTermMinutes: 1,
      endYear: null,
      replayFormat: 3,
      ruleFeatures: ['policy'],
    });
    worlds.add(worldId);
    await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING' } });
    const input = await db.inputEvent.create({
      data: {
        worldId,
        userId: actor.id,
        generalId: 1,
        kind: 'general.active',
        idempotencyKey: `account-lock:${randomUUID()}`,
        payload: {},
        status: 'PENDING',
      },
    });
    const suffix = randomUUID().replaceAll('-', '');
    const loginName = `t302_engine_login_${suffix}`,
      resetName = `t302_engine_reset_${suffix}`;
    const loginUrl = new URL(url!),
      resetUrl = new URL(url!);
    loginUrl.searchParams.set('application_name', loginName);
    resetUrl.searchParams.set('application_name', resetName);
    const loginDb = createDb(loginUrl.href),
      engineDb = createDb(url!),
      resetDb = createDb(resetUrl.href);
    const nextPassword = randomUUID();
    const issued = (await issueAccountToken(db, actor.id, 'RESET_PASSWORD', now))!;
    const held = deferred(),
      proceed = deferred();
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    let logs = '';
    const requests: Array<Promise<unknown>> = [],
      failures: unknown[] = [];
    try {
      app = await buildServer({
        db: loginDb,
        now: () => now + 2,
        logStream: new Writable({
          write(chunk, _encoding, done) {
            logs += String(chunk);
            done();
          },
        }),
      });
      await app.ready();
      const engine = settled(
        engineDb.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
          held.resolve();
          await proceed.promise;
          const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
          // 실제 엔진 처리기가 World 뒤 User FOR SHARE와 General FOR UPDATE를 사용한다.
          return processInputs(tx, world, 123);
        }),
      );
      requests.push(engine);
      await Promise.race([
        held.promise,
        engine.then((result) => {
          if (result.status === 'rejected') throw result.reason;
          throw new Error('World 잠금 준비 전에 엔진이 끝났습니다.');
        }),
      ]);
      const login = settled(
        app.inject({
          method: 'POST',
          url: '/trpc/auth.login?batch=1',
          headers: { origin: 'http://127.0.0.1:5173' },
          payload: { 0: { email: actor.email, password } },
        }),
      );
      requests.push(login);
      await waitForLock(loginName);
      let reset: ReturnType<typeof settled<boolean>> | undefined;
      if (resetWaiting) {
        reset = settled(resetPasswordToken(resetDb, issued.token, nextPassword, now + 1));
        requests.push(reset);
        await waitForLock(resetName);
      }
      proceed.resolve();
      const engineResult = await engine,
        loginResult = await login;
      if (engineResult.status === 'rejected') throw engineResult.reason;
      if (loginResult.status === 'rejected') throw loginResult.reason;
      expect(engineResult.value).toBe(true);
      expect(loginResult.value.statusCode).toBe(200);
      for (const secret of [password, actor.email]) expect(logs.includes(secret)).toBe(false);
      if (reset) {
        const result = await reset;
        if (result.status === 'rejected') throw result.reason;
        expect(result.value).toBe(true);
        expect(
          await verifyPassword(
            (await db.user.findUniqueOrThrow({ where: { id: actor.id } })).passwordHash,
            nextPassword,
          ),
        ).toBe(true);
      }
      expect(await db.session.count({ where: { userId: actor.id } })).toBe(resetWaiting ? 0 : 1);
      expect(await db.inputEvent.findUniqueOrThrow({ where: { id: input.id } })).toMatchObject({
        status: 'APPLIED',
        result: { activeTick: 123 },
      });
      expect(await db.inputEvent.count({ where: { worldId, kind: 'general.active', status: 'PENDING' } })).toBe(1);
      expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).lastActiveTick).toBe(
        123,
      );
    } catch (error) {
      failures.push(error);
    } finally {
      proceed.resolve();
      await Promise.all(requests);
      for (const result of await Promise.allSettled([
        app?.close(),
        loginDb.$disconnect(),
        engineDb.$disconnect(),
        resetDb.$disconnect(),
      ])) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    if (failures.length) throw new AggregateError(failures, '로그인·엔진 경합 검사 또는 정리에 실패했습니다.');
  },
);
