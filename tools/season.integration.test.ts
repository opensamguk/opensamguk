import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { acquireLease, releaseLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, replayToEnd } from '../apps/engine/src/replay';
import { prepareSeasonWorld, seasonInitial } from '../apps/engine/test/seasonFixture';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { CREATION_ERRORS } from '../packages/rules/src/index';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const app = await buildServer({ db, logging: false });
let address: string;
const worlds: string[] = [],
  users: string[] = [];
beforeAll(async () => {
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function identity() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, passwordHash: 'test-only' } });
  users.push(user.id);
  const session = newSession(Date.now());
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { id: user.id, cookie: `sid=${session.token}` };
}
async function request(path: string, input: unknown, cookie?: string) {
  const mutation = ['turns.set', 'turns.edit', 'general.create'].includes(path);
  const response = await fetch(
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
  const [body] = await response.json();
  return { data: body.result?.data, code: body.error?.data.code, message: body.error?.message };
}
const creation = { name: '기수시험장수', leadership: 55, strength: 55, intel: 55, portraitId: 10001 };
const turns = () => Array.from({ length: 30 }, () => null as null | { commandKey: string; args: object });
async function state(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    events: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
  };
}

for (const reason of ['END_YEAR', 'UNIFIED'] as const) {
  describe(`T1-26 실제 HTTP ${reason}`, () => {
    it('서로 다른 로그인 계정은 장수 없이 공개 결과를 읽고 권한·입력 오류를 구분한다', async () => {
      const a = await identity(),
        b = await identity();
      let reserved: Lease | null = null;
      const { worldId, initial } = await prepareSeasonWorld(db, reason, {
        beforeStart: async (id) => {
          expect((await db.world.findUniqueOrThrow({ where: { id } })).status).toBe('PREOPEN');
          reserved = await acquireLease(db, id);
          expect(reserved).not.toBeNull();
        },
      });
      worlds.push(worldId);
      try {
        expect((await request('world.summary', { worldId }, a.cookie)).data).toMatchObject({
          clockMode: 'REALTIME',
          endYear: initial.startYear,
          result: null,
        });
        expect((await request('world.summary', { worldId }, b.cookie)).data.clockMode).toBe('REALTIME');
        await controlClock(db, worldId, 'accelerate');
        for (const account of [a, b])
          expect((await request('world.summary', { worldId }, account.cookie)).data).toMatchObject({
            clockMode: 'ACCELERATED',
            result: null,
          });
        expect(await acquireLease(db, worldId)).toBeNull();
        const loop = new TurnLoop(db, reserved!);
        for (;;) {
          const batch = await loop.poll();
          if (batch.status === 'ENDED' && !batch.more) break;
        }
        const first = await request('world.summary', { worldId }, a.cookie);
        expect(first.data).toEqual((await request('world.summary', { worldId }, b.cookie)).data);
        expect(first.data).toMatchObject({
          status: 'ENDED',
          clockMode: 'ACCELERATED',
          gameDate: { year: initial.startYear, month: reason === 'END_YEAR' ? 12 : 1 },
          result: { reason },
        });
        expect(Object.keys(first.data.result).sort()).toEqual(
          ['reason', 'year', 'month', 'winner', 'remainingNations', 'endedAt'].sort(),
        );
        expect(first.data.result.winner).toEqual(
          reason === 'END_YEAR'
            ? null
            : { nationId: 1, name: initial.nations[0]!.name, color: initial.nations[0]!.color },
        );
        expect((await request('world.summary', { worldId })).code).toBe('UNAUTHORIZED');
        expect((await request('world.summary', { worldId: 'invalid' }, a.cookie)).code).toBe('BAD_REQUEST');
        expect((await request('world.summary', { worldId: randomUUID() }, a.cookie)).code).toBe('NOT_FOUND');
        await db.user.update({ where: { id: b.id }, data: { status: 'SANCTIONED' } });
        expect((await request('world.summary', { worldId }, b.cookie)).code).toBe('UNAUTHORIZED');
      } finally {
        if (reserved) await releaseLease(db, reserved);
      }
    });
  });
}

