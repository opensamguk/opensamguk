import { BATTLE_TACTICS_FEATURE } from '../packages/rules/src/battle/tactics';
import { CITY_CONFLICT_FEATURE } from '../packages/rules/src/battle/cityConflict';
import { MILITARY_STAT_GROWTH_FEATURE, STAT_GROWTH_FEATURE } from '../packages/rules/src/general/statGrowth';
import { WAR_INCOME_FEATURE } from '../packages/rules/src/monthly/warIncome';
import { TROOP_FEATURE } from '../packages/rules/src/commands/ext/troop/state';
import { COMBAT_SPECIALTY_FEATURE } from '../packages/rules/src/general/combatSpecialty';
import { BALANCE } from '../packages/rules/src/balance';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { DEFENSE_STANCE_FEATURE, DEFENSE_STANCE_KIND } from '../packages/rules/src/battle/defenders';
import {
  NATION_RESTRICTIONS_FEATURE,
  NATION_RESTRICTIONS_KIND,
} from '../packages/rules/src/personnel/nationRestrictions';
import { NPC_NATION_POLICY_FEATURE, NPC_NATION_POLICY_KIND } from '../packages/rules/src/npc/policy';
import {
  NATION_FINANCE_FEATURE,
  NATION_FINANCE_KIND,
  RANKED_PAYROLL_FEATURE,
  WALL_INCOME_FEATURE,
} from '../packages/rules/src/personnel/financeRates';
import type { PolicyKey, PolicySlot } from '../packages/rules/src/policy';
import { GENERAL_PROFICIENCY_FEATURE } from '../packages/rules/src/general/proficiency';
import { DOMESTIC_SPECIALTY_FEATURE } from '../packages/rules/src/general/domesticSpecialty';
import { GENERAL_PERSONALITY_FEATURE } from '../packages/rules/src/general/personality';
import { INACTIVE_REMOVAL_FEATURE, inactiveRemovalTick } from '../packages/rules/src/policy/inactiveRemoval';
import { PLAYER_AUTOPLAY_FEATURE } from '../packages/rules/src/policy';
import { commandInitial, testUnits } from '../packages/rules/test/commandFixture';
import { renewLeaseDuringTest } from '../apps/engine/test/leaseHeartbeat';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { loadReplayState } from '../apps/engine/src/monthly';
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
async function fixture(
  options: {
    farmMax?: boolean;
    npc?: boolean;
    defense?: boolean;
    npcPolicy?: boolean;
    restrictions?: boolean;
    finance?: boolean;
    rankedPayroll?: boolean;
    wallIncome?: boolean;
  } = {},
) {
  const alice = await user(),
    bob = await user();
  const initial = commandInitial();
  if (options.farmMax) initial.cities[0]!.agriculture = initial.cities[0]!.agricultureMax;
  if (options.wallIncome) initial.cities[0]!.defence = 300;
  initial.generals = initial.generals.slice(0, 2).map((general, i) => ({
    ...general,
    userId: i ? (options.npc ? null : bob.id) : alice.id,
    ...(options.rankedPayroll
      ? { nationId: 1, officerLevel: i ? 1 : general.officerLevel, dedication: i ? 0 : 10000 }
      : {}),
    nextTurnTick: i ? 5000 : 100,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '방침 실제 HTTP',
    turnTermMinutes: 30,
    endYear: null,
    // 이 회귀 시험은 archive 5와 기존 전환 표지 계약을 검증한다.
    ...(options.defense || options.npcPolicy || options.restrictions || options.finance
      ? {
          replayFormat: 3,
          ruleFeatures: [
            options.defense
              ? DEFENSE_STANCE_FEATURE
              : options.npcPolicy
                ? NPC_NATION_POLICY_FEATURE
                : options.finance
                  ? NATION_FINANCE_FEATURE
                  : NATION_RESTRICTIONS_FEATURE,
            'policy',
            ...(options.rankedPayroll ? [RANKED_PAYROLL_FEATURE] : []),
            ...(options.wallIncome ? [WALL_INCOME_FEATURE] : []),
          ],
        }
      : { replayFormat: 'policy' }),
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
  const other = await saveInitialWorld(db, initial, {
    name: '다른 활동 월드',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'policy',
  });
  const ended = await saveInitialWorld(db, initial, {
    name: '끝난 활동 월드',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'policy',
  });
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
  const sequence = (await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence;
  const log = await db.generalLog.findFirstOrThrow({
    where: { worldId: f.worldId, generalId: 1, tick: 100, sequence },
  });
  expect(log.commandKey).toBe('rest');
  expect(log.text).toBe('기본 방침 실패: 이미 최대치입니다. → 휴식');
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

it('방침 월드에서 HTTP 장수 생성 뒤 빈칸·활동과 archive5의 12개월 재생이 일치한다', async () => {
  const f = await fixture();
  const newcomer = await user();
  const request = rpc(
    'general.create',
    { worldId: f.worldId, name: '새방침장수', leadership: 70, strength: 65, intel: 65, portraitId: 10001 },
    newcomer.cookie,
    true,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId: f.worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  await f.loop.advanceTo(0);
  expect((await request).data).toMatchObject({ status: 'created' });
  const general = await db.general.findUniqueOrThrow({
    where: { worldId_userId: { worldId: f.worldId, userId: newcomer.id } },
  });
  expect(general).toMatchObject({ defaultPolicy: 'none', lastActiveTick: 0, userId: newcomer.id });
  expect(general.lastActiveAt).not.toBeNull();
  expect(await db.generalTurn.count({ where: { worldId: f.worldId, generalId: general.id, explicit: false } })).toBe(
    30,
  );
  await f.loop.advanceTo(120000);
  const archive = await exportReplay(db, f.worldId);
  expect(archive.version).toBe(5);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('방침 월드 NPC는 빈칸에서도 AI를 실행하고 12개월 실제 엔진과 재생이 일치한다', async () => {
  const f = await fixture({ npc: true });
  renewLeaseDuringTest(db, f.lease);
  expect(await db.generalTurn.count({ where: { worldId: f.worldId, generalId: 2, explicit: false } })).toBe(30);
  await f.loop.advanceTo(5000);
  const sequence = (await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).actionSequence;
  const log = await db.generalLog.findFirstOrThrow({
    where: { worldId: f.worldId, generalId: 2, tick: 5000, sequence },
  });
  expect(log.commandKey).not.toBe('rest');
  expect(log.text).not.toContain('기본 방침');
  const npc = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 2 } } });
  expect(npc.userId).toBeNull();
  expect(npc.lastActiveTick).toBeNull();
  await f.loop.advanceTo(120000);
  const archive = await exportReplay(db, f.worldId);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

async function legacyWorld(f: Awaited<ReturnType<typeof fixture>>, marker: boolean) {
  await db.world.update({ where: { id: f.worldId }, data: { policyFromSequence: null } });
  await db.general.updateMany({
    where: { worldId: f.worldId },
    data: { defaultPolicy: null, lastActiveTick: null, lastActiveAt: null },
  });
  if (!marker) await db.generalTurn.updateMany({ where: { worldId: f.worldId }, data: { explicit: true } });
  else
    await db.inputEvent.create({
      data: {
        worldId: f.worldId,
        userId: 'system:policy',
        kind: 'system.policy.enable',
        idempotencyKey: 'system.policy.enable:5',
        payload: { version: 5, emptySlots: [1, 2] },
      },
    });
}
async function refusedWrites(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [path, input] of [
    ['turns.set', { revision: 0, slots: Array.from({ length: 30 }, () => null) }],
    ['turns.edit', { revision: 0, op: { shift: 1 } }],
    ['general.setPolicy', { policy: 'farm' }],
  ] as const)
    expect((await rpc(path, { worldId: f.worldId, ...input }, f.alice.cookie, true)).error).toBe('PRECONDITION_FAILED');
  expect((await rpc<Slots>('turns.get', { worldId: f.worldId }, f.alice.cookie)).data!.slots).toHaveLength(30);
}

it('정상 T 전환 뒤 로그인·생성을 순서대로 처리하고 실제 예턴 저장만 활동을 남긴다', async () => {
  const f = await fixture();
  renewLeaseDuringTest(db, f.lease);
  await legacyWorld(f, true);
  await refusedWrites(f);
  await rpc('auth.login', { email: f.alice.email, password }, undefined, true);
  await db.inputEvent.create({
    data: { worldId: f.worldId, userId: f.bob.id, kind: 'general.create', idempotencyKey: randomUUID(), payload: {} },
  });
  expect((await f.loop.advanceTo(60000)).length).toBeGreaterThan(0);
  const inputs = await db.inputEvent.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  expect(inputs.slice(0, 3)).toMatchObject([
    { kind: 'system.policy.enable', status: 'APPLIED', sequence: 1, result: { clockTick: 0, baselineActiveTick: 0 } },
    { kind: 'general.active', status: 'APPLIED', sequence: 2, result: { activeTick: 60000 } },
    { kind: 'general.create', status: 'REJECTED', sequence: 3, result: { code: 'ALREADY_EXISTS' } },
  ]);
  expect(await db.inputEvent.count({ where: { worldId: f.worldId, status: 'PENDING' } })).toBe(0);
  expect(await db.yearbookSnapshot.count({ where: { worldId: f.worldId } })).toBe(6);
  const actor = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
  expect(await actor()).toMatchObject({ lastActiveTick: 60000, lastActiveAt: inputs[1]!.createdAt });
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 2 } } })).toMatchObject({
    lastActiveTick: 0,
    lastActiveAt: null,
  });
  expect(await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).toMatchObject({
    policyFromSequence: 1,
    clockTick: 60000,
  });
  await rpc('auth.login', { email: f.alice.email, password }, undefined, true);
  await f.loop.advanceTo(60000);
  const nextLogin = await db.inputEvent.findFirstOrThrow({
    where: { worldId: f.worldId, kind: 'general.active' },
    orderBy: { id: 'desc' },
  });
  expect(nextLogin).toMatchObject({ status: 'APPLIED', result: { activeTick: 60000 } });
  expect(await actor()).toMatchObject({ lastActiveTick: 60000, lastActiveAt: nextLogin.createdAt });
  const revision = (await rpc<Slots>('turns.get', { worldId: f.worldId }, f.alice.cookie)).data!.revision;
  expect(revision).toBe(6);
  const slots = Array.from({ length: 30 }, () => null);
  const saved = await rpc<Slots>('turns.set', { worldId: f.worldId, revision, slots }, f.alice.cookie, true);
  expect(saved.data).toMatchObject({ ok: true, revision: revision + 1 });
  const editEvent = await db.inputEvent.findFirstOrThrow({
    where: { worldId: f.worldId, kind: 'turns.set' },
    orderBy: { id: 'desc' },
  });
  expect(await actor()).toMatchObject({ lastActiveTick: 60000, lastActiveAt: editEvent.createdAt });
  const stale = await rpc<Slots>('turns.set', { worldId: f.worldId, revision, slots }, f.alice.cookie, true);
  expect(stale.data).toMatchObject({ ok: false, reason: 'STALE' });
  expect(await actor()).toMatchObject({ lastActiveTick: 60000, lastActiveAt: editEvent.createdAt });
  expect((await rpc('general.policy', { worldId: f.worldId }, f.alice.cookie)).data).toMatchObject({
    current: 'none',
    pending: null,
    lastRejected: null,
  });
});

