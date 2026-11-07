import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { lineageTestConfig } from '../packages/rules/src/lineage/testFixture';
import { CREATION_ERRORS, type LineageInput } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld, prepareInitialWorld, savePreparedInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { AppRouter } from '../apps/server/src/router';
import { loadInitialWorldFromDb, loadSexLedgers } from '../apps/engine/src/world/resources';
import { initializeIntegrationResources } from './integration-resources';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';

// AC-P2-32·35: 인공 4명·성인 등장 1년 설정의 실제 PG/HTTP/엔진이다.
// 정식 시나리오 성별 자료나 491명 전체 스케줄·공개 설정·CF 증거가 아니다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error('전용 가문 테스트 DB가 필요합니다.');
const target = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname) ||
  target.searchParams.has('host') ||
  target.searchParams.has('port')
)
  throw Error('loopback 전용 테스트 DB를 확인하세요.');
const db = createDb(url),
  worldIds: string[] = [],
  userIds: string[] = [],
  now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
let base: string;
type Out = inferRouterOutputs<AppRouter>;
type Results = {
  'general.create': Out['general']['create'];
  'general.mine': Out['general']['mine'];
  'lineage.get': Out['lineage']['get'];
  'lineage.submit': Out['lineage']['submit'];
  'lineage.request': Out['lineage']['request'];
  'message.send': Out['message']['send'];
  'admin.world.requestReset': Out['admin']['world']['requestReset'];
  'admin.world.resetRequest': Out['admin']['world']['resetRequest'];
};
type User = { id: string; cookie: string };
async function rpc<R extends keyof Results>(route: R, input: unknown, user?: User) {
  const mutation = ['general.create', 'lineage.submit', 'message.send', 'admin.world.requestReset'].includes(route),
    encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${route}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(user ? { cookie: user.cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  type Envelope = { result?: { data: Results[R] }; error?: { data: { code: string }; message: string } };
  const json = (await response.json()) as Envelope | Envelope[],
    body = Array.isArray(json) ? json[0]! : json;
  return { status: response.status, data: body.result?.data, error: body.error };
}
async function user(): Promise<User> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'not-a-login-hash' } });
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, cookie: `sid=${session.token}` };
}
async function world(lineage = true, peaceUntilTick = 300000, npcGenerations = false) {
  const initial = commandInitial();
  initial.seed = `lineage-pg-${randomUUID()}`;
  initial.diplomacies = initial.diplomacies.map((row) => ({
    ...row,
    state: 'NON_AGGRESSION',
    untilTick: peaceUntilTick,
  }));
  if (lineage) for (const g of initial.generals) g.sex = g.id === 2 ? 'MALE' : g.id === 3 ? 'FEMALE' : 'UNKNOWN';
  initial.generals[1]!.deathYear = initial.startYear + 1;
  const config = structuredClone(lineageTestConfig);
  config.birth.comingOfAgeYears = 1;
  config.marriage.npc.perMonth = 1;
  if (npcGenerations) {
    initial.seed = 'lineage-pg-npc-generations';
    for (const g of initial.generals)
      Object.assign(g, {
        sex: g.id <= 2 ? 'MALE' : 'FEMALE',
        nationId: 2,
        cityKey: 2,
        officerLevel: g.id === 2 ? 12 : 1,
        deathYear: initial.startYear + (g.id === 2 ? 1 : 2),
        nextTurnTick: 1_000_000_000,
      });
    config.marriage.npc.perMonth = 2;
    config.birth.lifespan = { min: 18, max: 18 };
    config.birth.givenNames = Array.from({ length: 128 }, (_, i) => String.fromCodePoint(0xac00 + i));
  }
  const saved = await saveInitialWorld(db, initial, {
    name: 'AC-P2-32 인공 4명',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: lineage ? ['lineage-v1', 'personnel', 'policy'] : ['personnel', 'policy'],
    ...(lineage ? { featureData: { 'lineage-v1': config } } : {}),
  });
  worldIds.push(saved.worldId);
  await controlClock(db, saved.worldId, 'start');
  return saved.worldId;
}
async function advance(worldId: string, tick: number, fail = false, connection = db) {
  // 운영 폴링과 달리 명시한 여러 달을 한 호출로 처리한다. 시험 제한 120초 안에서 실행권을 잡는다.
  const lease = await acquireLease(connection, worldId, randomUUID(), 120000);
  if (!lease) throw Error('가문 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(
      connection,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw Error('lineage-save-failure');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(connection, lease);
  }
}
const snapshot = (worldId: string) => db.$transaction((tx) => loadReplayState(tx, worldId));

async function stopInputProcess(worldId: string, tick: number, inputId: bigint, phase: 'beforeCommit' | 'committed') {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/engine/test/creationWorker.ts', worldId, phase, String(tick), String(inputId)],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, TEST_DATABASE_URL: target.href },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    },
  );
  const closed = once(child, 'close');
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
      closed.then(() => {
        throw Error('계승 중단 지점 전에 엔진이 끝났습니다.');
      }),
    ]);
    expect(message).toBe(phase);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual([null, 'SIGKILL']);
  } finally {
    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  const lease = await db.engineLease.findUniqueOrThrow({ where: { worldId } });
  await db.engineLease.update({
    where: { worldId, fencingToken: lease.fencingToken },
    data: { expiresAt: new Date(0) },
  });
  return lease.fencingToken;
}

