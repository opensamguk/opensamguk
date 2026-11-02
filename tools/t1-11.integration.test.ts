import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { CREATION_ERRORS, commands } from '../packages/rules/src/index';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
const worlds: string[] = [];
const users: string[] = [];
const payload = { name: '새장수', leadership: 55, strength: 55, intel: 55, portraitId: 10001 };
const empty = () => Array.from({ length: 30 }, () => null);
const mutations = new Set(['general.create', 'turns.set', 'turns.edit']);
let address: string;
async function request(path: string, input: unknown, cookie?: string) {
  const mutation = mutations.has(path);
  const res = await fetch(
    `${address}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(cookie ? { cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: JSON.stringify({ 0: input }) } : {}),
    },
  );
  const text = await res.text();
  const body = JSON.parse(text)[0];
  return { data: body.result?.data, code: body.error?.data.code, message: body.error?.message, text };
}
async function identity() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, passwordHash: 'test-only' } });
  users.push(user.id);
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { id: user.id, cookie: `sid=${session.token}`, sessionId: session.id };
}
async function fixture(own = true, configure?: (initial: Awaited<ReturnType<typeof monthlyFixture>>) => void) {
  const a = await identity();
  const b = await identity();
  const initial = await monthlyFixture();
  if (own) initial.generals[0]!.userId = a.id;
  initial.generals[1]!.userId = b.id;
  configure?.(initial);
  const { worldId } = await saveInitialWorld(db, initial, { name: 'T1-11 시험', turnTermMinutes: 60, endYear: null });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  return { a, b, worldId, lease, initial, loop: new TurnLoop(db, lease) };
}
async function waitFor(check: () => Promise<boolean>) {
  const until = performance.now() + 10000;
  while (!(await check())) {
    if (performance.now() >= until) throw new Error('DB 경계 대기 시간 초과');
    await delay(10);
  }
}
async function pending(worldId: string) {
  await waitFor(async () => (await db.inputEvent.count({ where: { worldId, status: 'PENDING' } })) > 0);
}
async function enqueue(world: { id: string }, userId: string, value: unknown = payload) {
  return db.inputEvent.create({
    data: {
      worldId: world.id,
      userId,
      kind: 'general.create',
      idempotencyKey: `test:${randomUUID()}`,
      payload: value as Prisma.InputJsonValue,
    },
  });
}
async function unchanged(worldId: string) {
  return {
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    events: await db.inputEvent.count({ where: { worldId } }),
  };
}
beforeAll(async () => {
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('T1-11 실제 HTTP·PostgreSQL 권한', () => {
  it('home과 mine의 공개 장수 필드는 유지하고 내부 소유권·성향·revision을 숨긴다', async () => {
    const { a, worldId } = await fixture();
    const home = await request('home.get', { worldId }, a.cookie);
    const mine = await request('general.mine', { worldId }, a.cookie);
    const fields = [
      'id',
      'name',
      'nationId',
      'portraitId',
      'cityKey',
      'leadership',
      'strength',
      'intel',
      'officerLevel',
      'birthYear',
      'deathYear',
      'activeFromYear',
      'personality',
      'special',
      'gold',
      'rice',
      'crew',
      'crewType',
      'train',
      'atmos',
      'experience',
      'dedication',
      'age',
      'injury',
      'nextTurnTick',
    ].sort();
    expect(home.code).toBeUndefined();
    expect(mine.code).toBeUndefined();
    expect(Object.keys(home.data.general).sort()).toEqual([...fields, 'policy'].sort());
    expect(Object.keys(mine.data.general).sort()).toEqual(fields);
    const { policy, ...homeGeneral } = home.data.general;
    expect(policy).toEqual({ key: 'none', name: '없음' });
    expect(homeGeneral).toEqual(mine.data.general);
    expect(mine.data).toHaveProperty('creation', null);
    expect(home.data).not.toHaveProperty('creation');
    for (const key of ['userId', 'affinity', 'turnRevision']) {
      expect(home.data.general).not.toHaveProperty(key);
      expect(mine.data.general).not.toHaveProperty(key);
    }
  });
  it('장수 27개만 공개하고 JSON 인자와 서버 소유 actor·target·unitSet 경계를 지킨다', async () => {
    const { a, worldId } = await fixture();
    const before = await unchanged(worldId);
    const list = (await request('commands.list', { worldId }, a.cookie)).data;
    const args: Record<string, object> = {
      farm: {},
      commerce: {},
      security: {},
      settle: {},
      goodwill: {},
      defence: {},
      wall: {},
      research: {},
      rest: {},
      recruit: { amount: 10, crewType: 1 },
      conscript: { amount: 10, crewType: 1 },
      train: {},
      morale: {},
      attack: { cityKey: 2 },
      move: { cityKey: 2 },
      return: {},
      dismiss: {},
      join: { nationId: 2 },
      join_random: {},
      found: { name: '새나라', color: '#112233' },
      uprising: { name: '새나라', color: '#112233' },
      resign: {},
      invite: { generalId: 2 },
      accept_invite: {},
      heal: {},
      trade_rice: { amount: 1, buy: true },
      donate: { resource: 'gold', amount: 1 },
    };
    expect(list).toHaveLength(27);
    expect(list.map((d: { key: string }) => d.key).sort()).toEqual(Object.keys(args).sort());
    for (const command of list) {
      expect(command.argsSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(
        (await request('turns.precheck', { worldId, commandKey: command.key, args: args[command.key] }, a.cookie)).code,
      ).toBeUndefined();
    }
    expect(list.find((d: { key: string }) => d.key === 'recruit').argsSchema).toMatchObject({
      required: ['amount', 'crewType'],
    });
    for (const extra of [{ actor: { generalId: 2 } }, { target: 'nation' }, { unitSet: {} }]) {
      expect((await request('turns.precheck', { worldId, commandKey: 'rest', ...extra }, a.cookie)).code).toBe(
        'BAD_REQUEST',
      );
      expect((await request('turns.precheck', { worldId, commandKey: 'rest', args: extra }, a.cookie)).code).toBe(
        'BAD_REQUEST',
      );
      expect((await request('commands.list', { worldId, ...extra }, a.cookie)).code).toBe('BAD_REQUEST');
    }
    expect(await unchanged(worldId)).toEqual(before);
  });
  it('국가 10개는 올바른 인자라도 set·edit·precheck에서 거부하고 DB를 바꾸지 않는다', async () => {
    const { a, worldId } = await fixture();
    const before = await unchanged(worldId);
    const national = commands.filter((d) => d.target === 'nation');
    expect(national).toHaveLength(10);
    const args: Record<string, object> = {
      nation_rest: {},
      nation_reward: { generalId: 1, resource: 'gold', amount: 1 },
      nation_seize: { generalId: 1, resource: 'rice', amount: 1 },
      nation_assign: { generalId: 1, cityKey: 3 },
      nation_capital: { cityKey: 3 },
      nation_declare: { nationId: 2 },
      nation_peace: { nationId: 2 },
      nation_pact: { nationId: 2 },
      nation_break_pact: { nationId: 2 },
      nation_aid: { nationId: 2, resource: 'gold', amount: 1 },
    };
    for (const def of national) {
      const turn = { commandKey: def.key, args: args[def.key] };
      expect(def.args.safeParse(turn.args).success).toBe(true);
      for (const [path, extra] of [
        ['turns.precheck', turn],
        ['turns.set', { revision: 0, slots: [turn, ...empty().slice(1)] }],
        ['turns.edit', { revision: 0, op: { put: { from: 0, to: 0, ...turn } } }],
      ] as const)
        expect((await request(path, { worldId, ...extra }, a.cookie)).code, `${path}/${def.key}`).toBe('BAD_REQUEST');
    }
    expect(await unchanged(worldId)).toEqual(before);
  });
  it('인자가 있는 명령도 set·edit·precheck에서 타입·누락·추가 JSON 필드를 엄격히 검사한다', async () => {
    const { a, worldId } = await fixture();
    const before = await unchanged(worldId);
    for (const args of [
      undefined,
      {},
      { amount: '10', crewType: 1 },
      { amount: 0, crewType: 1 },
      { amount: 1.5, crewType: 1 },
      { amount: 10 },
      { amount: 10, crewType: 1, extra: true },
      ...[{ actor: { generalId: 2 } }, { target: 'nation' }, { unitSet: {} }].map((extra) => ({
        amount: 10,
        crewType: 1,
        ...extra,
      })),
    ]) {
      const turn = { commandKey: 'recruit', args };
      for (const [path, extra] of [
        ['turns.precheck', turn],
        ['turns.set', { revision: 0, slots: [turn, ...empty().slice(1)] }],
        ['turns.edit', { revision: 0, op: { put: { from: 0, to: 0, ...turn } } }],
      ] as const)
        expect((await request(path, { worldId, ...extra }, a.cookie)).code, path).toBe('BAD_REQUEST');
    }
    expect(await unchanged(worldId)).toEqual(before);
  });
  it('7개 API 모두 잘못된 세션·만료·삭제·제재·탈퇴와 권한 필드 삽입을 거부한다', async () => {
    const { a, worldId } = await fixture();
    const calls = [
      ['general.create', { worldId, ...payload }],
      ['general.mine', { worldId }],
      ['turns.get', { worldId }],
      ['turns.set', { worldId, revision: 0, slots: empty() }],
      ['turns.edit', { worldId, revision: 0, op: { shift: 1 } }],
      ['turns.precheck', { worldId, commandKey: 'rest' }],
      ['commands.list', { worldId }],
    ] as const;
    const before = await unchanged(worldId);
    for (const cookie of [undefined, 'sid=bad', `sid=${'x'.repeat(43)}`])
      for (const [path, input] of calls) expect((await request(path, input, cookie)).code, path).toBe('UNAUTHORIZED');
    for (const status of ['SANCTIONED', 'WITHDRAWN'] as const) {
      await db.user.update({ where: { id: a.id }, data: { status } });
      for (const [path, input] of calls) expect((await request(path, input, a.cookie)).code, path).toBe('UNAUTHORIZED');
    }
    await db.user.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    for (const [path, input] of calls) {
      for (const extra of [{ userId: 'other' }, { generalId: 2 }])
        expect((await request(path, { ...input, ...extra }, a.cookie)).code, path).toBe('BAD_REQUEST');
      expect((await request(path, { ...input, worldId: 'absent' }, a.cookie)).code, path).toBe('NOT_FOUND');
    }
    await db.session.update({ where: { id: a.sessionId }, data: { expiresAt: new Date(0) } });
    for (const [path, input] of calls) expect((await request(path, input, a.cookie)).code).toBe('UNAUTHORIZED');
    await db.session.delete({ where: { id: a.sessionId } });
    for (const [path, input] of calls) expect((await request(path, input, a.cookie)).code).toBe('UNAUTHORIZED');
    expect(await unchanged(worldId)).toEqual(before);
  });
  it('타인·다른 월드 장수를 대신 찾지 않고 본인 예턴만 바꾼다', async () => {
    const { a, b, worldId } = await fixture();
    const other = await fixture(false);
    const beforeB = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } });
    const mine = await request('general.mine', { worldId }, a.cookie);
    expect(mine.data.general.id).toBe(1);
    for (const key of ['userId', 'affinity', 'worldId', 'turnRevision', 'email', 'sessionId'])
      expect(mine.data.general).not.toHaveProperty(key);
    expect(
      (
        await request(
          'turns.edit',
          { worldId, revision: 0, op: { put: { from: 0, to: 3, commandKey: 'farm' } } },
          a.cookie,
        )
      ).data.ok,
    ).toBe(true);
    expect((await request('turns.get', { worldId }, b.cookie)).data.revision).toBe(0);
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 2 } } })).toEqual(beforeB);
    expect((await request('general.mine', { worldId: other.worldId }, a.cookie)).data).toEqual({
      general: null,
      creation: null,
      creationRules: { total: 165, min: 15, max: 80, count: 3, campaignEnabled: false },
    });
    for (const path of ['turns.get', 'turns.precheck'])
      expect(
        (
          await request(
            path,
            { worldId: other.worldId, ...(path.endsWith('precheck') ? { commandKey: 'rest' } : {}) },
            a.cookie,
          )
        ).code,
      ).toBe('NOT_FOUND');
    for (const [path, extra] of [
      ['turns.set', { slots: empty() }],
      ['turns.edit', { op: { shift: 1 } }],
    ] as const)
      expect((await request(path, { worldId: other.worldId, revision: 0, ...extra }, a.cookie)).code).toBe('NOT_FOUND');
  });
});

describe('T1-11 생성 접수와 엔진', () => {
  it('중복 PENDING을 동시 처리해도 장수 한 명과 처음 결과를 보존하며 다중 월 지연을 따라잡는다', async () => {
    const { a, worldId, lease, loop } = await fixture(false);
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    await enqueue(world, a.id);
    await enqueue(world, a.id);
    await Promise.all([loop.advanceTo(50000), new TurnLoop(db, lease).advanceTo(50000)]);
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: a.id } } });
    expect(actor.nextTurnTick).toBeGreaterThan(50000);
    expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(1);
    const events = await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(events[1]!.result).toEqual({ code: 'ALREADY_EXISTS', message: CREATION_ERRORS.ALREADY_EXISTS });
    expect(replayArchive(await exportReplay(db, worldId), 5)).toHaveLength(5);
  });
  it.each(['SANCTIONED', 'WITHDRAWN'] as const)(
    '접수 뒤 %s는 엔진과 대기 API에서 안전하게 거부한다',
    async (status) => {
      const { a, worldId, loop } = await fixture(false);
      const response = request('general.create', { worldId, ...payload }, a.cookie);
      await pending(worldId);
      await db.user.update({ where: { id: a.id }, data: { status } });
      await loop.advanceTo(0);
      const rejected = await response;
      expect(rejected.code).toBe('UNAUTHORIZED');
      expect(rejected.message).toBe(CREATION_ERRORS.ACTOR_INACTIVE);
      expect(rejected.text).not.toContain(a.id);
      expect(rejected.text).not.toContain('stack');
      expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(0);
    },
  );
  it.each(['beforeCommit', 'committed'])(
    '실제 SIGKILL %s 후 생성이 정확히 한 번 적용된다',
    async (phase) => {
      const { a, worldId, lease } = await fixture(false);
      await enqueue(await db.world.findUniqueOrThrow({ where: { id: worldId } }), a.id);
      await releaseLease(db, lease);
      const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/creationWorker.ts', worldId, phase], {
        env: { ...process.env, TEST_DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const exited = once(child, 'exit');
      try {
        expect(
          await Promise.race([
            once(child, 'message').then(([m]) => m),
            exited.then(() => {
              throw new Error('worker 조기 종료');
            }),
          ]),
        ).toBe(phase);
        child.kill('SIGKILL');
        await exited;
        expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(phase === 'committed' ? 1 : 0);
        await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "worldId" = ${worldId}`;
        const restarted = new TurnLoop(db, (await acquireLease(db, worldId))!);
        await restarted.advanceTo(0);
        await restarted.advanceTo(0);
        expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(1);
        expect(await db.inputEvent.count({ where: { worldId, status: 'APPLIED', sequence: 1 } })).toBe(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
    60000,
  );
  it('동일 PENDING 재사용·다른 payload 충돌·엔진 생성·공개 projection·중복 거부', async () => {
    const { a, worldId, loop } = await fixture(false);
    const input = { worldId, ...payload, name: ' 새장수 ' };
    const first = request('general.create', input, a.cookie);
    await pending(worldId);
    const second = request('general.create', { ...input, name: '새장수' }, a.cookie);
    expect((await request('general.create', { ...input, name: '다른장수' }, a.cookie)).code).toBe('CONFLICT');
    expect((await request('general.mine', { worldId }, a.cookie)).data.creation).toEqual({ status: 'pending' });
    await loop.advanceTo(0);
    const results = await Promise.all([first, second]);
    for (const res of results) {
      // 완료 직후 도착한 재전송은 CONFLICT이며 mine으로 복구한다.
      expect(res.data?.status === 'created' || res.code === 'CONFLICT').toBe(true);
    }
    expect(results[0]!.data.status).toBe('created');
    const general = (await request('general.mine', { worldId }, a.cookie)).data.general;
    expect(general).toMatchObject({ name: '새장수', leadership: 55, portraitId: 10001, nationId: null, gold: 1000 });
    expect(general).not.toHaveProperty('affinity');
    expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(1);
    expect(await db.generalTurn.count({ where: { worldId, generalId: general.id, commandKey: 'rest' } })).toBe(30);
    const events = await db.inputEvent.findMany({ where: { worldId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'APPLIED', sequence: 1, generalId: general.id });
    expect((events[0]!.result as { general: object }).general).toHaveProperty('affinity');
    expect((await request('general.create', input, a.cookie)).code).toBe('CONFLICT');
    expect((await request('commands.list', { worldId }, a.cookie)).data.map((d: { key: string }) => d.key)).toContain(
      'rest',
    );
  });
  it('5초 이후 pending, 지연 거부 mine 복구와 새 입력 재시도, 실제 월드 statRules', async () => {
    const { a, worldId, loop } = await fixture(false);
    const started = performance.now();
    expect((await request('general.create', { worldId, ...payload }, a.cookie)).data).toEqual({ status: 'pending' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
    await db.world.update({ where: { id: worldId }, data: { statRules: { total: 60, min: 10, max: 30 } } });
    await loop.advanceTo(0);
    expect((await request('general.mine', { worldId }, a.cookie)).data.creation).toEqual({
      status: 'rejected',
      code: 'BAD_STATS',
      message: CREATION_ERRORS.BAD_STATS,
    });
    const create = request(
      'general.create',
      { worldId, ...payload, leadership: 20, strength: 20, intel: 20 },
      a.cookie,
    );
    await pending(worldId);
    await loop.advanceTo(0);
    expect((await create).data.status).toBe('created');
    const events = await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.status)).toEqual(['REJECTED', 'APPLIED']);
    expect(events[0]!.idempotencyKey).not.toBe(events[1]!.idempotencyKey);
  });
  it('잘못된 이름·초상·능력치·월드 상태는 접수 없이 거부한다', async () => {
    const { a, worldId } = await fixture(false);
    for (const extra of [
      { name: '' },
      { name: 'a!' },
      { name: '1234567' },
      { leadership: 56 },
      { leadership: 14 },
      { leadership: 81 },
      { leadership: 55.5 },
      { portraitId: 10000 },
      { portraitId: 11009 },
      { portraitId: '10001' },
    ])
      expect((await request('general.create', { worldId, ...payload, ...extra }, a.cookie)).code).toBe('BAD_REQUEST');
    for (const status of ['PREOPEN', 'PAUSED', 'ENDED'] as const) {
      await db.world.update({ where: { id: worldId }, data: { status } });
      expect((await request('general.create', { worldId, ...payload }, a.cookie)).code).toBe('PRECONDITION_FAILED');
    }
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(0);
  });
  it.each([
    'BAD_NAME',
    'BAD_STATS',
    'BAD_PORTRAIT',
    'NAME_TAKEN',
    'ALREADY_EXISTS',
    'WORLD_CLOSED',
    'ACTOR_INACTIVE',
  ] as const)('엔진은 %s를 재검사하고 결과·순서를 한 번만 저장한다', async (code) => {
    const { a, worldId, loop, initial } = await fixture(code === 'ALREADY_EXISTS');
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    const input = {
      ...payload,
      ...(code === 'BAD_NAME'
        ? { name: '!' }
        : code === 'BAD_STATS'
          ? { intel: 56 }
          : code === 'BAD_PORTRAIT'
            ? { portraitId: 1 }
            : code === 'NAME_TAKEN'
              ? { name: initial.generals[1]!.name }
              : {}),
    };
    if (code === 'WORLD_CLOSED') await db.world.update({ where: { id: worldId }, data: { status: 'PAUSED' } });
    if (code === 'ACTOR_INACTIVE') await db.user.update({ where: { id: a.id }, data: { status: 'SANCTIONED' } });
    const event = await enqueue(world, a.id, input);
    await loop.advanceTo(0);
    const after = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after).toMatchObject({ status: 'REJECTED', sequence: 1, result: { code, message: CREATION_ERRORS[code] } });
    await loop.advanceTo(0);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(after);
    expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(code === 'ALREADY_EXISTS' ? 1 : 0);
  });
  it('생성 commit 실패는 전체 롤백되며 재시작과 12개월 재생을 보존한다', async () => {
    const { a, worldId, lease, initial } = await fixture(false);
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    const event = await enqueue(world, a.id);
    const failing = new TurnLoop(db, lease, {
      beforeCommit: async () => {
        throw new Error('중단');
      },
    });
    await expect(failing.advanceTo(0)).rejects.toThrow('중단');
    expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(0);
    expect(await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'PENDING',
      sequence: null,
      result: null,
    });
    await releaseLease(db, lease);
    const newLease = (await acquireLease(db, worldId))!;
    const restarted = new TurnLoop(db, newLease);
    await restarted.advanceTo(0);
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: a.id } } });
    expect(actor.id).toBeGreaterThan(Math.max(...initial.generals.map((g) => g.id)));
    const slots = empty();
    expect((await request('turns.set', { worldId, revision: 0, slots }, a.cookie)).data.ok).toBe(true);
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, newLease);
      await restarted.advanceTo(month * 10000);
      if (month === 3) {
        const current = (await request('turns.get', { worldId }, a.cookie)).data;
        expect(
          (
            await request(
              'turns.edit',
              { worldId, revision: current.revision, op: { put: { from: 0, to: 2, commandKey: 'farm' } } },
              a.cookie,
            )
          ).data.ok,
        ).toBe(true);
      }
    }
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive, 12).map((m) => m.stateHash)).toEqual(archive.months.map((m) => m.stateHash));
    expect(await db.general.count({ where: { worldId, userId: a.id } })).toBe(1);
  });
});