it('표지가 없는 옛 월드는 쓰기를 거부하되 기존 생성·직접 휴식·옛 큐 모양을 보존한다', async () => {
  const f = await fixture();
  await legacyWorld(f, false);
  await refusedWrites(f);
  const newcomer = await user();
  const request = rpc(
    'general.create',
    { worldId: f.worldId, name: '옛생성장수', leadership: 70, strength: 65, intel: 65, portraitId: 10001 },
    newcomer.cookie,
    true,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId: f.worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  let sequence: number | undefined;
  await new TurnLoop(db, f.lease, {
    beforeCommit: async (tx) => {
      if (sequence !== undefined) return;
      const general = await tx.general.findUniqueOrThrow({
        where: { worldId_id: { worldId: f.worldId, id: 1 } },
        select: { nextTurnTick: true, world: { select: { actionSequence: true } } },
      });
      if (general.nextTurnTick === 10100) sequence = general.world.actionSequence;
    },
  }).advanceTo(100);
  expect(sequence).toBeTypeOf('number');
  expect((await request).data).toMatchObject({ status: 'created' });
  const general = await db.general.findUniqueOrThrow({
    where: { worldId_userId: { worldId: f.worldId, userId: newcomer.id } },
  });
  expect(general).toMatchObject({ defaultPolicy: null, lastActiveTick: null, lastActiveAt: null });
  expect(await db.generalTurn.count({ where: { worldId: f.worldId, generalId: general.id, explicit: true } })).toBe(30);
  expect(
    await db.generalLog.findFirstOrThrow({
      where: { worldId: f.worldId, generalId: 1, tick: 100, sequence: sequence! },
    }),
  ).toMatchObject({ commandKey: 'rest' });
  const replay = await db.$transaction((tx) => loadReplayState(tx, f.worldId));
  expect(replay).not.toHaveProperty('policy');
  expect(
    Object.values(replay.turns)
      .flat()
      .every((slot) => !Object.hasOwn(slot, 'explicit')),
  ).toBe(true);
  const input = await db.inputEvent.findFirstOrThrow({ where: { worldId: f.worldId, kind: 'general.create' } });
  expect(input.result).not.toHaveProperty('activeTick');
});

it(
  '수비 기준을 접수하고 엔진이 적용한 뒤 실제 홈 조회와 재생에 반영한다',
  authzCase(DEFENSE_STANCE_KIND, 'success', async () => {
    const f = await fixture({ defense: true });
    const input = { worldId: f.worldId, threshold: 999 };
    const request = () => rpc(DEFENSE_STANCE_KIND, input, f.alice.cookie, true);
    const home = () => rpc('home.get', { worldId: f.worldId }, f.alice.cookie);
    expect((await home()).data).toMatchObject({
      general: {
        defense: { minimumTraining: 80, minimumMorale: 80, stance: { enabled: true, pendingThreshold: null } },
      },
    });
    expect((await request()).data).toEqual({ status: 'pending' });
    expect((await request()).data).toEqual({ status: 'pending' });
    expect((await rpc(DEFENSE_STANCE_KIND, { ...input, threshold: 60 }, f.alice.cookie, true)).error).toBe('CONFLICT');
    expect((await home()).data).toMatchObject({
      general: { defense: { stance: { enabled: true, pendingThreshold: 999 } } },
    });
    expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: DEFENSE_STANCE_KIND } })).toBe(1);
    await f.loop.advanceTo(0);
    expect((await home()).data).toMatchObject({
      general: { defense: { participating: false, stance: { enabled: false, pendingThreshold: null } } },
    });
    await f.loop.advanceTo(10000);
    const archive = await exportReplay(db, f.worldId);
    expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  }),
);