it.each([
  { scenario: '1030', map: 'che', statRules: 'default', features: ['personnel', 'policy', 'lineage-v1'], count: 3 },
  {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    features: ['five-stats', 'operational-map', 'personnel', 'policy', 'lineage-v1'],
    count: 5,
  },
])(
  'AC-P2-32 $count 능력치 실제 491명 생성은 확인된 성별만 재생 원본·DB에 고정한다',
  async (profile) => {
    const initial = await loadInitialWorldFromDb(db, {
      scenario: profile.scenario,
      map: profile.map,
      statRules: profile.statRules,
      portraitMap: profile.count === 5 ? '191-map' : 'rtk14-map',
      seed: `lineage-sex-${profile.count}`,
    });
    expect(initial.generals).toHaveLength(491);
    initial.ruleFeatures = [...new Set([...(initial.ruleFeatures ?? []), ...profile.features])].sort();
    expect(initial.generals.every((general) => !Object.hasOwn(general, 'sex'))).toBe(true);
    const saved = await saveInitialWorld(db, initial, {
      name: `가문 성별 ${profile.count}능력치`,
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 3,
      ruleFeatures: [...profile.features].sort(),
      featureData: { 'lineage-v1': lineageTestConfig },
    });
    worldIds.push(saved.worldId);
    const replay = await snapshot(saved.worldId),
      generals = Object.values(replay.state.generals);
    expect(generals.filter((general) => general.sex !== 'UNKNOWN').map((general) => [general.id, general.sex])).toEqual(
      [
        [47, 'MALE'],
        [93, 'MALE'],
        [99, 'MALE'],
        [100, 'MALE'],
        [103, 'MALE'],
        [108, 'MALE'],
        [167, 'MALE'],
        [169, 'MALE'],
        [229, 'MALE'],
        [266, 'MALE'],
        [267, 'MALE'],
        [271, 'MALE'],
        [276, 'MALE'],
        [281, 'MALE'],
        [291, 'MALE'],
        [314, 'MALE'],
        [318, 'MALE'],
        [321, 'MALE'],
        [322, 'MALE'],
        [381, 'MALE'],
        [385, 'MALE'],
        [394, 'MALE'],
        [439, 'FEMALE'],
      ],
    );
    expect(Object.hasOwn(replay.state.generals[108]!, 'politics')).toBe(profile.count === 5);
    const stored = await db.world.findUniqueOrThrow({ where: { id: saved.worldId } }),
      origin = stored.replayOrigin as unknown as { initial: { generals: Array<{ id: number; sex: string }> } };
    expect(origin.initial.generals.find((general) => general.id === 439)?.sex).toBe('FEMALE');
    expect(await db.general.count({ where: { worldId: saved.worldId, sex: 'UNKNOWN' } })).toBe(468);
    await exportReplay(db, saved.worldId);
    expect(initial.generals.every((general) => !Object.hasOwn(general, 'sex'))).toBe(true);
  },
  120000,
);

