import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { newSession } from '../apps/server/src/auth/session';
import type { appRouter } from '../apps/server/src/router';
import { buildServer } from '../apps/server/src/server';
import { warFixture } from '../apps/engine/test/warFixture';
import { acquireLease, releaseLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { suggestionOps } from '../apps/web/src/operations/timeline';
import { applyOps, toSaveSlots, toTurn } from '../apps/web/src/turns/draft';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(databaseUrl);
const now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
const worlds: string[] = [];
const users: string[] = [];
const leases: Lease[] = [];
let address: string;

type Caller = ReturnType<typeof appRouter.createCaller>;
type Results = {
  'operation.create': Awaited<ReturnType<Caller['operation']['create']>>;
  'operation.get': Awaited<ReturnType<Caller['operation']['get']>>;
  'operation.suggest': Awaited<ReturnType<Caller['operation']['suggest']>>;
  'turns.get': Awaited<ReturnType<Caller['turns']['get']>>;
  'turns.set': Awaited<ReturnType<Caller['turns']['set']>>;
  'turns.edit': Awaited<ReturnType<Caller['turns']['edit']>>;
};
type Route = keyof Results;
type Slot = Results['turns.get']['slots'][number];
type SlotInput = Parameters<Caller['turns']['set']>[0]['slots'][number];
const mutations = new Set<Route>(['operation.create', 'turns.set', 'turns.edit']);

async function request<R extends Route>(path: R, input: unknown, cookie: string) {
  const mutation = mutations.has(path);
  const payload = JSON.stringify({ 0: input });
  const response = await fetch(
    `${address}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(payload)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        cookie,
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: payload } : {}),
    },
  );
  const body = (
    (await response.json()) as Array<{ result?: { data: Results[R] }; error?: { data: { code: string } } }>
  )[0]!;
  return { status: response.status, data: body.result?.data, error: body.error?.data.code };
}

async function rpc<R extends Route>(path: R, input: unknown, cookie: string): Promise<Results[R]> {
  const result = await request(path, input, cookie);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(200);
  expect(result.data).toBeDefined();
  return result.data!;
}

async function identity() {
  const row = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'fixture-only' } });
  users.push(row.id);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: row.id, expiresAt: session.expiresAt } });
  return { id: row.id, cookie: `sid=${session.token}` };
}

async function fixture(keepEnemyCity = false) {
  const initial = await warFixture();
  const actors = [];
  for (const general of initial.generals) {
    const actor = await identity();
    general.userId = actor.id;
    actors.push(actor);
  }
  if (keepEnemyCity) initial.cities[3]!.nationId = 2;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '작전 저장과 실행 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'policy',
  });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  return { initial, worldId, commander: actors[0]!, enemy: actors[1]! };
}

async function createOperation(f: Awaited<ReturnType<typeof fixture>>, enemy = false) {
  return rpc(
    'operation.create',
    {
      worldId: f.worldId,
      targetCityKey: enemy ? 1 : 2,
      targetYear: f.initial.startYear,
      targetMonth: 2,
      min: { crew: 100, train: 90, atmos: 90 },
      memberIds: enemy ? [2, 3] : [1],
    },
    enemy ? f.enemy.cookie : f.commander.cookie,
  );
}

// 화면의 순수 함수를 그대로 재사용한다. STALE에서는 최신 칸에 같은 제안 편집만 다시 적용한다.
function applySuggestion(suggestion: Results['operation.suggest'], current: Slot[] = suggestion.current) {
  return applyOps(current.map(toTurn), suggestionOps(suggestion));
}

async function snapshot(worldId: string) {
  return db.$transaction(
    async (tx) => ({
      world: await tx.world.findUniqueOrThrow({ where: { id: worldId } }),
      generals: await tx.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      cities: await tx.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } }),
      nations: await tx.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      turns: await tx.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
      inputs: await tx.inputEvent.findMany({ where: { worldId }, orderBy: { sequence: 'asc' } }),
      operations: await tx.operation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      members: await tx.operationMember.findMany({
        where: { worldId },
        orderBy: [{ operationId: 'asc' }, { generalId: 'asc' }],
      }),
      logs: await tx.generalLog.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    }),
    { isolationLevel: 'RepeatableRead' },
  );
}

async function engine(worldId: string, connection = db) {
  const lease = await acquireLease(db, worldId);
  expect(lease).not.toBeNull();
  leases.push(lease!);
  return new TurnLoop(connection, lease!);
}

beforeAll(async () => {
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  try {
    for (const lease of leases) await releaseLease(db, lease);
  } finally {
    // fixture 소유 행의 후처리다. 아래 시험 본문의 국가 제거는 TurnLoop만 실행한다.
    try {
      await db.world.deleteMany({ where: { id: { in: worlds } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db.$disconnect();
    }
  }
});

describe('T2-11 / AC-M2-15 실제 HTTP 저장과 엔진 반영', () => {
  it('제안의 빈칸·직접 휴식·바깥 칸을 저장하고 정지·재개 뒤 예정 tick에 출병한다', async () => {
    const f = await fixture(true);
    const slots: SlotInput[] = Array.from({ length: 30 }, () => null);
    slots[27] = { commandKey: 'rest', args: {} };
    slots[29] = { commandKey: 'farm', args: {} };
    const seeded = await rpc('turns.set', { worldId: f.worldId, revision: 0, slots }, f.commander.cookie);
    expect(seeded.ok).toBe(true);
    const operation = await createOperation(f);
    const beforeSuggest = await snapshot(f.worldId);
    const suggestion = await rpc('operation.suggest', { worldId: f.worldId, id: operation.id }, f.commander.cookie);
    expect(await snapshot(f.worldId)).toEqual(beforeSuggest);
    expect(suggestion.noop).toBeNull();
    expect(suggestion.changed).toEqual([0]);
    const draft = applySuggestion(suggestion);
    const input = toSaveSlots(draft);
    expect(input[0]).toEqual({ commandKey: 'attack', args: { cityKey: 2 } });
    expect(input[1]).toBeNull();
    expect(input[27]).toEqual({ commandKey: 'rest', args: {} });
    expect(input[29]).toEqual({ commandKey: 'farm', args: {} });
    const invalid = await request(
      'turns.set',
      {
        worldId: f.worldId,
        revision: suggestion.revision,
        slots: [
          { commandKey: draft[0]!.commandKey, args: draft[0]!.args, name: suggestion.slots[0]!.name },
          ...input.slice(1),
        ],
      },
      f.commander.cookie,
    );
    expect(invalid.error).toBe('BAD_REQUEST');
    expect(await snapshot(f.worldId)).toEqual(beforeSuggest);
    const saved = await rpc(
      'turns.set',
      { worldId: f.worldId, revision: suggestion.revision, slots: input },
      f.commander.cookie,
    );
    expect(saved.ok).toBe(true);
    expect(saved.revision).toBe(suggestion.revision + 1);
    expect(saved.slots.map(toTurn)).toEqual(draft);
    expect(await rpc('turns.get', { worldId: f.worldId }, f.commander.cookie)).toEqual({
      revision: saved.revision,
      slots: saved.slots,
    });
    for (let slot = 1; slot < 30; slot++) expect(saved.slots[slot]).toEqual(suggestion.current[slot]);
    const detail = await rpc('operation.get', { worldId: f.worldId, id: operation.id }, f.commander.cookie);
    const planned = detail.timeline.find(({ generalId }) => generalId === 1)!.sortie!;
    expect(planned.tick).toBe(100);
    expect(planned.tick).toBeLessThan(detail.targetTick);
    const loop = await engine(f.worldId);
    expect(await loop.advanceTo(planned.tick - 1)).toEqual([]);
    const checkpoint = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
    await controlClock(db, f.worldId, 'pause', checkpoint.clockAnchorAt!.getTime());
    const paused = await snapshot(f.worldId);
    expect(paused.world).toMatchObject({ status: 'PAUSED', clockTick: planned.tick - 1 });
    expect(await loop.advanceTo(planned.tick)).toEqual([]);
    expect(await snapshot(f.worldId)).toEqual(paused);
    await controlClock(db, f.worldId, 'resume');
    expect(await loop.advanceTo(planned.tick)).toEqual([{ generalId: 1, tick: planned.tick, commandKey: 'attack' }]);
    expect(await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).toMatchObject({
      status: 'RUNNING',
      clockTick: planned.tick,
    });
    expect(
      await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } }),
    ).toMatchObject({
      nationId: 1,
    });
    expect(await db.generalLog.findMany({ where: { worldId: f.worldId, generalId: 1 } })).toMatchObject([
      { tick: planned.tick, commandKey: 'attack', kind: 'success' },
    ]);
    const after = await rpc('turns.get', { worldId: f.worldId }, f.commander.cookie);
    expect(after.revision).toBe(saved.revision + 1);
    expect(after.slots.slice(0, 29)).toEqual(saved.slots.slice(1));
    expect(after.slots[29]).toMatchObject({ commandKey: 'rest', explicit: false });
  });

  it('제안 뒤 다른 편집이 있으면 낡은 저장은 STALE과 최신 칸만 돌려주고 저장하지 않는다', async () => {
    const f = await fixture(true);
    const operation = await createOperation(f);
    const suggestion = await rpc('operation.suggest', { worldId: f.worldId, id: operation.id }, f.commander.cookie);
    expect(suggestion.noop).toBeNull();
    expect(suggestion.changed).toEqual([0]);
    const edited = await rpc(
      'turns.edit',
      {
        worldId: f.worldId,
        revision: suggestion.revision,
        op: { put: { from: 8, to: 8, commandKey: 'rest', args: {} } },
      },
      f.commander.cookie,
    );
    expect(edited.ok).toBe(true);
    expect(edited.slots[8]).toMatchObject({ commandKey: 'rest', explicit: true });
    const beforeSave = await snapshot(f.worldId);
    const stale = await rpc(
      'turns.set',
      { worldId: f.worldId, revision: suggestion.revision, slots: toSaveSlots(applySuggestion(suggestion)) },
      f.commander.cookie,
    );
    expect(stale).toEqual({ ok: false, reason: 'STALE', revision: edited.revision, slots: edited.slots });
    expect(await snapshot(f.worldId)).toEqual(beforeSave);
    expect(await rpc('turns.get', { worldId: f.worldId }, f.commander.cookie)).toEqual({
      revision: edited.revision,
      slots: edited.slots,
    });
    expect(stale.slots[8]).toMatchObject({ commandKey: 'rest', explicit: true });
    expect(stale.slots[9]).toMatchObject({ commandKey: 'rest', explicit: false });
    const reapplied = applySuggestion(suggestion, stale.slots);
    const retry = await rpc(
      'turns.set',
      { worldId: f.worldId, revision: stale.revision, slots: toSaveSlots(reapplied) },
      f.commander.cookie,
    );
    expect(retry.ok).toBe(true);
    expect(retry.revision).toBe(stale.revision + 1);
    expect(retry.slots.map(toTurn)).toEqual(reapplied);
    const reread = await rpc('turns.get', { worldId: f.worldId }, f.commander.cookie);
    expect(reread).toEqual({ revision: retry.revision, slots: retry.slots });
    expect(reread.slots[0]).toMatchObject({ commandKey: 'attack', args: { cityKey: 2 }, explicit: true });
    expect(reread.slots[8]).toMatchObject({ commandKey: 'rest', explicit: true });
    expect(reread.slots[9]).toMatchObject({ commandKey: 'rest', explicit: false });
  });

  it('열린 작전이 있는 국가의 마지막 도시 점령은 보존·수도 참조 정리·Cascade를 함께 저장한다', async () => {
    const f = await fixture();
    const survivor = await createOperation(f);
    const removed = await createOperation(f, true);
    const saved = await rpc(
      'turns.set',
      {
        worldId: f.worldId,
        revision: 0,
        slots: Array.from({ length: 30 }, (_, slot) =>
          slot === 0 ? { commandKey: 'attack', args: { cityKey: 2 } } : null,
        ),
      },
      f.commander.cookie,
    );
    expect(saved.ok).toBe(true);
    const before = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
    const victim = await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 2 } } });
    expect(victim.capitalCityKey).toBe(2);
    expect(await db.city.count({ where: { worldId: f.worldId, nationId: 2 } })).toBe(1);
    expect(await db.operation.findUniqueOrThrow({ where: { id: removed.id } })).toMatchObject({
      status: 'OPEN',
      nationId: 2,
    });
    expect(await db.operationMember.count({ where: { operationId: removed.id } })).toBe(2);
    const kept = await db.operation.findUniqueOrThrow({
      where: { id: survivor.id },
      include: { members: { orderBy: { generalId: 'asc' } } },
    });
    const removalOrder: string[] = [];
    // 질의 인자와 결과는 그대로 넘기고 실제 질의가 성공한 뒤 순서만 기록한다.
    // 이 연결은 fixture 준비·afterAll 정리에는 쓰지 않는다.
    const observed = db.$extends({
      query: {
        removedNation: {
          async create({ args, query }) {
            const row = await query(args);
            if (row.worldId === f.worldId && row.nationId === 2) removalOrder.push('archive');
            return row;
          },
        },
        nation: {
          async update({ args, query }) {
            const row = await query(args);
            if (row.worldId === f.worldId && row.id === 2 && args.data.capitalCityKey === null) {
              expect(row.capitalCityKey).toBeNull();
              removalOrder.push('clear-capital');
            }
            return row;
          },
          async delete({ args, query }) {
            const row = await query(args);
            if (row.worldId === f.worldId && row.id === 2) {
              expect(row.capitalCityKey).toBeNull();
              removalOrder.push('delete');
            }
            return row;
          },
        },
      },
    });
    // Prisma 확장은 같은 DB·트랜잭션을 쓰지만 $on 노출과 $transaction 제네릭 시그니처가 원형 타입과 다르다.
    // TurnLoop가 쓰는 실제 $transaction과 질의는 확장 연결이 그대로 실행한다.
    const loop = await engine(f.worldId, observed as unknown as typeof db);
    expect(await loop.advanceTo(100)).toEqual([{ generalId: 1, tick: 100, commandKey: 'attack' }]);
    expect(removalOrder).toEqual(['archive', 'clear-capital', 'delete']);
    const world = await db.world.findUniqueOrThrow({ where: { id: f.worldId } });
    expect(world).toMatchObject({ status: 'RUNNING', clockTick: 100, actionSequence: before.actionSequence + 1 });
    expect(await db.generalLog.findMany({ where: { worldId: f.worldId, generalId: 1 } })).toMatchObject([
      { tick: 100, commandKey: 'attack', kind: 'success' },
    ]);
    expect(
      await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } }),
    ).toMatchObject({
      nationId: 1,
    });
    expect(
      await db.removedNation.findUniqueOrThrow({ where: { worldId_nationId: { worldId: f.worldId, nationId: 2 } } }),
    ).toEqual({
      worldId: f.worldId,
      nationId: 2,
      name: victim.name,
      color: victim.color,
      removedTick: 100,
      removedSequence: world.actionSequence,
    });
    expect(await db.nation.findUnique({ where: { worldId_id: { worldId: f.worldId, id: 2 } } })).toBeNull();
    expect(await db.operation.findUnique({ where: { id: removed.id } })).toBeNull();
    expect(await db.operationMember.count({ where: { operationId: removed.id } })).toBe(0);
    expect(
      await db.operation.findUniqueOrThrow({
        where: { id: survivor.id },
        include: { members: { orderBy: { generalId: 'asc' } } },
      }),
    ).toEqual(kept);
    expect(await db.operation.count({ where: { worldId: f.worldId } })).toBe(1);
  });
});
