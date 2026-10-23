import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import type { PolicyKey, PolicySlot } from '../packages/rules/src/policy';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_000;
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, now: () => now, logging: false, publicOrigin: origin });
const worlds: string[] = [],
  users: string[] = [];
const leases: NonNullable<Awaited<ReturnType<typeof acquireLease>>>[] = [];
let base: string, passwordHash: string;
const password = randomUUID();
beforeAll(async () => {
  passwordHash = await hashPassword(password);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  for (const lease of leases) await releaseLease(db, lease);
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function user(status: 'ACTIVE' | 'SANCTIONED' = 'ACTIVE') {
  const email = `t213-${randomUUID()}@example.invalid`;
  const row = await db.user.create({ data: { email, passwordHash, status } });
  users.push(row.id);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: row.id, expiresAt: session.expiresAt } });
  return { id: row.id, email, cookie: `sid=${session.token}`, sessionId: session.id };
}
async function fixture(options: { farmMax?: boolean } = {}) {
  const alice = await user(),
    bob = await user();
  const initial = commandInitial();
  if (options.farmMax) initial.cities[0]!.agriculture = initial.cities[0]!.agricultureMax;
  initial.generals = initial.generals
    .slice(0, 2)
    .map((general, i) => ({ ...general, userId: i ? bob.id : alice.id, nextTurnTick: i ? 5000 : 100 }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '방침 실제 HTTP',
    turnTermMinutes: 30,
    endYear: null,
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  return { alice, bob, worldId, lease, loop: new TurnLoop(db, lease) };
}
async function rpc<T = Record<string, unknown>>(path: string, input: unknown, cookie?: string, mutation = false) {
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const body = ((await response.json()) as Array<{ result?: { data: T }; error?: { data: { code: string } } }>)[0]!;
  return { status: response.status, data: body.result?.data, error: body.error?.data.code };
}
type Slots = { ok: boolean; revision: number; reason?: string; slots: PolicySlot[] };
async function appliedPolicy(f: Awaited<ReturnType<typeof fixture>>, policy: PolicyKey) {
  const request = rpc('general.setPolicy', { worldId: f.worldId, policy }, f.alice.cookie, true);
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId: f.worldId, kind: 'general.setPolicy', status: 'PENDING' } }))
    .toBe(1);
  expect(
    (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).defaultPolicy,
  ).toBe('none');
  await f.loop.advanceTo(0);
  const response = await request;
  expect(response.data).toMatchObject({ status: 'applied', policy: { current: policy, pending: null } });
}

it(
  '접수 직후 상태는 그대로이고 엔진 commit 뒤 적용되며 직접 휴식·빈칸과 12개월 재생을 보존한다',
  authzCase('general.setPolicy', 'success', async () => {
    const f = await fixture();
    await appliedPolicy(f, 'farm');
    const slots = Array.from({ length: 30 }, (_, i) => (i === 0 ? { commandKey: 'rest' } : null));
    const saved = await rpc<Slots>('turns.set', { worldId: f.worldId, revision: 0, slots }, f.alice.cookie, true);
    expect(saved.data!.slots.slice(0, 2).map((slot) => slot.explicit)).toEqual([true, false]);
    const before = await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 1 } } });
    await f.loop.advanceTo(100);
    expect(
      (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 1 } } })).agriculture,
    ).toBe(before.agriculture);
    const restarted = new TurnLoop(db, f.lease);
    await restarted.advanceTo(10100);
    expect(
      (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 1 } } })).agriculture,
    ).toBeGreaterThan(before.agriculture);
    const home = await rpc<{ turnsPreview: PolicySlot[]; general: { policy: { key: string } } }>(
      'home.get',
      { worldId: f.worldId },
      f.alice.cookie,
    );
    expect(home.data!.general.policy.key).toBe('farm');
    expect(home.data!.turnsPreview.every((slot) => slot.explicit === false)).toBe(true);
    await restarted.advanceTo(120000);
    const archive = await exportReplay(db, f.worldId);
    expect(archive.version).toBe(5);
    expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).userId).toBe(
      f.alice.id,
    );
  }),
);