it('같은 사람 판에서 realtime 턴·가속·예턴 편집·충돌·정지·재개·복귀를 이어 간다', async () => {
  const a = await identity();
  const initial = await monthlyFixture();
  initial.generals = [{ ...initial.generals[0]!, userId: a.id }];
  const { worldId } = await saveInitialWorld(db, initial, { name: '사람 가속', turnTermMinutes: 60, endYear: null });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  const queue = turns();
  queue[0] = { commandKey: 'farm', args: {} };
  queue[1] = { commandKey: 'commerce', args: {} };
  expect((await request('turns.set', { worldId, revision: 0, slots: queue }, a.cookie)).data.ok).toBe(true);
  const lease = (await acquireLease(db, worldId))!;
  try {
    const loop = new TurnLoop(db, lease);
    await loop.advanceTo(100);
    expect((await db.generalLog.findFirstOrThrow({ where: { worldId } })).commandKey).toBe('farm');
    await loop.advanceTo(10100);
    await loop.advanceTo(20100);
    expect(
      (await db.generalLog.findMany({ where: { worldId }, orderBy: { tick: 'asc' } })).map((log) => log.commandKey),
    ).toEqual(['farm', 'commerce', 'rest']);
    await controlClock(db, worldId, 'accelerate');
    expect((await request('home.get', { worldId }, a.cookie)).data.nextTurnAt).toBeNull();
    const mine = (await request('turns.get', { worldId }, a.cookie)).data;
    expect((await request('turns.set', { worldId, revision: mine.revision, slots: queue }, a.cookie)).data.ok).toBe(
      true,
    );
    expect(
      (await request('turns.set', { worldId, revision: mine.revision, slots: queue }, a.cookie)).data,
    ).toMatchObject({ ok: false, reason: 'STALE' });
    expect(
      (await request('turns.edit', { worldId, revision: mine.revision + 1, op: { shift: 1 } }, a.cookie)).data.ok,
    ).toBe(true);
    const batch = await loop.poll();
    expect(batch.executions.length).toBeLessThanOrEqual(64);
    await controlClock(db, worldId, 'pause');
    const paused = await state(worldId);
    await delay(100);
    expect((await loop.poll()).more).toBe(false);
    expect(await state(worldId)).toEqual(paused);
    await controlClock(db, worldId, 'resume');
    const before = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick;
    const realtime = await controlClock(db, worldId, 'realtime');
    expect(realtime.tick).toBe(before);
  } finally {
    await releaseLease(db, lease);
  }
});

it('가속 턴 commit과 겹친 API edit는 STALE이며 재시도한 편집은 다음 턴에서 한 번 실행한다', async () => {
  const a = await identity();
  const initial = await monthlyFixture();
  initial.generals = [{ ...initial.generals[0]!, userId: a.id }];
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '가속 편집 경합',
    turnTermMinutes: 60,
    endYear: null,
  });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  await controlClock(db, worldId, 'accelerate');
  const slots = turns();
  slots[0] = { commandKey: 'farm', args: {} };
  expect((await request('turns.set', { worldId, revision: 0, slots }, a.cookie)).data.ok).toBe(true);
  const lease = (await acquireLease(db, worldId))!;
  let reached!: () => void, release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true,
    commerceTick: number | undefined,
    commerceSequence: number | undefined;
  const loop = new TurnLoop(db, lease, {
    beforeCommit: async (tx) => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      if (commerceTick !== undefined && commerceSequence === undefined) {
        const general = await tx.general.findUniqueOrThrow({
          where: { worldId_id: { worldId, id: 1 } },
          select: { nextTurnTick: true, world: { select: { actionSequence: true } } },
        });
        if (general.nextTurnTick === commerceTick + 10000) commerceSequence = general.world.actionSequence;
      }
    },
  });
  try {
    const polling = loop.poll();
    await barrier;
    const editing = request('turns.edit', { worldId, revision: 1, op: { shift: 1 } }, a.cookie);
    const deadline = performance.now() + 5000;
    while (
      !(
        await db.$queryRaw<
          unknown[]
        >`SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM "World"%FOR UPDATE%'`
      ).length
    ) {
      if (performance.now() > deadline) throw new Error('가속 편집의 월드 잠금 대기 시간 초과');
      await delay(10);
    }
    release();
    expect((await editing).data).toMatchObject({ ok: false, reason: 'STALE' });
    await polling;
    const revision = (await request('turns.get', { worldId }, a.cookie)).data.revision;
    const saved = await request(
      'turns.edit',
      { worldId, revision, op: { put: { from: 0, to: 0, commandKey: 'commerce', args: {} } } },
      a.cookie,
    );
    expect(saved.data.ok).toBe(true);
    const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    commerceTick = general.nextTurnTick;
    await loop.advanceTo(general.nextTurnTick);
    expect(commerceSequence).toBeTypeOf('number');
    expect(
      await db.generalLog.findFirstOrThrow({
        where: { worldId, generalId: 1, tick: general.nextTurnTick, sequence: commerceSequence! },
      }),
    ).toMatchObject({ commandKey: 'commerce' });
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).turnRevision).toBe(
      saved.data.revision + 1,
    );
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(2);
  } finally {
    release();
    await releaseLease(db, lease);
  }
});