describe('T1-11 군사 명령 API·엔진 결합', () => {
  it('등용 수락 사전 검사는 같은 월드의 서버 저장 제안을 읽는다', async () => {
    const { a, worldId, loop } = await fixture(true, (initial) => {
      initial.generals[0]!.nationId = null;
      initial.commandMeta = { nextNationId: 3, offers: { 1: 2 } };
    });
    const turn = { commandKey: 'accept_invite', args: {} };
    expect((await request('turns.precheck', { worldId, ...turn }, a.cookie)).data).toEqual({ ok: true });
    expect(
      (await request('turns.set', { worldId, revision: 0, slots: [turn, ...empty().slice(1)] }, a.cookie)).data.ok,
    ).toBe(true);
    await loop.advanceTo(100);
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
      nationId: 2,
      cityKey: 4,
    });
    expect((await request('turns.precheck', { worldId, ...turn }, a.cookie)).data).toMatchObject({
      ok: false,
      code: 'BAD_STATE',
    });
  });
  it.each([
    ['recruit', true],
    ['recruit', false],
    ['conscript', true],
    ['conscript', false],
    ['attack', true],
    ['attack', false],
  ] as const)(
    '%s 사전 검사 성공=%s와 실제 실행·12개월 재생이 일치한다',
    async (commandKey, accepted) => {
      const { a, worldId, loop, lease, initial } = await fixture(true, (initial) => {
        const unit = initial.unitSet.crewTypes.find((u) => u.armType > 0)!;
        Object.assign(initial.generals[0]!, {
          crewType: unit.id,
          crew: commandKey === 'attack' && accepted ? 1000 : 0,
          leadership: 80,
          gold: accepted ? 100000 : 0,
          rice: 10000,
          train: 100,
          atmos: 100,
        });
        initial.cities[1]!.wall = 0;
        initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
      });
      const unit = initial.unitSet.crewTypes.find((u) => u.armType > 0)!;
      const turn = { commandKey, args: commandKey === 'attack' ? { cityKey: 2 } : { amount: 10, crewType: unit.id } };
      const before = await unchanged(worldId);
      const preview = await request('turns.precheck', { worldId, ...turn }, a.cookie);
      expect(preview.code).toBeUndefined();
      expect(preview.data).toMatchObject(
        accepted ? { ok: true } : { ok: false, code: commandKey === 'attack' ? 'NO_CREW' : 'NO_GOLD' },
      );
      expect(await unchanged(worldId)).toEqual(before);
      expect(
        (await request('turns.set', { worldId, revision: 0, slots: [turn, ...empty().slice(1)] }, a.cookie)).data,
      ).toMatchObject({ ok: true, revision: 1 });
      expect((await request('turns.get', { worldId }, a.cookie)).data.slots[0]).toMatchObject(turn);
      const beforeTurn = await db.world.findUniqueOrThrow({
        where: { id: worldId },
        select: { actionSequence: true },
      });
      await loop.advanceTo(100);
      const log = await db.generalLog.findFirstOrThrow({
        where: { worldId, generalId: 1, tick: 100, sequence: beforeTurn.actionSequence + 1 },
      });
      expect(log).toMatchObject({ commandKey, kind: accepted ? 'success' : 'failure' });
      if (!accepted) expect(log.text).toContain(preview.data.code);
      const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
      const city = await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 3 } } });
      if (accepted && commandKey !== 'attack') {
        expect(general.crew).toBe(10);
        expect(general.crewType).toBe(unit.id);
        expect(general.gold).toBe(100000 - Math.ceil(10 * unit.cost * (commandKey === 'conscript' ? 0.5 : 1)));
        expect(city.population).toBe(990);
      } else if (accepted) {
        expect(general.cityKey).toBe(2);
        expect(await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 2 } } })).toMatchObject({
          nationId: 1,
        });
      } else {
        expect(general.crew).toBe(0);
        expect(general.gold).toBe(0);
        expect(city.population).toBe(1000);
      }
      for (let month = 1; month <= 12; month++) {
        await renewLease(db, lease);
        await loop.advanceTo(month * 10000);
      }
      const archive = await exportReplay(db, worldId);
      expect(archive.inputs[0]).toMatchObject({
        kind: 'turns.set',
        status: 'APPLIED',
        payload: { turns: [turn, ...Array.from({ length: 29 }, () => ({ commandKey: 'rest', args: {} }))] },
      });
      expect(archive.months).toHaveLength(12);
      expect(replayArchive(archive, 12).map((m) => m.stateHash)).toEqual(archive.months.map((m) => m.stateHash));
    },
    60000,
  );
  it('저장된 월드 병종을 검증하고 기본 리소스로 대체하지 않는다', async () => {
    const { a, worldId, initial } = await fixture(true, (initial) => {
      initial.generals[0]!.crew = 0;
      initial.generals[0]!.gold = 1000;
      initial.unitSet.crewTypes.find((u) => u.armType > 0)!.cost = 200;
    });
    const crewType = initial.unitSet.crewTypes.find((u) => u.armType > 0)!.id;
    expect(
      (await request('turns.precheck', { worldId, commandKey: 'recruit', args: { crewType, amount: 10 } }, a.cookie))
        .data,
    ).toMatchObject({ ok: false, code: 'NO_GOLD' });
    await db.world.update({ where: { id: worldId }, data: { unitSet: {} } });
    const before = await unchanged(worldId);
    expect(
      (await request('turns.precheck', { worldId, commandKey: 'recruit', args: { crewType, amount: 10 } }, a.cookie))
        .code,
    ).toBe('INTERNAL_SERVER_ERROR');
    expect(await unchanged(worldId)).toEqual(before);
  });
});