it(
  '조회·STALE는 활동이 아니고 shift·repeat·재시작 뒤에도 explicit을 유지한다',
  authzCase('general.policy', 'success', async () => {
    const f = await fixture();
    await f.loop.advanceTo(50);
    const slots = Array.from({ length: 30 }, (_, i) =>
      i === 0 ? { commandKey: 'rest' } : i === 2 ? { commandKey: 'commerce' } : null,
    );
    let saved = await rpc<Slots>('turns.set', { worldId: f.worldId, revision: 0, slots }, f.alice.cookie, true);
    await f.loop.advanceTo(60);
    const active = (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } }))
      .lastActiveTick;
    const stale = await rpc<Slots>('turns.set', { worldId: f.worldId, revision: 0, slots }, f.alice.cookie, true);
    expect(stale.data).toMatchObject({ ok: false, reason: 'STALE' });
    expect(stale.data!.slots[0]!.explicit).toBe(true);
    const policy = await rpc('general.policy', { worldId: f.worldId }, f.alice.cookie);
    expect(policy.data).toMatchObject({ current: 'none', pending: null, inactiveAfterDays: 14 });
    expect(
      (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).lastActiveTick,
    ).toBe(active);
    saved = await rpc<Slots>(
      'turns.edit',
      { worldId: f.worldId, revision: saved.data!.revision, op: { shift: -1 } },
      f.alice.cookie,
      true,
    );
    expect(saved.data!.slots.slice(0, 2).map((slot) => slot.explicit)).toEqual([false, true]);
    saved = await rpc<Slots>(
      'turns.edit',
      { worldId: f.worldId, revision: saved.data!.revision, op: { repeat: { from: 0, to: 1, times: 1 } } },
      f.alice.cookie,
      true,
    );
    expect(saved.data!.slots.slice(0, 4).map((slot) => slot.explicit)).toEqual([false, true, false, true]);
    await new TurnLoop(db, f.lease).advanceTo(100);
    const read = await rpc<Slots>('turns.get', { worldId: f.worldId }, f.alice.cookie);
    expect(read.data!.slots.slice(0, 3).map((slot) => slot.explicit)).toEqual([true, false, true]);
    expect(read.data!.slots[29]!.explicit).toBe(false);
  }),
);

for (const path of ['general.policy', 'general.setPolicy'])
  for (const category of ['unauthenticated', 'otherUser', 'sanctioned', 'invalidInput'] as const) {
    it(
      `${path} ${category} 실제 HTTP 거부`,
      authzCase(path, category, async () => {
        const f = await fixture();
        const outsider =
          category === 'otherUser' ? await user() : category === 'sanctioned' ? await user('SANCTIONED') : f.alice;
        const input =
          category === 'invalidInput'
            ? { worldId: f.worldId, policy: 'attack', unexpected: true }
            : { worldId: f.worldId, ...(path === 'general.setPolicy' ? { policy: 'farm' } : {}) };
        const before = await db.inputEvent.count({ where: { worldId: f.worldId } });
        const response = await rpc(
          path,
          input,
          category === 'unauthenticated' ? undefined : outsider.cookie,
          path === 'general.setPolicy',
        );
        expect(response.error).toBe(
          category === 'otherUser' ? 'NOT_FOUND' : category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED',
        );
        expect(await db.inputEvent.count({ where: { worldId: f.worldId } })).toBe(before);
        if (category === 'otherUser') {
          const injected = await rpc(
            path,
            { worldId: f.worldId, generalId: 1, ...(path === 'general.setPolicy' ? { policy: 'farm' } : {}) },
            outsider.cookie,
            path === 'general.setPolicy',
          );
          expect(injected.error).toBe('BAD_REQUEST');
          expect(await db.inputEvent.count({ where: { worldId: f.worldId } })).toBe(before);
        }
      }),
    );
  }

it('같은 방침 중복은 입력 하나이고 다른 값은 충돌하며 5초 뒤 pending 재조회로 확인한다', async () => {
  const f = await fixture();
  const first = rpc('general.setPolicy', { worldId: f.worldId, policy: 'farm' }, f.alice.cookie, true);
  await expect.poll(() => db.inputEvent.count({ where: { worldId: f.worldId, kind: 'general.setPolicy' } })).toBe(1);
  const second = rpc('general.setPolicy', { worldId: f.worldId, policy: 'farm' }, f.alice.cookie, true);
  const conflict = await rpc('general.setPolicy', { worldId: f.worldId, policy: 'commerce' }, f.alice.cookie, true);
  expect(conflict.error).toBe('CONFLICT');
  expect((await first).data).toEqual({ status: 'pending' });
  expect((await second).data).toEqual({ status: 'pending' });
  expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: 'general.setPolicy' } })).toBe(1);
  expect((await rpc('general.policy', { worldId: f.worldId }, f.alice.cookie)).data).toMatchObject({
    current: 'none',
    pending: 'farm',
  });
  await f.loop.advanceTo(0);
  expect((await rpc('general.policy', { worldId: f.worldId }, f.alice.cookie)).data).toMatchObject({
    current: 'farm',
    pending: null,
  });
});