it('마지막 정산 뒤 API 예턴·장수 생성을 포함해 장수 턴 통일을 재생하고 종료 뒤 입력은 기록 없이 거부한다', async () => {
  const a = await identity(),
    b = await identity();
  const initial = await seasonInitial('UNIFIED');
  initial.generals[0]!.userId = a.id;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '종료 입력 재생',
    turnTermMinutes: 60,
    endYear: initial.startYear,
  });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  try {
    const loop = new TurnLoop(db, lease);
    await loop.advanceTo(10000);
    const mine = (await request('turns.get', { worldId }, a.cookie)).data;
    const queue = turns();
    queue[0] = { commandKey: 'attack', args: { cityKey: 2 } };
    expect((await request('turns.set', { worldId, revision: mine.revision, slots: queue }, a.cookie)).data.ok).toBe(
      true,
    );
    const creating = request('general.create', { worldId, ...creation }, b.cookie);
    const deadline = performance.now() + 5000;
    while (!(await db.inputEvent.count({ where: { worldId, status: 'PENDING' } }))) {
      if (performance.now() > deadline) throw new Error('장수 생성 접수 대기 시간 초과');
      await delay(10);
    }
    await loop.advanceTo(10001);
    expect((await creating).code).toBeUndefined();
    await loop.advanceTo(20000);
    const archive = await exportReplay(db, worldId);
    expect(archive.months).toHaveLength(1);
    expect(archive.inputs.map((i) => i.kind)).toEqual(['turns.set', 'general.create']);
    expect(replayToEnd(JSON.parse(JSON.stringify(archive)))).toEqual(archive.end);
    for (const kind of ['turns.set', 'general.create']) {
      const missing = structuredClone(archive);
      missing.inputs = missing.inputs.filter((i) => i.kind !== kind);
      expect(() => replayToEnd(missing)).toThrow();
    }
    const before = await state(worldId);
    for (const path of ['turns.set', 'turns.edit', 'general.create']) {
      const input =
        path === 'general.create'
          ? { worldId, ...creation }
          : path === 'turns.edit'
            ? { worldId, revision: 0, op: { shift: 1 } }
            : { worldId, revision: 0, slots: turns() };
      const response = await request(path, input, a.cookie);
      if (path === 'general.create') {
        // T2-03 L4: 이미 있는 내 장수 판정이 월드 종료보다 먼저다.
        expect(response).toMatchObject({ code: 'CONFLICT', message: CREATION_ERRORS.ALREADY_EXISTS });
        const newcomer = await identity();
        expect(await request(path, input, newcomer.cookie)).toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: CREATION_ERRORS.WORLD_CLOSED,
        });
      } else expect(response.code).toBe('PRECONDITION_FAILED');
    }
    expect(await state(worldId)).toEqual(before);
  } finally {
    await releaseLease(db, lease);
  }
});