it.each([
  { edition: 1, unknownCount: 489, guanSex: 'UNKNOWN' },
  { edition: 2, unknownCount: 477, guanSex: 'MALE' },
] as const)(
  'AC-P2-32 $edition 판은 실제 491명 저장·월간 재생·HTTP 관리자 초기화 뒤에도 유지된다',
  async ({ edition, unknownCount, guanSex }) => {
    const initial = await loadInitialWorldFromDb(db, {
        scenario: '1030',
        map: 'che',
        statRules: 'default',
        portraitMap: 'rtk14-map',
        seed: 'old-sex-edition-pg',
      }),
      ruleFeatures = ['lineage-v1', 'personnel', 'policy'];
    initial.ruleFeatures = ruleFeatures;
    const saved = await db.$transaction((tx) =>
      savePreparedInitialWorld(
        tx,
        prepareInitialWorld(
          initial,
          {
            name: `성별 원장 ${edition}판 보존`,
            turnTermMinutes: 60,
            endYear: null,
            replayFormat: 3,
            ruleFeatures,
            featureData: { 'lineage-v1': lineageTestConfig },
          },
          loadSexLedgers()[edition - 1],
        ),
      ),
    );
    const id = saved.worldId;
    worldIds.push(id);
    expect(await db.general.count({ where: { worldId: id } })).toBe(491);
    expect((await snapshot(id)).state.generals[47]?.sex).toBe(guanSex);
    expect((await snapshot(id)).state.generals[266]?.sex).toBe('UNKNOWN');
    expect(await db.general.count({ where: { worldId: id, sex: 'UNKNOWN' } })).toBe(unknownCount);
    const before = await exportReplay(db, id);
    await expect(db.$executeRaw`UPDATE "General" SET sex='MALE' WHERE "worldId"=${id} AND id=266`).rejects.toThrow(
      /General_sex_immutable|23514/,
    );
    expect(await exportReplay(db, id)).toEqual(before);
    await controlClock(db, id, 'start');
    await advance(id, 10000);
    expect((await snapshot(id)).state.generals[47]?.sex).toBe(guanSex);
    expect((await snapshot(id)).state.generals[266]?.sex).toBe('UNKNOWN');
    const archive = await exportReplay(db, id),
      replayed = replayArchive(archive, 1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.stateHash).toBe(hashState(await snapshot(id)));
    await controlClock(db, id, 'pause');
    const administrator = await user();
    await db.user.update({ where: { id: administrator.id }, data: { role: 'ADMIN' } });
    const current = await db.world.findUniqueOrThrow({ where: { id } }),
      binding = { worldId: id, expectedUserId: administrator.id, idempotencyKey: randomUUID() },
      admitted = await rpc(
        'admin.world.requestReset',
        {
          ...binding,
          confirmName: current.name,
          expectedRevision: current.clockRevision,
          reason: '기존 성별 판 보존 검증',
        },
        administrator,
      );
    expect(admitted.status).toBe(200);
    expect(admitted.data?.status).toBe('PENDING');
    await advance(id, 10000);
    const receipt = await rpc('admin.world.resetRequest', binding, administrator);
    expect(receipt.data?.status).toBe('APPLIED');
    const newId = receipt.data!.plannedNewWorldId;
    worldIds.push(newId);
    expect(newId).not.toBe(id);
    expect(await db.general.count({ where: { worldId: newId } })).toBe(491);
    expect((await snapshot(newId)).state.generals[47]?.sex).toBe(guanSex);
    expect((await snapshot(newId)).state.generals[266]?.sex).toBe('UNKNOWN');
    expect(await db.general.count({ where: { worldId: newId, sex: 'UNKNOWN' } })).toBe(unknownCount);
    expect((await snapshot(id)).state.generals[47]?.sex).toBe(guanSex);
  },
  120000,
);
async function create(worldId: string, player: User, name: string, sex: 'MALE' | 'FEMALE') {
  const creating = rpc(
    'general.create',
    { worldId, name, leadership: 70, strength: 70, intel: 60, portraitId: null, sex },
    player,
  );
  const deadline = performance.now() + 5000;
  while (
    !(await db.inputEvent.findFirst({
      where: { worldId, userId: player.id, kind: 'general.create', status: 'PENDING' },
    }))
  ) {
    if (performance.now() > deadline)
      throw Error(`가문 장수 생성 대기 기록이 없습니다: ${JSON.stringify(await creating)}`);
    await delay(10);
  }
  await advance(worldId, (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick);
  const result = await creating;
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  if (result.data?.status !== 'created') throw Error('실제 장수 생성이 끝나지 않았습니다.');
  return result.data.general.id;
}
for (const route of ['lineage.get', 'lineage.submit', 'lineage.request'] as const)
  for (const category of categories)
    it(
      `${route} ${category}`,
      authzCase(route, category, async () => {
        const id = await world(),
          owner = await user(),
          stranger = await user(),
          actorId = await create(id, owner, '권한가문', 'MALE'),
          requestId = randomUUID(),
          input = {
            worldId: id,
            expectedUserId: owner.id,
            expectedGeneralId: actorId,
            requestId,
            payload: { type: 'heir.designate' as const, heirGeneralId: null },
          };
        expect((await rpc('lineage.submit', input, owner)).status).toBe(200);
        const before = hashState(await snapshot(id)),
          count = await db.inputEvent.count({ where: { worldId: id } }),
          caller = category === 'unauthenticated' ? undefined : category === 'otherUser' ? stranger : owner;
        const sanction =
          category === 'sanctioned'
            ? await db.sanction.create({
                data: {
                  userId: owner.id,
                  worldId: id,
                  createdBy: owner.id,
                  reason: '가문 권한 범주 검증',
                },
              })
            : null;
        try {
          const value =
            category === 'invalidInput'
              ? { worldId: id, unknown: true }
              : route === 'lineage.get'
                ? { worldId: id, generalId: actorId }
                : route === 'lineage.request'
                  ? { worldId: id, requestId }
                  : { ...input, expectedUserId: caller?.id ?? owner.id };
          const result = await rpc(route, value, caller);
          const expected =
            category === 'unauthenticated'
              ? 401
              : category === 'invalidInput'
                ? 400
                : category === 'otherUser' && route !== 'lineage.get'
                  ? 404
                  : category === 'sanctioned' && route === 'lineage.submit'
                    ? 403
                    : 200;
          expect(result.status, `${route} ${category}: ${JSON.stringify(result.error)}`).toBe(expected);
          if (route === 'lineage.get' && result.status === 200) {
            const board = result.data as Out['lineage']['get'];
            expect(board.userId).toBe(caller!.id);
            if (category === 'otherUser') expect(board.view.mine).toBeNull();
            else expect(board.view.mine?.generalId).toBe(actorId);
            if (category === 'sanctioned') expect(board.canSubmit).toBe(false);
          }
          if (route === 'lineage.request' && result.status === 200)
            expect(result.data).toMatchObject({ userId: owner.id, requestId, status: 'pending' });
          expect(hashState(await snapshot(id))).toBe(before);
          expect(await db.inputEvent.count({ where: { worldId: id } })).toBe(count);
          expect(await db.inputEvent.count({ where: { worldId: id, kind: 'lineage.act' } })).toBe(1);
        } finally {
          if (sanction) await db.sanction.delete({ where: { id: sanction.id } });
        }
      }),
      60000,
    );

async function send(worldId: string, player: User, generalId: number, payload: LineageInput, requestId = randomUUID()) {
  const input = { worldId, expectedUserId: player.id, expectedGeneralId: generalId, requestId, payload };
  const submitted = await rpc('lineage.submit', input, player);
  expect(submitted.status, JSON.stringify(submitted.error)).toBe(200);
  await advance(worldId, (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick);
  const result = await rpc('lineage.request', { worldId, requestId }, player);
  expect(result.data?.status, JSON.stringify(result.error ?? result.data)).toBe('applied');
  return { input, result };
}
beforeAll(async () => {
  await initializeIntegrationResources(db);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app.close();
    await db.world.deleteMany({ where: { id: { in: worldIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await db.$disconnect();
  }
});

it('AC-P2-32 실제 migration은 성별 변경·잘못된 값과 꺼진 판의 상태를 거부하고 구형 해시는 유지한다', async () => {
  const id = await world(),
    oldId = await world(false),
    before = await snapshot(oldId);
  expect(Object.hasOwn(before.state.generals[1]!, 'sex')).toBe(false);
  expect(Object.hasOwn(before, 'lineageResources')).toBe(false);
  const invalidPlayer = await user();
  for (const sex of ['UNKNOWN', 'invalid']) {
    const invalid = await rpc(
      'general.create',
      { worldId: id, name: '성별오류', leadership: 70, strength: 70, intel: 60, portraitId: null, sex },
      invalidPlayer,
    );
    expect(invalid.error?.data.code).toBe('BAD_REQUEST');
    expect(invalid.error?.message).toBe(CREATION_ERRORS.BAD_SEX);
  }
  await expect(
    db.general.update({ where: { worldId_id: { worldId: id, id: 2 } }, data: { sex: 'FEMALE' } }),
  ).rejects.toThrow();
  await expect(
    db.general.create({
      data: { ...commandInitial().generals[0]!, id: 900, name: '오류성별', worldId: id, sex: 'INVALID' },
    }),
  ).rejects.toThrow();
  await db.general.update({ where: { worldId_id: { worldId: oldId, id: 1 } }, data: { sex: null } });
  expect(hashState(await snapshot(oldId))).toBe(hashState(before));
  const stranger = await user();
  expect((await rpc('lineage.get', { worldId: id })).error?.data.code).toBe('UNAUTHORIZED');
  expect((await rpc('lineage.get', { worldId: oldId }, stranger)).error?.data.code).toBe('PRECONDITION_FAILED');
});

it('AC-P2-32 출생 트랜잭션 실패는 새 행·예약을 모두 되돌리고 재시작 뒤 24개월 NPC 계승과 재생이 같다', async () => {
  const id = await world();
  await advance(id, 9999);
  const before = await snapshot(id);
  await expect(advance(id, 10000, true)).rejects.toThrow('lineage-save-failure');
  expect(hashState(await snapshot(id))).toBe(hashState(before));
  expect(await db.general.count({ where: { worldId: id } })).toBe(4);
  expect(await db.generalLog.count({ where: { worldId: id, commandKey: 'lineage.birth' } })).toBe(0);
  const restarted = createDb(url!);
  try {
    await advance(id, 10000, false, restarted);
  } finally {
    await restarted.$disconnect();
  }
  expect(await db.general.count({ where: { worldId: id } })).toBe(5);
  expect(await db.generalLog.count({ where: { worldId: id, commandKey: 'lineage.birth' } })).toBe(3);
  await advance(id, 240000);
  const state = await snapshot(id),
    parent = state.state.lineage!.persons['2'];
  expect(state.monthlyTick, JSON.stringify({ npc: state.state.generals[2], person: parent })).toBe(240000);
  expect(parent?.exit?.cause, JSON.stringify({ npc: state.state.generals[2], person: parent })).toBe('DIED');
  expect(parent?.successorId).not.toBeNull();
  const heir = parent!.successorId!;
  expect(state.state.generals[heir]).toMatchObject({ officerLevel: 12, userId: null });
  expect(state.state.generals[2]).toMatchObject({
    userId: null,
    nationId: null,
    officerLevel: 0,
    crew: 0,
    gold: 0,
    rice: 0,
  });
  const archive = await exportReplay(db, id);
  const replayed = replayArchive(archive, 24);
  expect(replayed).toHaveLength(24);
  expect(replayed.map((month) => month.stateHash)).toEqual(archive.months.map((month) => month.stateHash));
  expect(replayed.at(-1)!.stateHash).toBe(hashState(state));
}, 120000);

it('AC-P2-32 후계자 조작권 저장 실패와 실제 SIGKILL 뒤 계승은 한 번만 적용된다', async () => {
  const id = await world(),
    father = await user(),
    mother = await user(),
    from = await create(id, father, '복구가문부', 'MALE'),
    mom = await create(id, mother, '복구가문모', 'FEMALE');
  const offered = await send(id, father, from, { type: 'marriage.propose', targetGeneralId: mom });
  if (offered.result.data?.status !== 'applied') throw Error('혼인 제안 결과가 없습니다.');
  await send(id, mother, mom, {
    type: 'marriage.respond',
    offerId: offered.result.data.result.offerId!,
    accept: true,
  });
  await advance(id, 10000);
  const child = Object.entries((await snapshot(id)).state.lineage!.persons).find(([, p]) =>
    p.parents.some((parent) => parent === from),
  );
  if (!child) throw Error('실제 출생한 자녀가 없습니다.');
  const heir = Number(child[0]);
  expect(Number.isSafeInteger(heir)).toBe(true);
  expect(heir).toBeGreaterThan(from);
  for (let month = 2; month <= 12; month++) {
    await send(id, father, from, { type: 'heir.designate', heirGeneralId: null });
    await send(id, mother, mom, { type: 'heir.designate', heirGeneralId: null });
    await advance(id, month * 10000);
  }
  await send(id, father, from, { type: 'heir.designate', heirGeneralId: heir });
  const board = await rpc('lineage.get', { worldId: id }, father),
    preview = board.data?.view.mine?.preview;
  if (!preview) throw Error('성인이 된 후계자의 미리보기가 없습니다.');
  const input = {
    worldId: id,
    expectedUserId: father.id,
    expectedGeneralId: from,
    requestId: randomUUID(),
    payload: { type: 'succession.confirm' as const, heirGeneralId: heir, expected: preview },
  };
  expect((await rpc('lineage.submit', input, father)).data?.status).toBe('pending');
  const footprint = async () => ({
    replay: await snapshot(id),
    generals: await db.general.findMany({ where: { worldId: id }, orderBy: { id: 'asc' } }),
    turns: await db.generalTurn.findMany({ where: { worldId: id }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    world: await db.world.findUniqueOrThrow({
      where: { id },
      select: { clockTick: true, actionSequence: true, lineageState: true },
    }),
    inputs: await db.inputEvent.findMany({ where: { worldId: id }, orderBy: { id: 'asc' } }),
    logs: await db.generalLog.findMany({ where: { worldId: id }, orderBy: { id: 'asc' } }),
    history: await db.nationHistory.findMany({
      where: { worldId: id },
      orderBy: [{ tick: 'asc' }, { nationId: 'asc' }],
    }),
  });
  const before = await footprint(),
    requestKey = `lineage:${input.requestId}`;
  expect(before.replay.state.generals[from]).toMatchObject({ userId: father.id });
  expect(before.replay.state.generals[from]!.gold).toBeGreaterThan(0);
  expect(before.replay.state.generals[from]!.rice).toBeGreaterThan(0);
  expect(before.replay.state.generals[heir]).toMatchObject({ userId: null });
  const request = before.inputs.find((row) => row.idempotencyKey === requestKey);
  expect(request).toMatchObject({ kind: 'lineage.act', status: 'PENDING' });
  // 이름과 SQL 본문에 넣는 값은 이 시험이 만든 식별자뿐이다.
  expect(id).toMatch(/^[\w-]+$/);
  expect(father.id).toMatch(/^[\w-]+$/);
  const fault = `lineage_control_${randomUUID().replaceAll('-', '')}`;
  const objects = () => db.$queryRaw<Array<{ triggers: number; functions: number }>>`
    SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname=${fault}) AS triggers,
      (SELECT count(*)::int FROM pg_proc WHERE proname=${fault}) AS functions`;
  expect(await objects()).toEqual([{ triggers: 0, functions: 0 }]);
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await db.$executeRawUnsafe(`CREATE FUNCTION "${fault}"() RETURNS trigger LANGUAGE plpgsql AS $fault$
      BEGIN
        IF NEW."worldId" = '${id}' AND NEW.id = ${heir}
          AND OLD."userId" IS NULL AND NEW."userId" = '${father.id}' THEN
          IF NOT EXISTS (SELECT 1 FROM "General" WHERE "worldId" = '${id}' AND id = ${from}
            AND "userId" IS NULL AND gold = 0 AND rice = 0) THEN
            RAISE EXCEPTION 'lineage-predecessor-observation-failed';
          END IF;
          RAISE EXCEPTION 'lineage-heir-control-save-failure';
        END IF;
        RETURN NEW;
      END;
    $fault$`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${fault}" AFTER UPDATE ON "General" FOR EACH ROW EXECUTE FUNCTION "${fault}"()`,
    );
    // 전임자의 해제·자산 저장이 끝난 뒤 후계자 UPDATE에서 막아 문장 사이 롤백을 본다.
    await expect(advance(id, before.world.clockTick)).rejects.toThrow('lineage-heir-control-save-failure');
    expect(await footprint()).toEqual(before);
    expect(hashState(await snapshot(id))).toBe(hashState(before.replay));
    expect(await db.general.findMany({ where: { worldId: id, userId: father.id }, select: { id: true } })).toEqual([
      { id: from },
    ]);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${fault}" ON "General"`);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fault}"()`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], '계승 시험과 정리 실패');
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '계승 시험 정리 실패');
  expect(await objects()).toEqual([{ triggers: 0, functions: 0 }]);
  const tick = before.world.clockTick;
  const beforeCommitToken = await stopInputProcess(id, tick, request!.id, 'beforeCommit');
  expect(await footprint()).toEqual(before);
  const committedToken = await stopInputProcess(id, tick, request!.id, 'committed');
  expect(committedToken).toBeGreaterThan(beforeCommitToken);
  const receipt = await rpc('lineage.request', { worldId: id, requestId: input.requestId }, father);
  expect(receipt.data?.status, JSON.stringify(receipt.error ?? receipt.data)).toBe('applied');
  const applied = await footprint();
  expect(applied.replay.state.generals[from]).toMatchObject({ userId: null, gold: 0, rice: 0 });
  expect(applied.replay.state.generals[heir]).toMatchObject({
    userId: father.id,
    gold: preview.gold,
    rice: preview.rice,
  });
  expect(applied.inputs.filter((row) => row.idempotencyKey === requestKey)).toMatchObject([{ status: 'APPLIED' }]);
  expect(applied.logs.length).toBeGreaterThan(before.logs.length);
  expect(await db.general.findMany({ where: { worldId: id, userId: father.id }, select: { id: true } })).toEqual([
    { id: heir },
  ]);
  const recovered = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'apps/engine/test/presetWorker.ts', id, String(tick)],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, TEST_DATABASE_URL: target.href },
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  const appliedHash = hashState(applied.replay);
  expect(JSON.parse(recovered)).toMatchObject({ beforeHash: appliedHash, afterHash: appliedHash });
  expect((await db.engineLease.findUniqueOrThrow({ where: { worldId: id } })).fencingToken).toBeGreaterThan(
    committedToken,
  );
  expect(await footprint()).toEqual(applied);
  expect((await rpc('lineage.submit', input, father)).data?.status).toBe('applied');
  expect(
    (
      await rpc(
        'lineage.submit',
        { ...input, requestId: randomUUID(), payload: { type: 'heir.designate', heirGeneralId: null } },
        father,
      )
    ).error?.data.code,
  ).toBe('CONFLICT');
  expect(await footprint()).toEqual(applied);
  await advance(id, 129999);
  const lease = await acquireLease(db, id, randomUUID(), 120000);
  if (!lease) throw Error('계승 재생 검증의 실행권이 없습니다.');
  const completed = new AbortController();
  try {
    await new TurnLoop(db, lease, {
      commitMetricSink: async (metric) => {
        if (metric.kind === 'monthly' && metric.tick === 130000) completed.abort();
      },
    }).advanceTo(130000, completed.signal);
    expect(completed.signal.aborted).toBe(true);
  } finally {
    await releaseLease(db, lease);
  }
  const archive = await exportReplay(db, id),
    replayed = replayArchive(archive, 13);
  expect(replayed).toHaveLength(13);
  expect(replayed.map((month) => month.stateHash)).toEqual(archive.months.map((month) => month.stateHash));
  expect(replayed.at(-1)!.stateHash).toBe(hashState(await snapshot(id)));
}, 120000);

it('AC-P2-32 NPC 부모·자녀·손자녀 자동 계승은 연결 재개 뒤에도 같은 사슬과 월간 재생을 보존한다', async () => {
  // 인공4명·출생자 수명18년·성인 등장1년이다. 혼인·부모 최소16과 실제 자손의 명령은 유지한다.
  const id = await world(true, 2_400_000, true);
  let connection = createDb(url!),
    heir = 0,
    grandchild = 0,
    months = 12;
  try {
    for (; months <= 240; months += 12) {
      await advance(id, months * 10000, false, connection);
      const state = (await snapshot(id)).state,
        successor = state.lineage!.persons['2']?.successorId;
      if (!heir && successor) {
        heir = successor;
        expect(state.lineage!.persons[String(heir)]!.parents).toContain(2);
        expect(state.generals[heir]).toMatchObject({ userId: null, nationId: 2, officerLevel: 12 });
        await connection.$disconnect();
        connection = createDb(url!);
      }
      if (heir) grandchild = state.lineage!.persons[String(heir)]!.successorId ?? 0;
      if (grandchild) break;
    }
  } finally {
    await connection.$disconnect();
  }
  const saved = await snapshot(id),
    state = saved.state,
    people = state.lineage!.persons;
  expect(heir, JSON.stringify(people)).toBeGreaterThan(0);
  expect(grandchild, JSON.stringify(people)).toBeGreaterThan(0);
  expect(people['2']).toMatchObject({ successorId: heir, exit: { cause: 'DIED' } });
  expect(people[String(heir)]).toMatchObject({ successorId: grandchild, exit: { cause: 'DIED' } });
  expect(people[String(heir)]!.parents).toContain(2);
  expect(people[String(grandchild)]!.parents).toContain(heir);
  for (const predecessor of [2, heir])
    expect(state.generals[predecessor]).toMatchObject({
      userId: null,
      nationId: null,
      officerLevel: 0,
      crew: 0,
      gold: 0,
      rice: 0,
    });
  expect(
    Object.values(state.generals)
      .filter((g) => g.nationId === 2 && g.officerLevel === 12)
      .map((g) => g.id),
  ).toEqual([grandchild]);
  expect(await db.general.count({ where: { worldId: id, userId: { not: null } } })).toBe(0);
  expect(await db.inputEvent.count({ where: { worldId: id } })).toBe(0);
  const archive = await exportReplay(db, id),
    replayed = replayArchive(archive, months);
  expect(replayed).toHaveLength(months);
  expect(replayed.map((month) => month.stateHash)).toEqual(archive.months.map((month) => month.stateHash));
  expect(replayed.at(-1)!.stateHash).toBe(hashState(saved));
  console.info('NPC_GENERATIONS', { months, chain: [2, heir, grandchild], stateHash: replayed.at(-1)!.stateHash });
}, 120000);

it('AC-P2-32 실제 218개월 두 번의 동의 계승은 단일 조작권·이전 영수증·다세대 재생을 보존한다', async () => {
  // 혼인·출생 최소 연령16은 유지한다. 기존 인공 설정의 성인 등장1년과 이 사례의 장기 불가침만 쓴다.
  const id = await world(true, 2_400_000),
    player = await user(),
    mother = await user(),
    from = await create(id, player, '계승시조', 'MALE'),
    mom = await create(id, mother, '계승초모', 'FEMALE');
  const offered = await send(id, player, from, { type: 'marriage.propose', targetGeneralId: mom });
  if (offered.result.data?.status !== 'applied') throw Error('첫 혼인 제안 결과가 없습니다.');
  await send(id, mother, mom, { type: 'marriage.respond', offerId: offered.result.data.result.offerId!, accept: true });
  await advance(id, 10000);
  const born = await snapshot(id),
    heir = Number(Object.entries(born.state.lineage!.persons).find(([, p]) => p.parents.some((id) => id === from))![0]);
  async function succeed(predecessor: number, successor: number) {
    await send(id, player, predecessor, { type: 'heir.designate', heirGeneralId: successor });
    const board = await rpc('lineage.get', { worldId: id }, player),
      preview = board.data?.view.mine?.preview;
    if (!preview) throw Error('후계자의 계승 미리보기가 없습니다.');
    return send(id, player, predecessor, { type: 'succession.confirm', heirGeneralId: successor, expected: preview });
  }
  await advance(id, 120000);
  const first = await succeed(from, heir);
  await advance(id, 1_000_000);
  const reconnected = createDb(url!);
  try {
    await advance(id, 2_000_000, false, reconnected);
  } finally {
    await reconnected.$disconnect();
  }
  const adult = (await snapshot(id)).state.generals[heir]!;
  expect(adult.age).toBeGreaterThanOrEqual(16);
  expect(['MALE', 'FEMALE']).toContain(adult.sex);
  const partner = await user(),
    spouse = await create(id, partner, '계승배우', adult.sex === 'MALE' ? 'FEMALE' : 'MALE');
  const secondOffer = await send(id, player, heir, { type: 'marriage.propose', targetGeneralId: spouse });
  if (secondOffer.result.data?.status !== 'applied') throw Error('다음 세대 혼인 제안 결과가 없습니다.');
  await send(id, partner, spouse, {
    type: 'marriage.respond',
    offerId: secondOffer.result.data.result.offerId!,
    accept: true,
  });
  let grandchild = 0;
  for (let month = 201; month <= 205; month++) {
    await advance(id, month * 10000);
    const born = await snapshot(id),
      child = Object.entries(born.state.lineage!.persons).find(([, person]) =>
        person.parents.some((id) => id === heir),
      );
    if (child) {
      grandchild = Number(child[0]);
      break;
    }
  }
  expect(grandchild).toBeGreaterThan(0);
  const nextBirth = await snapshot(id);
  expect(nextBirth.state.lineage!.persons[String(grandchild)]!.parents).toEqual(expect.arrayContaining([heir, spouse]));
  // 등장 직후 동의한다. NPC가 이후 스스로 다른 나라에 임관하면 같은 국가 조건으로 계승할 수 없다.
  const activationTick = (nextBirth.state.generals[grandchild]!.activeFromYear - nextBirth.state.startYear) * 120000;
  expect(activationTick).toBeGreaterThanOrEqual(nextBirth.monthlyTick);
  await advance(id, activationTick);
  const eligible = await snapshot(id);
  expect(eligible.state.generals[grandchild]!.nationId).toBe(eligible.state.generals[heir]!.nationId);
  const second = await succeed(heir, grandchild),
    after = await snapshot(id);
  expect(after.state.lineage!.persons[String(from)]!.successorId).toBe(heir);
  expect(after.state.lineage!.persons[String(heir)]!.successorId).toBe(grandchild);
  expect(after.state.generals[grandchild]!.userId).toBe(player.id);
  expect(
    Object.values(after.state.generals)
      .filter((general) => general.userId === player.id)
      .map((general) => general.id),
  ).toEqual([grandchild]);
  expect(await db.general.count({ where: { worldId: id, userId: player.id } })).toBe(1);
  for (const predecessor of [from, heir]) {
    expect(after.state.generals[predecessor]).toMatchObject({ userId: null, gold: 0, rice: 0 });
    const stale = await rpc(
      'lineage.submit',
      {
        worldId: id,
        expectedUserId: player.id,
        expectedGeneralId: predecessor,
        requestId: randomUUID(),
        payload: { type: 'heir.designate', heirGeneralId: null },
      },
      player,
    );
    expect(stale.error?.data.code).toBe('CONFLICT');
  }
  const beforeReceipts = hashState(await snapshot(id));
  for (const confirmed of [first, second]) {
    expect((await rpc('lineage.submit', confirmed.input, player)).data?.status).toBe('applied');
    expect(
      await db.inputEvent.count({ where: { worldId: id, idempotencyKey: `lineage:${confirmed.input.requestId}` } }),
    ).toBe(1);
  }
  expect(hashState(await snapshot(id))).toBe(beforeReceipts);
  await advance(id, 2_180_000);
  const final = await snapshot(id),
    archive = await exportReplay(db, id),
    replayed = replayArchive(archive, 218);
  expect(final.monthlyTick).toBe(2_180_000);
  expect(replayed).toHaveLength(218);
  expect(replayed.map((month) => month.stateHash)).toEqual(archive.months.map((month) => month.stateHash));
  expect(replayed.at(-1)!.stateHash).toBe(hashState(final));
}, 180000);

it('AC-P2-32 조회 대상은 행위자가 아니며 접수 뒤 제재도 엔진에서 다시 검사한다', async () => {
  const owner = await user(),
    stranger = await user(),
    id = await world(),
    from = await create(id, owner, '권한검증', 'MALE');
  await advance(id, 120000);
  const before = await snapshot(id);
  expect(before.state.generals[from]!.userId).toBe(owner.id);
  const board = await rpc('lineage.get', { worldId: id, generalId: 2 }, owner);
  expect(board.data?.view.actorId).toBe(from);
  expect(board.data?.view.mine?.generalId).toBe(from);
  expect(
    board.data?.view.mine?.marriageCandidates.find((row: { generalId: number }) => row.generalId === 2)?.failure,
  ).toMatchObject({ code: 'UNAVAILABLE' });
  const input = {
    worldId: id,
    expectedUserId: owner.id,
    expectedGeneralId: from,
    requestId: randomUUID(),
    payload: { type: 'heir.designate', heirGeneralId: null },
  };
  expect((await rpc('lineage.submit', { ...input, expectedUserId: stranger.id }, owner)).error?.data.code).toBe(
    'CONFLICT',
  );
  expect((await rpc('lineage.submit', { ...input, expectedGeneralId: 2 }, owner)).error?.data.code).toBe('CONFLICT');
  expect(
    (await rpc('lineage.submit', { ...input, payload: { ...input.payload, foreign: 'unexpected' } }, owner)).error?.data
      .code,
  ).toBe('BAD_REQUEST');
  expect((await rpc('lineage.submit', input, owner)).data?.status).toBe('pending');
  const sanction = await db.sanction.create({
    data: { userId: owner.id, worldId: id, createdBy: owner.id, reason: '가문 실제 제재 검사' },
  });
  try {
    expect((await rpc('lineage.submit', { ...input, requestId: randomUUID() }, owner)).error?.data.code).toBe(
      'FORBIDDEN',
    );
    await advance(id, 120000);
    const receipt = await rpc('lineage.request', { worldId: id, requestId: input.requestId }, owner);
    expect(receipt.data?.status).toBe('rejected');
    if (receipt.data?.status !== 'rejected') throw Error('제재된 가문 입력이 거절되지 않았습니다.');
    expect(receipt.data.result.code).toBe('ACTOR_SANCTIONED');
    expect((await snapshot(id)).state.lineage).toEqual(before.state.lineage);
  } finally {
    await db.sanction.delete({ where: { id: sanction.id } });
  }
}, 120000);

it.each([false, true])(
  'AC-P2-32 사람 혼인·동의 계승·UUID 실제 저장 (발령 저장 고정물=%s)',
  async (withAssignment) => {
    const id = await world(),
      father = await user(),
      mother = await user(),
      other = await user();
    const from = await create(id, father, '가문부', 'MALE'),
      mom = await create(id, mother, '가문모', 'FEMALE');
    const offered = await send(id, father, from, { type: 'marriage.propose', targetGeneralId: mom });
    if (offered.result.data?.status !== 'applied') throw Error('혼인 제안 결과가 없습니다.');
    const offerId = offered.result.data.result.offerId!;
    const publicBoard = await rpc('lineage.get', { worldId: id }, other);
    expect(publicBoard.data?.view.mine).toBeNull();
    expect(JSON.stringify(publicBoard.data)).not.toContain('deathYear');
    expect(JSON.stringify(publicBoard.data)).not.toContain('gold');
    for (const person of publicBoard.data!.view.people)
      for (const key of ['cityKey', 'officerLevel', 'isHuman', 'activeFromYear', 'age', 'portraitId'])
        expect(Object.hasOwn(person, key)).toBe(false);
    const foreign = await rpc('lineage.request', { worldId: id, requestId: offered.input.requestId }, mother);
    expect(foreign.error?.data.code).toBe('NOT_FOUND');
    await send(id, mother, mom, { type: 'marriage.respond', offerId, accept: true });
    await advance(id, 10000);
    const birth = await snapshot(id),
      heir = Object.entries(birth.state.lineage!.persons).find(([, p]) => p.parents.some((id) => id === from))![0];
    for (let month = 2; month <= 12; month++) {
      await send(id, father, from, { type: 'heir.designate', heirGeneralId: null });
      await send(id, mother, mom, { type: 'heir.designate', heirGeneralId: null });
      await advance(id, month * 10000);
    }
    await send(id, father, from, { type: 'heir.designate', heirGeneralId: Number(heir) });
    const assignmentId = randomUUID();
    if (withAssignment) {
      // 발령 저장 회귀 전용 고정물이다. 소속·제안을 직접 구성하며 원본 재생은 다른 갈래에서 검증한다.
      await db.general.updateMany({
        where: { worldId: id, id: { in: [from, Number(heir)] } },
        data: { nationId: 1, officerLevel: 1 },
      });
      const predecessor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: id, id: from } } });
      const destination = await db.city.findFirstOrThrow({
        where: { worldId: id, nationId: 1, cityKey: { not: predecessor.cityKey } },
        orderBy: { cityKey: 'asc' },
      });
      await db.assignmentOffer.create({
        data: {
          id: assignmentId,
          worldId: id,
          nationId: 1,
          issuerGeneralId: 1,
          targetGeneralId: from,
          cityKey: destination.cityKey,
          createdTick: 120000,
          expiresTick: 180000,
          status: 'PENDING',
        },
      });
    }
    const board = await rpc('lineage.get', { worldId: id }, father),
      preview = board.data?.view.mine?.preview;
    if (!preview) throw Error('성인이 된 후계자의 미리보기가 없습니다.');
    if (withAssignment) expect(preview.cancelledOffers).toContainEqual({ kind: 'ASSIGNMENT', id: assignmentId });
    const before = await snapshot(id),
      confirmed = await send(id, father, from, {
        type: 'succession.confirm',
        heirGeneralId: Number(heir),
        expected: preview,
      });
    const after = await snapshot(id);
    expect(after.state.generals[Number(heir)]).toMatchObject({
      userId: father.id,
      gold: preview.gold,
      rice: preview.rice,
    });
    expect(after.revisions[Number(heir)]).toBe(Math.max(before.revisions[from]!, before.revisions[Number(heir)]!) + 1);
    expect(after.residenceAnchors?.[Number(heir)]).toBe(
      confirmed.result.data?.status === 'applied' ? confirmed.result.data.result.tick : undefined,
    );
    expect((await rpc('lineage.submit', confirmed.input, father)).data?.status).toBe('applied');
    const stale = await rpc(
      'lineage.submit',
      { ...confirmed.input, requestId: randomUUID(), payload: { type: 'heir.designate', heirGeneralId: null } },
      father,
    );
    expect(stale.error?.data.code).toBe('CONFLICT');
    expect(
      (
        await rpc(
          'message.send',
          { worldId: id, scope: 'PRIVATE', toGeneralId: from, body: '은퇴한 장수 수신 거절 검사' },
          father,
        )
      ).error?.data.code,
    ).toBe('BAD_REQUEST');
    expect(
      await db.inputEvent.count({ where: { worldId: id, idempotencyKey: `lineage:${confirmed.input.requestId}` } }),
    ).toBe(1);
    if (withAssignment) {
      expect(
        await db.assignmentOffer.findUniqueOrThrow({ where: { worldId_id: { worldId: id, id: assignmentId } } }),
      ).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'TARGET_LEFT',
      });
      return;
    }
    await advance(id, 130000);
    const archive = await exportReplay(db, id),
      replayed = replayArchive(archive, 13);
    expect(replayed).toHaveLength(13);
    expect(replayed.map((month) => month.stateHash)).toEqual(archive.months.map((month) => month.stateHash));
    expect(replayed.at(-1)!.stateHash).toBe(hashState(await snapshot(id)));
  },
  120000,
);
