import { randomUUID } from 'node:crypto';
import { rngFor } from '../packages/shared/src/index';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildInitialWorld, unitSetSchema, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const db = createDb(url.href),
  worlds: string[] = [],
  users: string[] = [];
const now = Date.now(),
  app = await buildServer({ db, now: () => now, logging: false });
let base: string, worldId: string, cookie: string;
let userId: string;
let generalId: number, actorTick: number;
const reason = '현재 선택할 수 없는 병종입니다. 대검병 연구가 필요합니다.';
async function rpc(path: string, input: unknown, mutation = false) {
  const encoded = JSON.stringify(input);
  const response = await fetch(`${base}/trpc/${path}${mutation ? '' : `?input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: { origin: 'http://127.0.0.1:5173', cookie, ...(mutation ? { 'content-type': 'application/json' } : {}) },
    ...(mutation ? { body: encoded } : {}),
  });
  const body = (await response.json()) as { result?: { data: unknown }; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!.data;
}
const snapshot = () => db.$transaction((tx) => loadReplayState(tx, worldId));
async function advance(tick: number, fail = false) {
  const lease = await acquireLease(db, worldId, randomUUID(), 120_000);
  if (!lease) throw Error('병종 시험의 실행권이 없습니다.');
  try {
    await new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw Error('int22 rollback');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
beforeAll(async () => {
  const input = operationalInput();
  let id: string;
  // 실제 생성 RNG에서 자기 도시·초반 offset인 계정만 고른다. 인사 원본의 NPC 소유권은 바꾸지 않는다.
  for (;;) {
    id = randomUUID();
    const rng = rngFor(input.seed, 'create', id);
    const city = rng.pick([1, 2]);
    rng.int(1, 150);
    const offset = rng.int(0, TICKS_PER_MONTH - 1);
    if (city === 1 && offset > 0 && offset <= 10) break;
  }
  userId = id;
  await db.user.create({
    data: { id, email: `${id}@example.invalid`, passwordHash: 'test-only', emailVerifiedAt: new Date(now) },
  });
  users.push(id);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  cookie = `sid=${session.token}`;
  const source = input.unitSet.crewTypes.find((row) => row.id === 1100)!;
  const unitSet = unitSetSchema.parse({
    ...input.unitSet,
    id: 'int22-conditions-test',
    crewTypes: [
      ...input.unitSet.crewTypes,
      { ...source, id: 1500, name: '연구 조건 고정물', requirements: [{ kind: 'research', name: 'greatsword' }] },
      { ...source, id: 1501, name: '기술 경계 고정물', requirements: [{ kind: 'tech', min: 0 }] },
    ],
  });
  const initial = buildInitialWorld({ ...input, unitSet });
  initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
  for (const general of initial.generals) general.nextTurnTick = 1_000_000_000;
  const saved = await saveInitialWorld(db, initial, {
    name: 'INT22 모집 조건 실제 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: initial.ruleFeatures,
  });
  worldId = saved.worldId;
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

it('실제 생성 입력과 임관으로 장수를 준비하고 원본 NPC 소유권을 보존한다', async () => {
  const creating = rpc(
    'general.create',
    {
      worldId,
      name: '조건검사',
      portraitId: null,
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
    },
    true,
  );
  void creating.catch(() => undefined);
  try {
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, userId, kind: 'general.create', status: 'PENDING' } }))
      .toBe(1);
    await advance(0);
    expect(await creating).toMatchObject({ status: 'created' });
  } finally {
    await Promise.allSettled([creating]);
  }
  const actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId } } });
  generalId = actor.id;
  actorTick = actor.nextTurnTick;
  expect(actorTick).toBeLessThanOrEqual(10);
  expect(
    await rpc(
      'turns.set',
      {
        worldId,
        revision: 0,
        slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
      },
      true,
    ),
  ).toMatchObject({ ok: true });
  await advance(actorTick);
  expect((await snapshot()).state.generals[generalId]).toMatchObject({ nationId: 1, cityKey: 1 });
  expect(await db.general.count({ where: { worldId, id: { in: [1, 2] }, userId: null } })).toBe(2);
});

it('저장한 모집 조건을 사전 검사와 실제 편성 큐에서 같은 이유로 거부한다', async () => {
  const before = await snapshot();
  expect(before.campaignUnitSet!.crewTypes.find((row) => row.id === 1500)?.requirements).toEqual([
    { kind: 'research', name: 'greatsword' },
  ]);
  expect(
    await rpc('turns.precheck', { worldId, commandKey: 'recruit', args: { amount: 1, crewType: 1500 } }),
  ).toMatchObject({ ok: false, code: 'BAD_STATE', message: reason });
  expect(hashState(await snapshot())).toBe(hashState(before));
  const requestId = randomUUID();
  expect(
    await rpc(
      'campaign.unit',
      {
        worldId,
        requestId,
        payload: { type: 'form', commanderId: generalId, crewType: 1500, revision: before.state.campaign!.revision },
      },
      true,
    ),
  ).toMatchObject({ status: 'pending' });
  await advance(actorTick);
  expect(await rpc('campaign.request', { worldId, requestId })).toMatchObject({
    status: 'rejected',
    result: { code: 'BAD_STATE', message: reason },
  });
  expect((await snapshot()).state).toEqual(before.state);
});

it('경계에서 허용한 편성의 rollback·한 번 적용·12개월 DB 재적재·순수 재생을 보존한다', async () => {
  const before = await snapshot(),
    requestId = randomUUID();
  await rpc(
    'campaign.unit',
    {
      worldId,
      requestId,
      payload: { type: 'form', commanderId: generalId, crewType: 1501, revision: before.state.campaign!.revision },
    },
    true,
  );
  await expect(advance(actorTick, true)).rejects.toThrow('int22 rollback');
  expect(await rpc('campaign.request', { worldId, requestId })).toMatchObject({ status: 'pending' });
  expect(hashState(await snapshot())).toBe(hashState(before));
  await advance(actorTick);
  expect(await rpc('campaign.request', { worldId, requestId })).toMatchObject({ status: 'applied' });
  expect((await snapshot()).state.campaign!.units).toEqual([
    { id: 1, ownerId: generalId, commanderId: generalId, crewType: 1501, troops: 0, train: 0, atmos: 0 },
  ]);
  await advance(12 * TICKS_PER_MONTH);
  const after = await snapshot(),
    archive = await exportReplay(db, worldId);
  expect(replayArchive(archive, 12).at(-1)!.stateHash).toBe(hashState(after));
  const reopened = createDb(url.href);
  try {
    expect(hashState(await reopened.$transaction((tx) => loadReplayState(tx, worldId)))).toBe(hashState(after));
  } finally {
    await reopened.$disconnect();
  }
});