for (const category of ['unauthenticated', 'otherUser', 'sanctioned', 'invalidInput'] as const) {
  it(
    `수비 기준 접근 경계 ${category}`,
    authzCase(DEFENSE_STANCE_KIND, category, async () => {
      const f = await fixture({ defense: true });
      const actor =
        category === 'otherUser' ? await user() : category === 'sanctioned' ? await user('SANCTIONED') : f.alice;
      const result = await rpc(
        DEFENSE_STANCE_KIND,
        { worldId: f.worldId, threshold: category === 'invalidInput' ? 70 : 60 },
        category === 'unauthenticated' ? undefined : actor.cookie,
        true,
      );
      expect(result.error).toBe(
        {
          unauthenticated: 'UNAUTHORIZED',
          otherUser: 'NOT_FOUND',
          sanctioned: 'UNAUTHORIZED',
          invalidInput: 'BAD_REQUEST',
        }[category],
      );
      expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: DEFENSE_STANCE_KIND } })).toBe(0);
    }),
  );
}

const editedNpcPolicy = {
  recruitTarget: 4000,
  trainingTarget: 85,
  moraleTarget: 75,
  rewardGoldTarget: 12000,
  rewardRiceTarget: 3000,
  reserveRice: 5000,
  seizeGoldAbove: 18000,
  seizeRiceAbove: 9000,
  minRecruitPopulation: 9000,
  safeRecruitPopulationPercent: 15,
  reserveGold: 500,
  minReward: 250,
  maxReward: 5000,
  minWarCrew: 1500,
  minNpcWarLeadership: 40,
  cureThreshold: 10,
  generalPriority: ['recruit', 'farm'],
  nationPriority: ['nation_reward'],
};

it('국가 세율·지급률을 예산 예상과 실제 월말 정산에 적용한다', async () => {
  const f = await fixture({ finance: true });
  const input = { worldId: f.worldId, nationId: 1, rates: { taxPercent: 30, salaryPercent: 200 } };
  const request = (body: unknown, cookie?: string) => rpc(NATION_FINANCE_KIND, body, cookie, true);
  const query = () =>
    rpc<{ financeEstimate: { gold: { gross: number; net: number; perGeneral: number } } }>(
      'nation.get',
      { worldId: f.worldId, nationId: 1 },
      f.alice.cookie,
    );
  await authzCase(NATION_FINANCE_KIND, 'unauthenticated', async () => {
    expect((await request(input)).error).toBe('UNAUTHORIZED');
  })();
  await authzCase(NATION_FINANCE_KIND, 'otherUser', async () => {
    expect((await request(input, f.bob.cookie)).error).toBe('FORBIDDEN');
  })();
  await authzCase(NATION_FINANCE_KIND, 'sanctioned', async () => {
    expect((await request(input, (await user('SANCTIONED')).cookie)).error).toBe('UNAUTHORIZED');
  })();
  await authzCase(NATION_FINANCE_KIND, 'invalidInput', async () => {
    expect((await request({ ...input, rates: { taxPercent: 31, salaryPercent: 200 } }, f.alice.cookie)).error).toBe(
      'BAD_REQUEST',
    );
  })();
  await authzCase(NATION_FINANCE_KIND, 'success', async () => {
    const before = (await query()).data!.financeEstimate.gold.gross;
    expect((await request(input, f.alice.cookie)).data).toEqual({ status: 'pending' });
    expect((await request(input, f.alice.cookie)).data).toEqual({ status: 'pending' });
    expect((await query()).data).toMatchObject({ financeEditor: { pending: input.rates } });
    await f.loop.advanceTo(0);
    const result = await query();
    expect(result.data).toMatchObject({ taxRate: 0.3, salaryRate: 2, financeEditor: { pending: null } });
    const gold = result.data!.financeEstimate.gold;
    expect(gold.gross).toBeGreaterThan(before);
    expect(gold.net).toBeLessThan(0);
    await f.loop.advanceTo(9999);
    const where = { worldId_id: { worldId: f.worldId, id: 1 } };
    const treasury = await db.nation.findUniqueOrThrow({ where });
    const general = await db.general.findUniqueOrThrow({ where });
    await f.loop.advanceTo(10000);
    expect((await db.nation.findUniqueOrThrow({ where })).gold).toBe(treasury.gold + gold.net);
    expect((await db.general.findUniqueOrThrow({ where })).gold).toBe(general.gold + gold.perGeneral);
    const archive = await exportReplay(db, f.worldId);
    expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  })();
});

