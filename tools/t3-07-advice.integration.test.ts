import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { appRouter, type AppRouter } from '../apps/server/src/router';
import type { inferRouterOutputs } from '@trpc/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { readView } from '../apps/server/src/game/queries';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { adviseGeneral, unitSetSchema, STANDARD_EQUIPMENT_CONFIG } from '../packages/rules/src/index';
import { worldResolver } from '../apps/server/src/game/resolver';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadInitialWorldFromDb, loadFeatureProfile } from '../apps/engine/src/world/resources';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url),
  now = Date.now(),
  worlds: string[] = [],
  users: string[] = [];
const app = await buildServer({ db, now: () => now, logging: false });
let address: string,
  failed = false;
type Outputs = inferRouterOutputs<AppRouter>;
type Actor = { id: string; cookie: string; sessionId: string };
async function identity(): Promise<Actor> {
  const row = await db.user.create({
    data: { email: randomUUID() + '@example.test', passwordHash: 'fixture-only', emailVerifiedAt: new Date(now) },
  });
  users.push(row.id);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: row.id, expiresAt: session.expiresAt } });
  return { id: row.id, cookie: 'sid=' + session.token, sessionId: session.id };
}
async function call<T = unknown>(path: string, input: unknown, actor?: Actor) {
  const mutation = appRouter._def.procedures[path]?._def.type === 'mutation';
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    address + '/trpc/' + path + '?batch=1' + (mutation ? '' : '&input=' + encodeURIComponent(encoded)),
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(actor ? { cookie: actor.cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const body = (await response.json())[0] as { result?: { data: T }; error?: { data: { code: string } } };
  return { status: response.status, data: body.result?.data, code: body.error?.data.code };
}
function advice(worldId: string, actor: Actor) {
  return call<Outputs['advice']['get']>('advice.get', { worldId }, actor);
}
function setNotice(worldId: string, actor: Actor, body: string, directive?: unknown) {
  return call<Outputs['notice']['nation']['set']>(
    'notice.nation.set',
    { worldId, body, ...(directive === undefined ? {} : { directive }) },
    actor,
  );
}
async function fixture() {
  const ruler = await identity(),
    enemy = await identity(),
    free = await identity();
  const initial = commandInitial();
  initial.generals[0]!.userId = ruler.id;
  initial.generals[1]!.userId = enemy.id;
  initial.generals[3]!.userId = free.id;
  initial.ruleFeatures = ['policy'];
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '군사 조언 검증',
    turnTermMinutes: 60,
    endYear: 231,
    replayFormat: 3,
  });
  worlds.push(worldId);
  return { worldId, ruler, enemy, free };
}
async function advance(worldId: string) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('자기 조언 시험 월드의 실행권을 얻지 못했습니다.');
  try {
    await new TurnLoop(db, lease, { beforeCommit: (tx) => renewLease(tx, lease) }).advanceTo(0);
  } finally {
    await releaseLease(db, lease);
  }
}
async function possess(worldId: string, actor: Actor, generalId: number) {
  await db.user.update({ where: { id: actor.id }, data: { role: 'ADMIN' } });
  expect(
    (
      await call(
        'admin.world.requestSetting',
        {
          worldId,
          expectedUserId: actor.id,
          idempotencyKey: randomUUID(),
          reason: '조언 검증 인물 맡기 허용',
          setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: 'on' },
        },
        actor,
      )
    ).status,
  ).toBe(200);
  await advance(worldId);
  const waiting = call(
    'entry.possess',
    { worldId, expectedUserId: actor.id, generalId, idempotencyKey: randomUUID() },
    actor,
  );
  await expect
    .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.possess', status: 'PENDING' } }))
    .toBe(1);
  await advance(worldId);
  expect(await waiting).toMatchObject({ status: 200, data: { status: 'possessed', generalId } });
}
async function snapshot(worldId: string) {
  return db.$transaction(
    async (tx) => ({
      world: await tx.world.findUniqueOrThrow({ where: { id: worldId } }),
      generals: await tx.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      nations: await tx.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      cities: await tx.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } }),
      slots: await tx.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
      events: await tx.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      logs: await tx.generalLog.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      operations: await tx.operation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      members: await tx.operationMember.findMany({
        where: { worldId },
        orderBy: [{ operationId: 'asc' }, { generalId: 'asc' }],
      }),
    }),
    { isolationLevel: 'RepeatableRead' },
  );
}
beforeAll(async () => {
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(({ task }) => {
  if (task.result?.state === 'fail') failed = true;
});
afterAll(async () => {
  await app.close();
  try {
    if (!failed) {
      await db.sanction.deleteMany({ where: { userId: { in: users } } });
      await db.world.deleteMany({ where: { id: { in: worlds } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await db.$disconnect();
  }
});

describe('T3-07 AC-M3-13 실제 HTTP 군사 조언', () => {
  it(
    '세션이 없으면 거부한다',
    authzCase('advice.get', 'unauthenticated', async () => {
      const f = await fixture();
      expect(await call('advice.get', { worldId: f.worldId })).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    }),
  );
  it(
    '현재 월드 제재를 같은 읽기 트랜잭션에서 검사한다',
    authzCase('advice.get', 'sanctioned', async () => {
      const f = await fixture();
      await db.sanction.create({
        data: { userId: f.ruler.id, worldId: f.worldId, reason: '조언 접근 검증', createdBy: f.ruler.id },
      });
      expect(await advice(f.worldId, f.ruler)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }),
  );
  it(
    '타인 장수 ID를 입력할 수 없고 내 장수 없는 월드는 404다',
    authzCase('advice.get', 'otherUser', async () => {
      const f = await fixture(),
        outsider = await identity();
      expect(await advice(f.worldId, outsider)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(await call('advice.get', { worldId: f.worldId, generalId: 2 }, f.ruler)).toMatchObject({ status: 400 });
    }),
  );
  it(
    '잘못된 월드 입력은 거부한다',
    authzCase('advice.get', 'invalidInput', async () => {
      const actor = await identity();
      expect(await call('advice.get', { worldId: 'invalid' }, actor)).toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
    }),
  );
  it(
    '내 공지를 먼저 추천하고 다른 국가 지시는 숨기며 조회는 게임·활동·예턴을 쓰지 않는다',
    authzCase('advice.get', 'success', async () => {
      const f = await fixture();
      expect(
        (await setNotice(f.worldId, f.ruler, '우리 국가의 지시\n둘째 줄', { commandKey: 'rest', args: {} })).status,
      ).toBe(200);
      expect((await setNotice(f.worldId, f.enemy, '타국 비공개 지시', { commandKey: 'heal', args: {} })).status).toBe(
        200,
      );
      const before = await snapshot(f.worldId);
      const result = await advice(f.worldId, f.ruler);
      expect(result.status).toBe(200);
      expect(result.data!.basis).toEqual({ tick: 0, revision: 0 });
      expect(result.data!.items[0]).toMatchObject({ source: 'notice', commandKey: 'rest', reason: '우리 국가의 지시' });
      expect(JSON.stringify(result)).not.toContain('타국 비공개');
      expect(await advice(f.worldId, f.ruler)).toEqual(result);
      expect(await snapshot(f.worldId)).toEqual(before);
    }),
  );

  it('만료·회수된 세션과 비활성 계정은 거부하고 재야는 임관 후보만 받는다', async () => {
    const f = await fixture();
    const free = await advice(f.worldId, f.free);
    expect(free.data!.items).toHaveLength(2);
    expect(free.data!.items.every((item) => item.commandKey === 'join' && item.nation !== null)).toBe(true);
    await db.session.update({ where: { id: f.ruler.sessionId }, data: { expiresAt: new Date(now - 1) } });
    expect((await advice(f.worldId, f.ruler)).status).toBe(401);
    await db.session.delete({ where: { id: f.enemy.sessionId } });
    expect((await advice(f.worldId, f.enemy)).status).toBe(401);
    await db.user.update({ where: { id: f.free.id }, data: { status: 'SANCTIONED' } });
    expect((await advice(f.worldId, f.free)).status).toBe(401);
  });

  it('다음 명령 시각으로 자격을 검사하고 사망·제거·미등장 장수의 추천은 비운다', async () => {
    const f = await fixture(),
      where = { worldId_id: { worldId: f.worldId, id: 1 } };
    await db.general.update({ where, data: { activeFromYear: 192 } });
    expect((await advice(f.worldId, f.ruler)).data!.items).toEqual([]);
    await db.general.update({ where, data: { nextTurnTick: 120000 } });
    expect((await advice(f.worldId, f.ruler)).data!.items.length).toBeGreaterThan(0);
    await db.general.update({ where, data: { activeFromYear: 2147483647 } });
    expect((await advice(f.worldId, f.ruler)).data!.items).toEqual([]);
    await db.general.update({ where, data: { activeFromYear: 175, removedAt: 1 } });
    expect((await advice(f.worldId, f.ruler)).data!.items).toEqual([]);
  });

  it('지시 저장은 선택·생략·삭제를 구분하고 빈 본문 지시도 읽음 revision을 따른다', async () => {
    const f = await fixture(),
      directive = { commandKey: 'rest', args: {} };
    const initial = await call<Outputs['notice']['nation']['get']>(
      'notice.nation.get',
      { worldId: f.worldId },
      f.ruler,
    );
    expect(initial.data).not.toHaveProperty('directive');
    expect(initial.data!.unseen).toBe(false);
    const saved = await setNotice(f.worldId, f.ruler, '', directive);
    expect(saved.data).toMatchObject({ body: '', directive, revision: 1, unseen: true });
    const seen = await call<Outputs['notice']['nation']['markSeen']>(
      'notice.nation.markSeen',
      { worldId: f.worldId, nationId: 1, revision: 1 },
      f.ruler,
    );
    expect(seen.data!.unseen).toBe(false);
    const kept = await setNotice(f.worldId, f.ruler, '본문만 수정');
    expect(kept.data).toMatchObject({ directive, revision: 2, unseen: true });
    const cleared = await setNotice(f.worldId, f.ruler, '', null);
    expect(cleared.data).not.toHaveProperty('directive');
    expect(cleared.data).toMatchObject({ revision: 3, unseen: false });
    const row = await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } });
    expect(row.noticeDirective).toBeNull();
  });

  it('국가·꺼진 명령·손상 인자는 본문과 revision을 바꾸지 않고 거절한다', async () => {
    const f = await fixture();
    const before = await snapshot(f.worldId);
    for (const directive of [
      { commandKey: 'nation_rest', args: {} },
      { commandKey: 'missing', args: {} },
      { commandKey: 'rest', args: { bad: true } },
    ])
      expect((await setNotice(f.worldId, f.ruler, '저장되면 안 되는 본문', directive)).status).toBe(400);
    expect(await snapshot(f.worldId)).toEqual(before);
    expect((await setNotice(f.worldId, f.free, '재야는 저장 불가', { commandKey: 'rest', args: {} })).status).toBe(403);
    await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { officerLevel: 1 } });
    expect(
      (await setNotice(f.worldId, f.ruler, '일반 장수는 저장 불가', { commandKey: 'rest', args: {} })).status,
    ).toBe(403);
  });

  it('실행 불가 지시도 저장하지만 추천에서 사전 검사 실패를 설명한다', async () => {
    const f = await fixture();
    expect(
      (await setNotice(f.worldId, f.ruler, '먼 도시로 이동', { commandKey: 'move', args: { cityKey: 999 } })).status,
    ).toBe(200);
    const result = await advice(f.worldId, f.ruler);
    expect(result.data!.skipped).toEqual([
      expect.objectContaining({ source: 'notice', commandKey: 'move', code: expect.any(String) }),
    ]);
    expect(result.data!.items.every((item) => item.source === 'ai')).toBe(true);
  });

  it('지시 저장 SQL이 실패하면 본문·revision도 함께 롤백하고 손상 자료는 숨기지 않는다', async () => {
    const f = await fixture(),
      name = 'advice_fail_' + randomUUID().replaceAll('-', '');
    const before = await snapshot(f.worldId);
    // 고정 접두어와 UUID만 SQL 식별자에 쓰며 이 시험의 월드에만 실패를 주입한다.
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."worldId" = '${f.worldId}' THEN RAISE EXCEPTION 'directive-write-fixture'; END IF;
      RETURN NEW; END $$`);
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER ${name} BEFORE UPDATE OF "noticeDirective" ON "Nation" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      try {
        expect((await setNotice(f.worldId, f.ruler, '롤백 대상', { commandKey: 'rest', args: {} })).status).toBe(500);
        expect(await snapshot(f.worldId)).toEqual(before);
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "Nation"`);
      }
    } finally {
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
    await db.$executeRaw`UPDATE "Nation" SET "noticeDirective" = '{"broken":true}'::jsonb WHERE "worldId" = ${f.worldId} AND id = 1`;
    expect((await advice(f.worldId, f.ruler)).status).toBe(500);
    expect((await call('notice.nation.get', { worldId: f.worldId }, f.ruler)).status).toBe(500);
    expect(
      (await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).noticeDirective,
    ).toEqual({ broken: true });
  });

  it('지시는 세 적재 경로와 게임 해시에 섞이지 않는다', async () => {
    const f = await fixture();
    const before = await readWorldState(db, f.worldId);
    const beforeEngine = await db.$transaction((tx) => loadWorld(tx, f.worldId));
    expect((await setNotice(f.worldId, f.ruler, '공지', { commandKey: 'rest', args: {} })).status).toBe(200);
    expect((await setNotice(f.worldId, f.enemy, '타국', { commandKey: 'heal', args: {} })).status).toBe(200);
    const loaded = [
      await readWorldState(db, f.worldId),
      ...(await db.$transaction(async (tx) => [await loadWorld(tx, f.worldId), await readView(tx, f.worldId)])),
    ];
    for (const state of loaded)
      for (const nation of Object.values(state.nations)) expect(nation).not.toHaveProperty('noticeDirective');
    expect(hashState(loaded[0])).toBe(hashState(before));
    expect(hashState(loaded[1])).toBe(hashState(beforeEngine));
  });

  it('열린 참여 작전의 첫 제안을 우선하고 준비됨·종료·타국·미참여 작전은 제외한다', async () => {
    const f = await fixture();
    await db.general.update({
      where: { worldId_id: { worldId: f.worldId, id: 1 } },
      data: { crew: 0, train: 0, atmos: 0 },
    });
    const make = async (nationId: number, member: number[], status: 'OPEN' | 'CLOSED' = 'OPEN', minCrew = 100) => {
      const operation = await db.operation.create({
        data: {
          worldId: f.worldId,
          nationId,
          targetCityKey: 2,
          targetTick: 200000n,
          createdById: nationId,
          minCrew,
          minTrain: 50,
          minAtmos: 50,
          status,
        },
      });
      if (member.length)
        await db.operationMember.createMany({
          data: member.map((generalId) => ({ worldId: f.worldId, operationId: operation.id, generalId })),
        });
      return operation;
    };
    const joined = await make(1, [1]);
    await make(1, [], 'OPEN');
    await make(1, [1], 'CLOSED');
    await make(2, [2]);
    const suggestion = await call<Outputs['operation']['suggest']>(
      'operation.suggest',
      { worldId: f.worldId, id: joined.id },
      f.ruler,
    );
    expect(suggestion.status).toBe(200);
    expect(suggestion.data!.noop).toBeNull();
    const result = await advice(f.worldId, f.ruler);
    expect(result.data!.items.filter((item) => item.source === 'operation')).toEqual([
      expect.objectContaining({
        commandKey: suggestion.data!.slots[0]!.commandKey,
        args: suggestion.data!.slots[0]!.args,
        reason: '192년 9월 도시2 작전을 준비한다.',
      }),
    ]);
    await db.operation.update({ where: { id: joined.id }, data: { status: 'CLOSED' } });
    expect((await advice(f.worldId, f.ruler)).data!.items.every((item) => item.source !== 'operation')).toBe(true);
  });

  it('목표 전 슬롯이 없거나 30칸 밖인 noop은 기존 예턴을 작전 추천으로 바꾸지 않는다', async () => {
    for (const [nextTurnTick, targetTick, code] of [
      [10000, 10000, 'NO_SLOT'],
      [100, 400000, 'BEYOND_WINDOW'],
    ] as const) {
      const f = await fixture();
      await db.general.update({ where: { worldId_id: { worldId: f.worldId, id: 1 } }, data: { nextTurnTick } });
      const operation = await db.operation.create({
        data: {
          worldId: f.worldId,
          nationId: 1,
          createdById: 1,
          targetCityKey: 2,
          targetTick: BigInt(targetTick),
          minCrew: 100,
          minTrain: 50,
          minAtmos: 50,
        },
      });
      await db.operationMember.create({ data: { worldId: f.worldId, operationId: operation.id, generalId: 1 } });
      const suggestion = await call<Outputs['operation']['suggest']>(
        'operation.suggest',
        { worldId: f.worldId, id: operation.id },
        f.ruler,
      );
      expect(suggestion.data!.noop?.code).toBe(code);
      expect((await advice(f.worldId, f.ruler)).data!.items.every((item) => item.source !== 'operation')).toBe(true);
    }
  });

  it('현재 예턴이 준비됨이면 작전 추천을 추가하지 않는다', async () => {
    const f = await fixture();
    const operation = await db.operation.create({
      data: {
        worldId: f.worldId,
        nationId: 1,
        createdById: 1,
        targetCityKey: 2,
        targetTick: 10000n,
        minCrew: 100,
        minTrain: 50,
        minAtmos: 50,
      },
    });
    await db.operationMember.create({ data: { worldId: f.worldId, operationId: operation.id, generalId: 1 } });
    expect(
      (
        await db.generalTurn.updateMany({
          where: { worldId: f.worldId, generalId: 1, slot: 0 },
          data: { commandKey: 'attack', args: { cityKey: 2 }, explicit: true },
        })
      ).count,
    ).toBe(1);
    const forecast = await call<Outputs['operation']['get']>(
      'operation.get',
      { worldId: f.worldId, id: operation.id },
      f.ruler,
    );
    expect(forecast.data!.timeline[0]!.verdict).toBe('READY');
    expect((await advice(f.worldId, f.ruler)).data!.items.every((item) => item.source !== 'operation')).toBe(true);
  });

  it('정식491명·확장14기능과 600명 추천에서 원본과 RNG 상태를 보존한다', async () => {
    const { value: profile } = await loadFeatureProfile('expanded-191-v1');
    const initial = await loadInitialWorldFromDb(db, {
      seed: 'advice-expanded',
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
    });
    const features = [...profile.ruleFeatures, 'equipment-v1'].sort();
    initial.ruleFeatures = features;
    expect(initial.generals).toHaveLength(491);
    const actor = await identity();
    const general = initial.generals.find(
      (row) => row.nationId !== null && row.officerLevel !== 12 && row.activeFromYear <= initial.startYear,
    )!;
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '확장 조언',
      turnTermMinutes: 60,
      endYear: 231,
      replayFormat: 3,
      ruleFeatures: features,
      featureData: { ...profile.featureData, 'equipment-v1': STANDARD_EQUIPMENT_CONFIG },
    });
    worlds.push(worldId);
    await possess(worldId, actor, general.id);
    const before = await snapshot(worldId),
      started = performance.now();
    const result = await advice(worldId, actor),
      httpMs = performance.now() - started;
    expect(result.status).toBe(200);
    expect(result.data!.items.length).toBeGreaterThan(0);
    expect(await snapshot(worldId)).toEqual(before);
    for (let id = 10000; initial.generals.length < 600; id++)
      initial.generals.push({ ...general, id, userId: null, officerLevel: 1, name: '검증 장수' + id });
    const second = await saveInitialWorld(db, initial, {
      name: '600명 조언',
      turnTermMinutes: 60,
      endYear: 231,
      replayFormat: 3,
      ruleFeatures: features,
      featureData: { ...profile.featureData, 'equipment-v1': STANDARD_EQUIPMENT_CONFIG },
    });
    worlds.push(second.worldId);
    await possess(second.worldId, actor, general.id);
    const http600At = performance.now(),
      http600 = await advice(second.worldId, actor),
      http600Ms = performance.now() - http600At;
    expect(http600.status).toBe(200);
    expect(http600.data!.items.length).toBeGreaterThan(0);
    const world = await db.world.findUniqueOrThrow({ where: { id: second.worldId } }),
      { resolver } = worldResolver(world);
    const view = await db.$transaction((tx) => readView(tx, second.worldId));
    const template = view.generals[general.id]!;
    expect(Object.keys(view.generals)).toHaveLength(600);
    const pureBefore = structuredClone(view),
      pureAt = performance.now();
    const pure = adviseGeneral(view, general.id, {
      tick: template.nextTurnTick,
      unitSet: unitSetSchema.parse(world.unitSet),
      resolver,
    });
    const pureMs = performance.now() - pureAt;
    expect(pure.items.length).toBeGreaterThan(0);
    expect(pure.items.length).toBeLessThanOrEqual(3);
    expect(view).toEqual(pureBefore);
    const benchmark = {
      event: 'advice-benchmark',
      generals: 600,
      pureMs,
      http600Ms,
      httpGenerals: 491,
      httpMs,
      targetMs: 100,
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync(`test-results/t3-07-advice-benchmark-${worldId}.json`, JSON.stringify(benchmark));
    console.info(JSON.stringify(benchmark));
    for (const item of pure.items) expect(item.commandName.length).toBeGreaterThan(0);
  });
});