describe('T1-11 30칸·revision·경합·재검사', () => {
  it('API가 먼저 World를 잡으면 엔진은 새 예턴으로 실행하고 입력 오류는 전체 롤백된다', async () => {
    const { a, worldId, loop } = await fixture();
    // 이벤트 INSERT 시점은 예턴 교체와 revision 증가 뒤다. 실제 DB trigger로 경계를 잡는다.
    await db.$executeRawUnsafe(
      `CREATE FUNCTION t1_11_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(114711); RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER t1_11_gate BEFORE INSERT ON "InputEvent" FOR EACH ROW EXECUTE FUNCTION t1_11_gate()`,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(114711)`;
        entered.resolve();
        await release.promise;
      },
      { timeout: 15000 },
    );
    await entered.promise;
    const saving = request(
      'turns.set',
      { worldId, revision: 0, slots: Array.from({ length: 30 }, () => ({ commandKey: 'farm' })) },
      a.cookie,
    );
    try {
      await waitFor(
        async () =>
          (
            await db.$queryRaw<
              { n: number }[]
            >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`
          )[0]!.n > 0,
      );
      const running = loop.advanceTo(100);
      await waitFor(
        async () =>
          (
            await db.$queryRaw<
              { n: number }[]
            >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%World%FOR UPDATE%'`
          )[0]!.n > 0,
      );
      release.resolve();
      await blocker;
      expect((await saving).data).toMatchObject({ ok: true, revision: 1 });
      expect(await running).toEqual([{ generalId: 1, tick: 100, commandKey: 'farm' }]);
      expect((await request('turns.get', { worldId }, a.cookie)).data.revision).toBe(2);
    } finally {
      release.resolve();
      await blocker;
      await db.$executeRawUnsafe('DROP TRIGGER t1_11_gate ON "InputEvent"');
      await db.$executeRawUnsafe('DROP FUNCTION t1_11_gate()');
    }
    const before = await unchanged(worldId);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION t1_11_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rollback'; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER t1_11_fail BEFORE INSERT ON "InputEvent" FOR EACH ROW EXECUTE FUNCTION t1_11_fail()`,
    );
    try {
      expect((await request('turns.set', { worldId, revision: 2, slots: empty() }, a.cookie)).code).toBe(
        'INTERNAL_SERVER_ERROR',
      );
      expect(await unchanged(worldId)).toEqual(before);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER t1_11_fail ON "InputEvent"');
      await db.$executeRawUnsafe('DROP FUNCTION t1_11_fail()');
    }
  });
  it('사전 검사는 규칙 경고만 반환하며 금·보급·소유·최대치·소속과 형식 오류를 구분한다', async () => {
    const { a, worldId } = await fixture();
    const city = await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 3 } } });
    const check = () => request('turns.precheck', { worldId, commandKey: 'farm' }, a.cookie);
    expect((await check()).data).toEqual({ ok: true });
    for (const [code, data] of [
      ['NO_SUPPLY', { supplied: false }],
      ['NOT_OWN_CITY', { nationId: null }],
      ['AT_MAX', { agriculture: city.agricultureMax }],
    ] as const) {
      await db.city.update({ where: { worldId_cityKey: { worldId, cityKey: 3 } }, data });
      expect((await check()).data).toMatchObject({ ok: false, code });
      await db.city.update({
        where: { worldId_cityKey: { worldId, cityKey: 3 } },
        data: { supplied: city.supplied, nationId: city.nationId, agriculture: city.agriculture },
      });
    }
    await db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { nationId: null } });
    expect((await check()).data.code).toBe('NOT_NATION');
    expect((await request('turns.precheck', { worldId, commandKey: 'missing' }, a.cookie)).code).toBe('BAD_REQUEST');
    expect((await request('turns.precheck', { worldId, commandKey: 'rest', args: { extra: 1 } }, a.cookie)).code).toBe(
      'BAD_REQUEST',
    );
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(0);
    await db.world.update({ where: { id: worldId }, data: { status: 'ENDED' } });
    for (const [path, extra] of [
      ['turns.set', { slots: empty() }],
      ['turns.edit', { op: { shift: 1 } }],
    ] as const)
      expect((await request(path, { worldId, revision: 0, ...extra }, a.cookie)).code).toBe('PRECONDITION_FAILED');
  });
  it('set/get·put·shift·repeat·STALE·빈칸 정규화와 strict 입력을 저장한다', async () => {
    const { a, worldId } = await fixture();
    const slots = empty() as (null | { commandKey: string; args?: unknown })[];
    slots[0] = { commandKey: 'farm' };
    slots[1] = { commandKey: 'commerce' };
    slots[2] = { commandKey: 'security' };
    let result = (await request('turns.set', { worldId, revision: 0, slots }, a.cookie)).data;
    expect(result.ok).toBe(true);
    expect(result.slots).toHaveLength(30);
    expect(result.revision).toBe(1);
    expect(result.slots[29]).toEqual({ commandKey: 'rest', args: {}, name: '휴식', explicit: false });
    expect((await request('turns.get', { worldId }, a.cookie)).data).toEqual({
      revision: result.revision,
      slots: result.slots,
    });
    const stale = (await request('turns.edit', { worldId, revision: 0, op: { shift: 1 } }, a.cookie)).data;
    expect(stale).toEqual({ ...result, ok: false, reason: 'STALE' });
    for (const [op, first] of [
      [{ repeat: { from: 0, to: 1, times: 2 } }, ['farm', 'commerce', 'farm', 'commerce', 'farm', 'commerce']],
      [{ shift: 1 }, ['rest', 'farm', 'commerce']],
      [{ shift: -1 }, ['farm', 'commerce', 'farm']],
      [{ put: { from: 1, to: 4, commandKey: 'security' } }, ['farm', 'security', 'security', 'security', 'security']],
    ] as const) {
      result = (await request('turns.edit', { worldId, revision: result.revision, op }, a.cookie)).data;
      expect(result.slots.slice(0, first.length).map((s: { commandKey: string }) => s.commandKey)).toEqual(first);
    }
    const before = await unchanged(worldId);
    for (const invalid of [
      [],
      empty().slice(1),
      [...empty(), null],
      [{ commandKey: 'missing' }, ...empty().slice(1)],
      [{ commandKey: 'rest', args: { x: 1 } }, ...empty().slice(1)],
      result.slots,
    ])
      expect((await request('turns.set', { worldId, revision: result.revision, slots: invalid }, a.cookie)).code).toBe(
        'BAD_REQUEST',
      );
    for (const op of [
      { shift: 0 },
      { shift: 30 },
      { shift: 1.5 },
      { repeat: { from: 0, to: 29, times: 1 } },
      { repeat: { from: 3, to: 1, times: 1 } },
      { put: { from: -1, to: 1, commandKey: 'rest' } },
      { shift: 1, repeat: { from: 0, to: 1, times: 1 } },
    ])
      expect((await request('turns.edit', { worldId, revision: result.revision, op }, a.cookie)).code).toBe(
        'BAD_REQUEST',
      );
    for (const revision of [-1, 0.5, 2147483647, Number.MAX_SAFE_INTEGER])
      expect((await request('turns.set', { worldId, revision, slots: empty() }, a.cookie)).code).toBe('BAD_REQUEST');
    expect(await unchanged(worldId)).toEqual(before);
    const event = await db.inputEvent.findFirstOrThrow({ where: { worldId }, orderBy: { id: 'desc' } });
    expect(event.kind).toBe('turns.set');
    expect(event.payload).not.toHaveProperty('op');
    expect((event.payload as { turns: unknown[] }).turns).toHaveLength(30);
  });
  it('두 탭 동시 저장은 하나만 적용하고 나머지는 같은 스냅샷 STALE이다', async () => {
    const { a, worldId } = await fixture();
    const results = await Promise.all([
      request('turns.set', { worldId, revision: 0, slots: empty() }, a.cookie),
      request('turns.edit', { worldId, revision: 0, op: { put: { from: 0, to: 29, commandKey: 'farm' } } }, a.cookie),
    ]);
    const success = results.find((r) => r.data.ok)!.data;
    const stale = results.find((r) => !r.data.ok)!.data;
    expect(stale).toEqual({ ...success, ok: false, reason: 'STALE' });
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
  });
  it('엔진이 먼저 World를 잡으면 저장은 기다린 뒤 STALE이며 재검사 실패 로그를 남긴다', async () => {
    const { a, worldId, lease } = await fixture();
    expect((await request('turns.precheck', { worldId, commandKey: 'farm' }, a.cookie)).data).toEqual({ ok: true });
    expect(
      (
        await request(
          'turns.set',
          { worldId, revision: 0, slots: Array.from({ length: 30 }, () => ({ commandKey: 'farm' })) },
          a.cookie,
        )
      ).data.ok,
    ).toBe(true);
    await db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { gold: 0 } });
    expect((await request('turns.precheck', { worldId, commandKey: 'farm' }, a.cookie)).data.code).toBe('NO_GOLD');
    const beforeTurn = await db.world.findUniqueOrThrow({
      where: { id: worldId },
      select: { actionSequence: true },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let once = false;
    const loop = new TurnLoop(db, lease, {
      beforeCommit: async () => {
        if (!once) {
          once = true;
          entered.resolve();
          await release.promise;
        }
      },
    });
    const running = loop.advanceTo(100);
    await entered.promise;
    const saving = request('turns.set', { worldId, revision: 1, slots: empty() }, a.cookie);
    try {
      await waitFor(
        async () =>
          (
            await db.$queryRaw<
              { n: number }[]
            >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%World%FOR UPDATE%'`
          )[0]!.n > 0,
      );
    } finally {
      release.resolve();
    }
    await running;
    expect((await saving).data).toMatchObject({ ok: false, reason: 'STALE', revision: 2 });
    const log = await db.generalLog.findFirstOrThrow({
      where: { worldId, generalId: 1, tick: 100, sequence: beforeTurn.actionSequence + 1 },
    });
    expect(log).toMatchObject({ kind: 'failure', commandKey: 'farm' });
    expect(log.text).toContain('NO_GOLD');
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
  });
});