it('둔전 쌀이 도시·국가 전망과 실제 4월 월말 재생에 반영된다', async () => {
  const f = await fixture({ finance: true, wallIncome: true });
  await f.loop.advanceTo(39999);
  const city = await rpc<{ incomeEstimate: { rice: { wallIncome: number } } }>(
    'city.get',
    { worldId: f.worldId, cityKey: 1 },
    f.alice.cookie,
  );
  const nation = await rpc<{ financeEstimate: { rice: { wallIncome: number; net: number } } }>(
    'nation.get',
    { worldId: f.worldId, nationId: 1 },
    f.alice.cookie,
  );
  const estimate = nation.data!.financeEstimate.rice;
  expect(estimate.wallIncome).toBeGreaterThan(0);
  expect(city.data!.incomeEstimate.rice.wallIncome).toBeGreaterThan(0);
  const where = { worldId_id: { worldId: f.worldId, id: 1 } };
  const before = await db.nation.findUniqueOrThrow({ where });
  await f.loop.advanceTo(40000);
  expect((await db.nation.findUniqueOrThrow({ where })).rice).toBe(before.rice + estimate.net);
  const archive = await exportReplay(db, f.worldId);
  expect(replayArchive(archive, 4)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('공헌도별 지급액을 장수에게 예고하고 같은 금액을 월말에 지급한다', async () => {
  const f = await fixture({ finance: true, rankedPayroll: true });
  const home = async (cookie: string) =>
    (await rpc<{ general: { salaryEstimate: { gold: number } } }>('home.get', { worldId: f.worldId }, cookie)).data!
      .general.salaryEstimate.gold;
  await f.loop.advanceTo(9999);
  const estimates = await Promise.all([home(f.alice.cookie), home(f.bob.cookie)]);
  expect(estimates[0]).toBeGreaterThan(estimates[1]!);
  const generals = () => db.general.findMany({ where: { worldId: f.worldId }, orderBy: { id: 'asc' } });
  const before = await generals();
  await f.loop.advanceTo(10000);
  expect((await generals()).map((general, index) => general.gold - before[index]!.gold)).toEqual(estimates);
  const archive = await exportReplay(db, f.worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('국가 게시판과 기밀실을 현재 소속·직책으로 분리한다', async () => {
  const f = await fixture();
  const member = await user();
  await db.general.update({
    where: { worldId_id: { worldId: f.worldId, id: 2 } },
    data: { userId: member.id, nationId: 1, officerLevel: 1 },
  });
  await db.general.create({
    data: { ...commandInitial().generals[2]!, worldId: f.worldId, id: 3, userId: f.bob.id, nationId: 2 },
  });
  const board = { worldId: f.worldId, nationId: 1, confidential: false };
  const secret = { ...board, confidential: true };
  const content = { type: 'post', title: '군량 회의', body: '이번 달 보급 계획' };
  const write = (input: unknown, cookie?: string) => rpc<{ id: string }>('nationBoard.write', input, cookie, true);
  const list = (input: unknown, cookie?: string) => rpc('nationBoard.list', input, cookie);
  let postId = '';
  await authzCase('nationBoard.write', 'success', async () => {
    const created = await write({ ...board, content }, f.alice.cookie);
    expect(created.status).toBe(200);
    postId = created.data!.id;
    expect(
      (await write({ ...board, content: { type: 'reply', postId, body: '알겠습니다' } }, member.cookie)).status,
    ).toBe(200);
    expect((await write({ ...secret, content: { ...content, title: '기밀 작전' } }, f.alice.cookie)).status).toBe(200);
  })();
  await authzCase('nationBoard.list', 'success', async () => {
    expect((await list(board, member.cookie)).data).toMatchObject({
      canReadConfidential: false,
      items: [
        { id: postId, title: content.title, authorName: '장수1', replyCount: 1, replies: [{ body: '알겠습니다' }] },
      ],
    });
    expect((await list(secret, f.alice.cookie)).data).toMatchObject({ items: [{ title: '기밀 작전' }] });
  })();
  await authzCase('nationBoard.list', 'otherUser', async () => {
    expect((await list(secret, member.cookie)).error).toBe('FORBIDDEN');
    expect((await list(board, f.bob.cookie)).error).toBe('FORBIDDEN');
  })();
  await authzCase('nationBoard.write', 'otherUser', async () => {
    expect((await write({ ...secret, content }, member.cookie)).error).toBe('FORBIDDEN');
    expect(
      (await write({ ...secret, content: { type: 'reply', postId, body: '다른 범위' } }, f.alice.cookie)).error,
    ).toBe('NOT_FOUND');
    expect((await write({ ...board, content }, f.bob.cookie)).error).toBe('FORBIDDEN');
  })();
  const sanctioned = await user('SANCTIONED');
  const older = (input: unknown, cookie?: string) => rpc('nationBoard.replies', input, cookie);
  const replies = await db.nationBoardReply.createManyAndReturn({
    data: Array.from({ length: 21 }, (_, index) => ({
      postId,
      authorName: '장수1',
      body: `댓글 ${index + 1}`,
      sentAt: new Date(1000 + index),
    })),
  });
  const olderInput = { ...board, postId, cursor: replies.find((row) => row.body === '댓글 3')!.id };
  await authzCase('nationBoard.replies', 'success', async () => {
    expect((await older(olderInput, member.cookie)).data).toMatchObject({
      items: [{ body: '댓글 1' }, { body: '댓글 2' }],
      next: null,
    });
  })();
  await authzCase('nationBoard.replies', 'otherUser', async () => {
    expect((await older(olderInput, f.bob.cookie)).error).toBe('FORBIDDEN');
    expect((await older({ ...olderInput, confidential: true }, f.alice.cookie)).error).toBe('NOT_FOUND');
  })();
  for (const path of ['nationBoard.list', 'nationBoard.write', 'nationBoard.replies'] as const) {
    const call = path === 'nationBoard.list' ? list : path === 'nationBoard.write' ? write : older;
    const input =
      path === 'nationBoard.list' ? board : path === 'nationBoard.write' ? { ...board, content } : olderInput;
    await authzCase(path, 'unauthenticated', async () => {
      expect((await call(input)).error).toBe('UNAUTHORIZED');
    })();
    await authzCase(path, 'sanctioned', async () => {
      expect((await call(input, sanctioned.cookie)).error).toBe('UNAUTHORIZED');
    })();
    await authzCase(path, 'invalidInput', async () => {
      expect((await call({ ...input, confidential: 'false' }, f.alice.cookie)).error).toBe('BAD_REQUEST');
    })();
  }
});

it(
  '군주의 NPC 운영 기준을 다음 엔진 처리에 적용하고 재생한다',
  authzCase(NPC_NATION_POLICY_KIND, 'success', async () => {
    const f = await fixture({ npcPolicy: true });
    const input = { worldId: f.worldId, nationId: 1, policy: editedNpcPolicy };
    const query = () => rpc('nation.get', { worldId: f.worldId, nationId: 1 }, f.alice.cookie);
    expect((await query()).data).toMatchObject({ npcPolicy: { recruitTarget: 2000, editor: { pending: null } } });
    const request = () => rpc(NPC_NATION_POLICY_KIND, input, f.alice.cookie, true);
    expect((await request()).data).toEqual({ status: 'pending' });
    expect((await request()).data).toEqual({ status: 'pending' });
    expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: NPC_NATION_POLICY_KIND } })).toBe(1);
    expect((await query()).data).toMatchObject({
      npcPolicy: { recruitTarget: 2000, editor: { pending: editedNpcPolicy } },
    });
    await f.loop.advanceTo(0);
    expect((await query()).data).toMatchObject({
      npcPolicy: {
        ...editedNpcPolicy,
        editor: { pending: null },
        history: [{ sequence: expect.any(Number), generalName: '장수1', previous: null, current: editedNpcPolicy }],
      },
    });
    const nextPolicy = { ...editedNpcPolicy, trainingTarget: 90 };
    expect((await rpc(NPC_NATION_POLICY_KIND, { ...input, policy: nextPolicy }, f.alice.cookie, true)).data).toEqual({
      status: 'pending',
    });
    await f.loop.advanceTo(0);
    expect((await query()).data).toMatchObject({
      npcPolicy: { history: [{ previous: editedNpcPolicy, current: nextPolicy }, { previous: null }] },
    });
    expect((await rpc('nation.get', { worldId: f.worldId, nationId: 1 }, f.bob.cookie)).data).not.toHaveProperty(
      'npcPolicy',
    );
    await f.loop.advanceTo(10000);
    const archive = await exportReplay(db, f.worldId);
    expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  }),
);

for (const category of ['unauthenticated', 'otherUser', 'sanctioned', 'invalidInput'] as const) {
  it(
    `NPC 운영 기준 권한 ${category}`,
    authzCase(NPC_NATION_POLICY_KIND, category, async () => {
      const f = await fixture({ npcPolicy: true });
      const actor = category === 'otherUser' ? f.bob : category === 'sanctioned' ? await user('SANCTIONED') : f.alice;
      const result = await rpc(
        NPC_NATION_POLICY_KIND,
        {
          worldId: f.worldId,
          nationId: 1,
          policy: { ...editedNpcPolicy, trainingTarget: category === 'invalidInput' ? 101 : 85 },
        },
        category === 'unauthenticated' ? undefined : actor.cookie,
        true,
      );
      expect(result.error).toBe(
        {
          unauthenticated: 'UNAUTHORIZED',
          otherUser: 'FORBIDDEN',
          sanctioned: 'UNAUTHORIZED',
          invalidInput: 'BAD_REQUEST',
        }[category],
      );
      expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: NPC_NATION_POLICY_KIND } })).toBe(0);
    }),
  );
}

