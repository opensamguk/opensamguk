import { randomUUID } from 'node:crypto';
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
async function world(lineage = true) {
  const initial = commandInitial();
  initial.seed = `lineage-pg-${randomUUID()}`;
  initial.diplomacies = initial.diplomacies.map((row) => ({ ...row, state: 'NON_AGGRESSION', untilTick: 300000 }));
  if (lineage) for (const g of initial.generals) g.sex = g.id === 2 ? 'MALE' : g.id === 3 ? 'FEMALE' : 'UNKNOWN';
  initial.generals[1]!.deathYear = initial.startYear + 1;
  const config = structuredClone(lineageTestConfig);
  config.birth.comingOfAgeYears = 1;
  config.marriage.npc.perMonth = 1;
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
        [108, 'MALE'],
        [167, 'MALE'],
        [169, 'MALE'],
        [229, 'MALE'],
        [281, 'MALE'],
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
    expect(await db.general.count({ where: { worldId: saved.worldId, sex: 'UNKNOWN' } })).toBe(477);
    await exportReplay(db, saved.worldId);
    expect(initial.generals.every((general) => !Object.hasOwn(general, 'sex'))).toBe(true);
  },
  120000,
);

it('AC-P2-32 기존 성별 판은 실제 491명 저장·월간 재생·HTTP 관리자 초기화 뒤에도 유지된다', async () => {
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
          name: '성별 원장 1판 보존',
          turnTermMinutes: 60,
          endYear: null,
          replayFormat: 3,
          ruleFeatures,
          featureData: { 'lineage-v1': lineageTestConfig },
        },
        loadSexLedgers()[0],
      ),
    ),
  );
  const id = saved.worldId;
  worldIds.push(id);
  expect(await db.general.count({ where: { worldId: id } })).toBe(491);
  expect((await snapshot(id)).state.generals[47]?.sex).toBe('UNKNOWN');
  expect(await db.general.count({ where: { worldId: id, sex: 'UNKNOWN' } })).toBe(489);
  const before = await exportReplay(db, id);
  await expect(db.$executeRaw`UPDATE "General" SET sex='MALE' WHERE "worldId"=${id} AND id=47`).rejects.toThrow(
    /General_sex_immutable|23514/,
  );
  expect(await exportReplay(db, id)).toEqual(before);
  await controlClock(db, id, 'start');
  await advance(id, 10000);
  expect((await snapshot(id)).state.generals[47]?.sex).toBe('UNKNOWN');
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
  expect((await snapshot(newId)).state.generals[47]?.sex).toBe('UNKNOWN');
  expect(await db.general.count({ where: { worldId: newId, sex: 'UNKNOWN' } })).toBe(489);
  expect((await snapshot(id)).state.generals[47]?.sex).toBe('UNKNOWN');
}, 120000);
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
  await advance(worldId, 0);
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
      heir = Object.entries(birth.state.lineage!.persons).find(([, p]) => p.parents.includes(from))![0];
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