it('엔진 제재 거절은 상태·활동을 바꾸지 않고 이유를 재조회하며 세션 만료도 결과를 숨긴다', async () => {
  const f = await fixture();
  const request = rpc('general.setPolicy', { worldId: f.worldId, policy: 'farm' }, f.alice.cookie, true);
  await expect.poll(() => db.inputEvent.count({ where: { worldId: f.worldId, status: 'PENDING' } })).toBe(1);
  await db.user.update({ where: { id: f.alice.id }, data: { status: 'SANCTIONED' } });
  await f.loop.advanceTo(0);
  expect((await request).error).toBe('UNAUTHORIZED');
  await db.user.update({ where: { id: f.alice.id }, data: { status: 'ACTIVE' } });
  expect((await rpc('general.policy', { worldId: f.worldId }, f.alice.cookie)).data).toMatchObject({
    current: 'none',
    lastRejected: { policy: 'farm', reason: 'ACTOR_INACTIVE' },
  });
  const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
  expect(general.lastActiveTick).toBe(0);
  expect(general.lastActiveAt).toBeNull();
  const pending = rpc('general.setPolicy', { worldId: f.worldId, policy: 'farm' }, f.alice.cookie, true);
  await expect.poll(() => db.inputEvent.count({ where: { worldId: f.worldId, status: 'PENDING' } })).toBe(1);
  await db.session.delete({ where: { id: f.alice.sessionId } });
  await f.loop.advanceTo(0);
  expect((await pending).error).toBe('UNAUTHORIZED');
});

it('로그인은 여러 월드 활동을 중복 없이 접수하고 ENDED와 실패·조회는 활동이 아니다', async () => {
  const f = await fixture();
  const initial = commandInitial();
  initial.generals = [{ ...initial.generals[0]!, userId: f.alice.id }];
  const other = await saveInitialWorld(db, initial, { name: '다른 활동 월드', turnTermMinutes: 60, endYear: null });
  const ended = await saveInitialWorld(db, initial, { name: '끝난 활동 월드', turnTermMinutes: 60, endYear: null });
  worlds.push(other.worldId, ended.worldId);
  await db.world.update({ where: { id: ended.worldId }, data: { status: 'ENDED' } });
  const login = { email: f.alice.email, password };
  await Promise.all([rpc('auth.login', login, undefined, true), rpc('auth.login', login, undefined, true)]);
  for (const worldId of [f.worldId, other.worldId])
    expect(await db.inputEvent.count({ where: { worldId, kind: 'general.active', status: 'PENDING' } })).toBe(1);
  expect(await db.inputEvent.count({ where: { worldId: ended.worldId } })).toBe(0);
  const before = await db.inputEvent.count({ where: { userId: f.alice.id, kind: 'general.active' } });
  await rpc('auth.login', { ...login, password: randomUUID() }, undefined, true);
  await rpc('general.policy', { worldId: f.worldId }, f.alice.cookie);
  expect(await db.inputEvent.count({ where: { userId: f.alice.id, kind: 'general.active' } })).toBe(before);
  await f.loop.advanceTo(50);
  expect(
    (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).lastActiveTick,
  ).toBe(50);
  expect((await rpc('general.setPolicy', { worldId: ended.worldId, policy: 'farm' }, f.alice.cookie, true)).error).toBe(
    'PRECONDITION_FAILED',
  );
});

it('방침 실패는 같은 턴에서 비용 없이 휴식하고 실제 장수 로그에 이유를 남긴다', async () => {
  const f = await fixture({ farmMax: true });
  await appliedPolicy(f, 'farm');
  const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
  await f.loop.advanceTo(100);
  const after = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
  expect(after.gold).toBe(before.gold);
  expect(after.injury).toBeLessThan(before.injury);
  const log = await db.generalLog.findUniqueOrThrow({
    where: { worldId_generalId_tick: { worldId: f.worldId, generalId: 1, tick: 100 } },
  });
  expect(log.commandKey).toBe('rest');
  expect(log.text).toContain('AT_MAX');
});

it('활동과 방침을 id 순으로 집행하며 commit 실패는 상태·결과·sequence를 함께 되돌린다', async () => {
  const f = await fixture();
  await rpc('auth.login', { email: f.alice.email, password }, undefined, true);
  const request = rpc('general.setPolicy', { worldId: f.worldId, policy: 'farm' }, f.alice.cookie, true);
  await expect.poll(() => db.inputEvent.count({ where: { worldId: f.worldId, status: 'PENDING' } })).toBe(2);
  const failing = new TurnLoop(db, f.lease, {
    beforeCommit: async () => {
      throw new Error('시험 commit 중단');
    },
  });
  await expect(failing.advanceTo(50)).rejects.toThrow('시험 commit 중단');
  expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence).toBe(0);
  expect(await db.inputEvent.count({ where: { worldId: f.worldId, status: 'PENDING' } })).toBe(2);
  expect(
    (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).lastActiveAt,
  ).toBeNull();
  await f.loop.advanceTo(50);
  expect((await request).data).toMatchObject({ status: 'applied' });
  const events = await db.inputEvent.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  expect(events.map((event) => [event.kind, event.sequence, event.status])).toEqual([
    ['general.active', 1, 'APPLIED'],
    ['general.setPolicy', 2, 'APPLIED'],
  ]);
});