it(
  '수뇌가 임관을 막으면 공개 조회와 다음 엔진 재생에 반영한다',
  authzCase(NATION_RESTRICTIONS_KIND, 'success', async () => {
    const f = await fixture({ restrictions: true });
    const input = { worldId: f.worldId, nationId: 1, setting: 'recruitment', blocked: true };
    const request = () => rpc(NATION_RESTRICTIONS_KIND, input, f.alice.cookie, true);
    expect((await request()).data).toEqual({ status: 'pending' });
    expect((await request()).data).toEqual({ status: 'pending' });
    expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: NATION_RESTRICTIONS_KIND } })).toBe(1);
    await f.loop.advanceTo(0);
    expect((await rpc('nation.get', { worldId: f.worldId, nationId: 1 }, f.bob.cookie)).data).toMatchObject({
      restrictions: { recruitmentBlocked: true },
    });
    expect((await rpc('world.map', { worldId: f.worldId }, f.bob.cookie)).data).toMatchObject({
      nations: expect.arrayContaining([expect.objectContaining({ id: 1, recruitmentBlocked: true })]),
    });
    expect((await rpc(NATION_RESTRICTIONS_KIND, { ...input, setting: 'war' }, f.alice.cookie, true)).error).toBe(
      'PRECONDITION_FAILED',
    );
    await f.loop.advanceTo(10000);
    expect((await rpc(NATION_RESTRICTIONS_KIND, { ...input, setting: 'war' }, f.alice.cookie, true)).data).toEqual({
      status: 'pending',
    });
    await f.loop.advanceTo(10000);
    const own = () => rpc('nation.get', { worldId: f.worldId, nationId: 1 }, f.alice.cookie);
    expect((await own()).data).toMatchObject({ restrictions: { warBlocked: true, editor: { warChanges: 1 } } });
    await f.loop.advanceTo(20000);
    expect((await own()).data).toMatchObject({ restrictions: { warBlocked: true, editor: { warChanges: 3 } } });
    const archive = await exportReplay(db, f.worldId);
    expect(replayArchive(archive, 2)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  }),
);

for (const category of ['unauthenticated', 'otherUser', 'sanctioned', 'invalidInput'] as const) {
  it(
    `국가 제한 설정 권한 ${category}`,
    authzCase(NATION_RESTRICTIONS_KIND, category, async () => {
      const f = await fixture({ restrictions: true });
      const actor = category === 'otherUser' ? f.bob : category === 'sanctioned' ? await user('SANCTIONED') : f.alice;
      const result = await rpc(
        NATION_RESTRICTIONS_KIND,
        {
          worldId: f.worldId,
          nationId: 1,
          setting: category === 'invalidInput' ? 'all' : 'recruitment',
          blocked: true,
        },
        category === 'unauthenticated' ? undefined : actor.cookie,
        true,
      );
      expect(result.error).toBe(
        {
          unauthenticated: 'UNAUTHORIZED',
          otherUser: 'FORBIDDEN',
          sanctioned: 'UNAUTHORIZED',
          invalidInput: 'BAD_REQUEST',
        }[category],
      );
      expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: NATION_RESTRICTIONS_KIND } })).toBe(0);
    }),
  );
}

it('미접속 퇴장은 예고 뒤 월말에 적용되고 사용자를 분리하며 재생된다', async () => {
  const alice = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 2).map((general, index) => ({
    ...general,
    userId: index === 0 ? alice.id : null,
    nextTurnTick: 1000000,
  }));
  const term = 1440;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '미접속 퇴장 실제 PG',
    turnTermMinutes: term,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [INACTIVE_REMOVAL_FEATURE, PLAYER_AUTOPLAY_FEATURE, 'policy'],
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const tick = inactiveRemovalTick(0, term);
  const home = () => rpc('home.get', { worldId }, alice.cookie);
  expect((await home()).data).toMatchObject({ general: { autoplay: { removalOn: expect.any(Object) } } });
  await loop.advanceTo(tick - 10000);
  expect((await home()).status).toBe(200);
  await loop.advanceTo(tick);
  expect((await home()).error).toBe('NOT_FOUND');
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
    userId: null,
    removedAt: tick,
    nationId: null,
    lastActiveTick: null,
    lastActiveAt: null,
  });
  expect(await db.generalLog.count({ where: { worldId, generalId: 1, commandKey: 'general.inactive-removal' } })).toBe(
    1,
  );
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 29)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('성격의 공헌 보정을 실제 장수 턴에 적용하고 같은 결과를 재생한다', async () => {
  const alice = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 2).map((general, index) => ({
    ...general,
    userId: index === 0 ? alice.id : null,
    personality: index === 0 ? 'che_은둔' : null,
    nextTurnTick: index === 0 ? 100 : 5000,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '성격 실제 PG',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [GENERAL_PERSONALITY_FEATURE, 'policy'],
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const home = () => rpc('home.get', { worldId }, alice.cookie);
  expect((await home()).data).toMatchObject({
    general: { personalityEffects: { name: '은둔', dedicationPercent: 90 } },
  });
  const turns = Array.from({ length: 30 }, (_, slot) =>
    slot === 0 ? { commandKey: 'donate', args: { resource: 'gold', amount: 100 } } : null,
  );
  expect((await rpc('turns.set', { worldId, revision: 0, slots: turns }, alice.cookie, true)).data).toMatchObject({
    ok: true,
  });
  await loop.advanceTo(100);
  expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
    dedication: initial.generals[0]!.dedication + 90,
  });
  await loop.advanceTo(10000);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('병종 숙련을 징병으로 얻고 변환 명령으로 옮겨도 DB와 재생 결과가 일치한다', async () => {
  const alice = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 2).map((general, index) => ({
    ...general,
    userId: index === 0 ? alice.id : null,
    crew: index === 0 ? 0 : general.crew,
    nextTurnTick: index === 0 ? 100 : 100000,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '숙련전환 실제 PG',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [GENERAL_PROFICIENCY_FEATURE, MILITARY_STAT_GROWTH_FEATURE, 'policy', STAT_GROWTH_FEATURE],
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const commands = await rpc<Array<{ key: string }>>('commands.list', { worldId }, alice.cookie);
  expect(commands.data).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'convert_proficiency' })]));
  const orders = [
    { commandKey: 'conscript', args: { amount: 1000, crewType: 1100 } },
    { commandKey: 'convert_proficiency', args: { srcArmType: 1, destArmType: 2 } },
  ];
  const slots = Array.from({ length: 30 }, (_, slot) => orders[slot] ?? null);
  expect((await rpc('turns.set', { worldId, revision: 0, slots }, alice.cookie, true)).data).toMatchObject({
    ok: true,
  });
  await loop.advanceTo(100);
  const read = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  expect((await read()).proficiency).toEqual({ 1: 1000 });
  expect((await read()).statExperience).toMatchObject({ leadership: 1 });
  await loop.advanceTo(10100);
  expect((await read()).proficiency).toEqual({ 1: 600, 2: 360 });
  expect((await read()).statExperience).toMatchObject({ leadership: 3 });
  await loop.advanceTo(20000);
  const home = await rpc('home.get', { worldId }, alice.cookie);
  expect(home.data).toMatchObject({
    general: {
      proficiency: expect.arrayContaining([
        expect.objectContaining({ armType: 1, value: 600, grade: 'F' }),
        expect.objectContaining({ armType: 2, value: 360, grade: 'F' }),
      ]),
    },
  });
  const ranking = await rpc('ranking.generals', { worldId, by: 'proficiency2' }, alice.cookie);
  expect(ranking.data).toMatchObject({
    proficiencyEnabled: true,
    top: [
      expect.objectContaining({ generalId: 1, value: 360, proficiency: { 1: 600, 2: 360 } }),
      expect.objectContaining({ generalId: 2, value: 0 }),
    ],
  });
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 2)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('내정 특기의 할인과 효과가 실제 턴에 적용되고 월말 기록을 재생한다', async () => {
  const alice = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 2).map((general, index) => ({
    ...general,
    userId: index === 0 ? alice.id : null,
    special: index === 0 ? 'che_경작' : null,
    nextTurnTick: index === 0 ? 100 : 5000,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '내정 특기 실제 PG',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [DOMESTIC_SPECIALTY_FEATURE, 'policy'],
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const home = await rpc('home.get', { worldId }, alice.cookie);
  expect(home.data).toMatchObject({ general: { domesticSpecialty: { name: '경작', cost: 0.8 } } });
  const slots = Array.from({ length: 30 }, (_, slot) => (slot === 0 ? { commandKey: 'farm', args: {} } : null));
  expect((await rpc('turns.set', { worldId, revision: 0, slots }, alice.cookie, true)).data).toMatchObject({
    ok: true,
  });
  await loop.advanceTo(100);
  const row = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  expect(row.gold).toBe(initial.generals[0]!.gold - 80);
  await loop.advanceTo(10000);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('내정 성공으로 지력이 오르고 다음 월말을 재생한다', async () => {
  const alice = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 1).map((general) => ({
    ...general,
    userId: alice.id,
    nextTurnTick: 100,
    statExperience: { leadership: 0, strength: 0, intel: 29 },
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '능력치 성장 실제 PG',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: ['policy', STAT_GROWTH_FEATURE],
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const home = () => rpc('home.get', { worldId }, alice.cookie);
  expect((await home()).data).toMatchObject({ general: { statUpgradeLimit: 30, statExperience: { intel: 29 } } });
  const slots = Array.from({ length: 30 }, (_, slot) => (slot === 0 ? { commandKey: 'farm', args: {} } : null));
  expect((await rpc('turns.set', { worldId, revision: 0, slots }, alice.cookie, true)).data).toMatchObject({
    ok: true,
  });
  await loop.advanceTo(100);
  expect((await home()).data).toMatchObject({
    general: { intel: initial.generals[0]!.intel + 1, statExperience: { intel: 0 } },
  });
  await loop.advanceTo(10000);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('병종 특기의 징병 할인과 월말 재생이 일치한다', async () => {
  const alice = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 2).map((general, index) => ({
    ...general,
    userId: index === 0 ? alice.id : null,
    special: index === 0 ? 'che_보병' : null,
    crew: index === 0 ? 0 : general.crew,
    nextTurnTick: index === 0 ? 100 : 100000,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '병종 특기 실제 PG',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [COMBAT_SPECIALTY_FEATURE, 'policy'],
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const home = await rpc('home.get', { worldId }, alice.cookie);
  expect(home.data).toMatchObject({ general: { combatSpecialty: { name: '보병', armType: 1 } } });
  const args = { amount: 100, crewType: 1100 };
  const slots = Array.from({ length: 30 }, (_, slot) => (slot === 0 ? { commandKey: 'conscript', args } : null));
  expect((await rpc('turns.set', { worldId, revision: 0, slots }, alice.cookie, true)).data).toMatchObject({
    ok: true,
  });
  await loop.advanceTo(100);
  const row = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
  const unit = testUnits.crewTypes.find((type) => type.id === 1100)!;
  const cost = Math.ceil(args.amount * unit.cost * BALANCE.CONSCRIPT_COST_FACTOR * 0.9);
  expect(row.gold).toBe(initial.generals[0]!.gold - cost);
  expect(row.crew).toBe(args.amount);
  await loop.advanceTo(10000);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

it('부대 창설·가입·집합·추방을 실제 DB와 월말 재생에서 확인한다', async () => {
  const [alice, bob, outsider] = await Promise.all([user(), user(), user()]);
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 3).map((general, index) => ({
    ...general,
    userId: null,
    nationId: index === 1 ? 1 : general.nationId,
    cityKey: index === 1 ? 4 : general.cityKey,
    officerLevel: index === 1 ? 1 : general.officerLevel,
    nextTurnTick: index === 0 ? 100 : 100000,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '부대 실제 PG',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: ['personnel', 'policy', TROOP_FEATURE],
  });
  worlds.push(worldId);
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const operator = await user();
  await db.user.update({ where: { id: operator.id }, data: { role: 'ADMIN' } });
  expect(
    (
      await rpc(
        'admin.world.requestSetting',
        {
          worldId,
          expectedUserId: operator.id,
          idempotencyKey: randomUUID(),
          reason: '부대 시험에서 NPC 맡기를 허용합니다.',
          setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: 'on' },
        },
        operator.cookie,
        true,
      )
    ).status,
  ).toBe(200);
  await loop.advanceTo(0);
  for (const [index, actor] of [alice, bob, outsider].entries()) {
    const generalId = index + 1;
    const idempotencyKey = randomUUID();
    const request = rpc(
      'entry.possess',
      { worldId, generalId, expectedUserId: actor.id, idempotencyKey },
      actor.cookie,
      true,
    );
    await expect.poll(() => db.inputEvent.count({ where: { worldId, idempotencyKey, status: 'PENDING' } })).toBe(1);
    await loop.advanceTo(0);
    expect((await request).data).toEqual({ status: 'possessed', generalId });
  }
  await controlClock(db, worldId, 'start', now);
  expect((await rpc('nation.get', { worldId, nationId: 1 }, alice.cookie)).data).toMatchObject({
    generals: expect.arrayContaining([expect.objectContaining({ id: 1, isHuman: true, possessedNpc: true })]),
  });
  const update = (cookie: string, change: object) =>
    rpc(
      'troop.update',
      { worldId, expectedGeneralId: [alice.cookie, bob.cookie, outsider.cookie].indexOf(cookie) + 1, change },
      cookie,
      true,
    );
  const list = (cookie: string) => rpc('troop.list', { worldId }, cookie);
  const create = { action: 'create', name: '청주병' };
  const requested = await update(alice.cookie, create);
  await authzCase('troop.update', 'success', async () => {
    expect(requested.data).toMatchObject({ status: 'pending' });
    expect((await update(alice.cookie, create)).data).toEqual(requested.data);
  })();
  await loop.advanceTo(0);
  await authzCase('troop.list', 'success', async () => {
    expect(await list(alice.cookie)).toMatchObject({
      status: 200,
      data: { myTroop: 1, troops: [{ name: '청주병', members: [] }] },
    });
  })();
  await authzCase('troop.list', 'otherUser', async () => {
    expect((await list(outsider.cookie)).data).toMatchObject({ myTroop: null, troops: [] });
  })();
  const join = { action: 'join', leaderId: 1 };
  await authzCase('troop.update', 'otherUser', async () => {
    expect((await update(outsider.cookie, join)).status).toBe(400);
    expect(
      (await rpc('troop.update', { worldId, expectedGeneralId: 1, change: { action: 'leave' } }, bob.cookie, true))
        .status,
    ).toBe(409);
  })();
  expect((await update(bob.cookie, join)).data).toMatchObject({ status: 'pending' });
  await loop.advanceTo(0);
  expect((await list(bob.cookie)).data).toMatchObject({ myTroop: 1, troops: [{ members: [{ id: 2, cityKey: 4 }] }] });
  const slots = Array.from({ length: 30 }, (_, slot) => (slot === 0 ? { commandKey: 'troop_gather', args: {} } : null));
  expect((await rpc('turns.set', { worldId, revision: 1, slots }, alice.cookie, true)).data).toMatchObject({
    ok: true,
  });
  expect((await list(bob.cookie)).data).toMatchObject({
    troops: [{ gatherSlots: [true, false, false, false, false] }],
  });
  await loop.advanceTo(100);
  expect((await list(bob.cookie)).data).toMatchObject({ troops: [{ members: [{ id: 2, cityKey: 1 }] }] });
  expect((await update(alice.cookie, { action: 'kick', memberId: 2 })).data).toMatchObject({ status: 'pending' });
  await loop.advanceTo(100);
  expect((await list(bob.cookie)).data).toMatchObject({ myTroop: null, troops: [{ members: [] }] });
  expect((await update(bob.cookie, join)).data).toMatchObject({ status: 'pending' });
  await loop.advanceTo(100);
  const expelCommand = async () =>
    (await rpc<Array<{ key: string }>>('nationCommands.list', { worldId }, alice.cookie)).data?.find(
      (command) => command.key === 'nation_troop_expel',
    );
  expect(await expelCommand()).toMatchObject({
    available: null,
    troopTargets: [{ generalId: 2, troopName: '청주병' }],
  });
  const tabs = await rpc<{ tabs: Array<{ officerLevel: number; office: object; revision: number }> }>(
    'nationTurns.get',
    { worldId },
    alice.cookie,
  );
  const office = tabs.data!.tabs.find((tab) => tab.officerLevel === 12)!;
  const nationalSlots = Array.from({ length: 12 }, (_, slot) =>
    slot === 0 ? { commandKey: 'nation_troop_expel', args: { generalId: 2 } } : null,
  );
  expect(
    (
      await rpc(
        'nationTurns.set',
        {
          worldId,
          office: office.office,
          revision: office.revision,
          slots: nationalSlots,
        },
        alice.cookie,
        true,
      )
    ).data,
  ).toMatchObject({ ok: true });
  await loop.advanceTo(10100);
  expect((await list(bob.cookie)).data).toMatchObject({ myTroop: null, troops: [{ members: [] }] });
  expect(await expelCommand()).toMatchObject({ available: false, troopTargets: [] });
  await loop.advanceTo(20000);
  expect((await rpc('ranking.generals', { worldId, by: 'dedication' }, alice.cookie)).data).toMatchObject({
    top: expect.arrayContaining([expect.objectContaining({ generalId: 1, isHuman: true, possessedNpc: true })]),
  });
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 2)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});

for (const path of ['troop.list', 'troop.update'] as const) {
  for (const category of ['unauthenticated', 'sanctioned', 'invalidInput'] as const) {
    it(
      `부대 접근 경계 ${path} ${category}`,
      authzCase(path, category, async () => {
        const f = await fixture();
        const mutation = path === 'troop.update';
        const actor = category === 'sanctioned' ? await user('SANCTIONED') : f.alice;
        const input = {
          worldId: category === 'invalidInput' ? 1 : f.worldId,
          ...(mutation ? { expectedGeneralId: 1, change: { action: 'leave' } } : {}),
        };
        const result = await rpc(path, input, category === 'unauthenticated' ? undefined : actor.cookie, mutation);
        expect(result.error).toBe(category === 'invalidInput' ? 'BAD_REQUEST' : 'UNAUTHORIZED');
        if (mutation) expect(await db.inputEvent.count({ where: { worldId: f.worldId, kind: path } })).toBe(0);
      }),
    );
  }
}

it('실제 출병의 전투계략과 단기 수입을 월말에 재생한다', async () => {
  const alice = await user();
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 2).map((general, index) => ({
    ...general,
    userId: index === 0 ? alice.id : null,
    intel: index === 0 ? 100 : general.intel,
    nextTurnTick: index === 0 ? 100 : 100000,
  }));
  initial.unitSet.crewTypes.find(({ id }) => id === 1100)!.magicCoef = 1;
  initial.nations[0]!.level = 1;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '전투계략 실제 PG',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [
      BATTLE_TACTICS_FEATURE,
      CITY_CONFLICT_FEATURE,
      COMBAT_SPECIALTY_FEATURE,
      'policy',
      WAR_INCOME_FEATURE,
    ],
  });
  worlds.push(worldId);
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date(now) } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 실행권이 없습니다.');
  leases.push(lease);
  const loop = new TurnLoop(db, lease);
  const slots = Array.from({ length: 30 }, (_, slot) =>
    slot === 0 ? { commandKey: 'attack', args: { cityKey: 2 } } : null,
  );
  expect((await rpc('turns.set', { worldId, revision: 0, slots }, alice.cookie, true)).data).toMatchObject({
    ok: true,
  });
  await loop.advanceTo(100);
  expect((await rpc('records.battles', { worldId }, alice.cookie)).data).toMatchObject({
    items: [
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({ attackerTactic: { name: expect.any(String), success: expect.any(Boolean) } }),
        ]),
      }),
    ],
  });
  const projection = await rpc<{ financeEstimate: { warIncome: number; gold: { net: number } } }>(
    'nation.get',
    { worldId, nationId: 1 },
    alice.cookie,
  );
  const estimate = projection.data!.financeEstimate;
  expect(estimate.warIncome).toBeGreaterThan(0);
  const where = { worldId_id: { worldId, id: 1 } };
  const before = await db.nation.findUniqueOrThrow({ where });
  expect(await db.city.count({ where: { worldId, warCasualties: { gt: 0 } } })).toBe(2);
  const siege = await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 2 } } });
  expect(siege.conflict).not.toBeNull();
  await loop.advanceTo(10000);
  expect((await db.nation.findUniqueOrThrow({ where })).gold).toBe(
    before.gold + estimate.gold.net + estimate.warIncome,
  );
  expect(await db.city.count({ where: { worldId, warCasualties: { gt: 0 } } })).toBe(0);
  const archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});
