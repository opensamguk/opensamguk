import { providedRuleKeys } from '../packages/rules/src/providedRules';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  applyCampaignRelationship,
  applySexLedger,
  buildCreatedGeneral,
  checkReplayOrigin,
  TICKS_PER_MONTH,
  type CampaignOrder,
  type CampaignOrderInput,
  type WorldInit,
} from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorldFromDb, loadSexLedger } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, assertLease, lockLease, releaseLease, renewLease, LEASE_TTL_MS } from '../apps/engine/src/lease';
import { assertWorldCapabilities } from '../apps/engine/src/capsGate';
import { processInputs } from '../apps/engine/src/inputs';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import type { readCampaignOrders } from '../apps/server/src/game/campaignOrders';
import type { readCampaignRequest } from '../apps/server/src/game/campaignApi';
import { testDatabaseUrl } from './test-database';
import { prepareFixtureUnit, recruitmentFixtureData } from './fixtures/recruitment';

// AC-INT-19B: 같은 정식 준비를 공유하고 권한 사례(API 묶음)와 긴 실제 차례 시나리오(엔진 묶음)를 나눠 실행한다.
export function defineInt19OrdersSuite(mode: 'authz' | 'scenario') {
  // AC-INT-19B: real PostgreSQL, loopback HTTP, original integration 191/21 nations/491 officers.
  // Users/sessions/sanctions are authentication fixtures; game state changes only through
  // saveInitialWorld, real API requests and the fenced engine. No SQL game-state injection.
  // This bounded multi-month integration does not represent the 132-month acceptance.
  if (!process.env.TEST_DATABASE_URL) throw new Error('INT19 전용 TEST_DATABASE_URL이 필요합니다.');
  // 통합 실행기는 DATABASE_URL과 TEST_DATABASE_URL을 같은 테스트 DB로 넘긴다. 이름 규칙만 확인한다.
  const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
  if (url.searchParams.has('host') || url.searchParams.has('port'))
    throw new Error('INT19 접속 대상 질의 인자는 쓸 수 없습니다.');
  const db = createDb(url.toString());
  const origin = 'http://127.0.0.1:5173',
    seed = 'int19-formal-orders-http-191',
    now = Date.now();
  const features = [...providedRuleKeys];
  const worldIds: string[] = [],
    userIds: string[] = [],
    sanctionIds: string[] = [];
  const running = new Set<Promise<unknown>>();
  const scope = new AsyncLocalStorage<AbortSignal>(),
    lifetime = new AbortController();
  let failed = false,
    base = '',
    worldId = '',
    otherWorldId = '',
    otherHash = '',
    originHash = '';
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let initial: WorldInit, a: Actor, b: Actor, outsider: Account, blocked: Account;
  let nationId = 0,
    npcId = 0,
    foreignUnitId = 0,
    recruitmentType = 0;
  type Account = { userId: string; cookie: string };
  type Actor = Account & { generalId: number };
  type Board = Awaited<ReturnType<typeof readCampaignOrders>>;
  type Receipt = Awaited<ReturnType<typeof readCampaignRequest>>;
  function signal() {
    const current = scope.getStore();
    if (!current) throw new Error('INT19 검사 취소 문맥이 없습니다.');
    current.throwIfAborted();
    return current;
  }
  function track<T>(action: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(action);
    running.add(promise);
    void promise.then(
      () => running.delete(promise),
      () => {
        failed = true;
        running.delete(promise);
      },
    );
    return promise;
  }
  function it(name: string, action: () => Promise<void>, timeout = 30_000) {
    test(
      name,
      ({ signal: testSignal, onTestFailed }) => {
        onTestFailed(() => {
          failed = true;
          lifetime.abort();
        });
        if (failed) throw new Error('INT19 앞선 실패 이후 새 게임 입력을 시작하지 않습니다.');
        return scope.run(AbortSignal.any([lifetime.signal, testSignal]), () => track(action));
      },
      timeout,
    );
  }
  async function api<T = unknown>(path: string, input: unknown, account: Account | null = a, mutation = false) {
    const current = signal(),
      body = JSON.stringify({ 0: input });
    const response = await fetch(
      `${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(body)}`}`,
      {
        method: mutation ? 'POST' : 'GET',
        headers: {
          origin,
          ...(account ? { cookie: account.cookie } : {}),
          ...(mutation ? { 'content-type': 'application/json' } : {}),
        },
        ...(mutation ? { body } : {}),
        signal: AbortSignal.any([current, AbortSignal.timeout(10_000)]),
      },
    );
    const [entry] = (await response.json()) as Array<{
      result?: { data: T };
      error?: { data: { code: string }; message?: string };
    }>;
    current.throwIfAborted();
    if (!entry) throw new Error('INT19 HTTP 응답이 없습니다.');
    return {
      data: entry.result?.data,
      code: entry.error?.data.code,
      message: entry.error?.message,
      status: response.status,
    };
  }
  async function snapshot(id = worldId, client = db) {
    signal();
    const value = await client.$transaction((tx) => loadReplayState(tx, id), { isolationLevel: 'RepeatableRead' });
    signal();
    return value;
  }
  async function board(actor: Account = a) {
    const result = await api<Board>('campaign.orders', { worldId }, actor);
    expect(result.code, result.message).toBeUndefined();
    if (!result.data) throw new Error('INT19 지시 현황이 없습니다.');
    expect(result.data.userId).toBe(actor.userId);
    return result.data;
  }
  async function reservations() {
    signal();
    const rows = await db.generalTurn.findMany({
      where: { worldId },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    });
    signal();
    return rows;
  }
  async function leased<T>(
    run: (lease: NonNullable<Awaited<ReturnType<typeof acquireLease>>>, current: AbortSignal) => Promise<T>,
  ) {
    const outer = signal(),
      lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('INT19 실행권을 얻지 못했습니다.');
    const controller = new AbortController(),
      current = AbortSignal.any([outer, controller.signal]);
    let renewalError: unknown;
    const renewal = (async () => {
      while (!current.aborted) {
        try {
          await delay(LEASE_TTL_MS / 3, undefined, { signal: current });
        } catch (error) {
          if (!current.aborted) renewalError = error;
          break;
        }
        if (current.aborted) break;
        try {
          await renewLease(db, lease);
        } catch (error) {
          renewalError = error;
          controller.abort(error);
        }
      }
    })();
    const errors: unknown[] = [];
    let result: { value: T } | undefined;
    try {
      current.throwIfAborted();
      result = { value: await run(lease, current) };
      current.throwIfAborted();
    } catch (error) {
      errors.push(error);
    }
    controller.abort();
    try {
      await renewal;
    } catch (error) {
      errors.push(error);
    }
    if (renewalError) errors.push(renewalError);
    try {
      await releaseLease(db, lease);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'INT19 작업·실행권 정리에 실패했습니다.');
    if (!result) throw new Error('INT19 실행 결과가 없습니다.');
    return result.value;
  }
  async function drain(rollback = false) {
    return leased(async (lease, current) => {
      for (let count = 0; count < 64; count++) {
        current.throwIfAborted();
        const applied = await db.$transaction(async (tx) => {
          await lockLease(tx, lease);
          await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
          const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
          await assertWorldCapabilities(tx, world);
          current.throwIfAborted();
          const processed = await processInputs(tx, world, world.clockTick);
          await assertLease(tx, lease);
          current.throwIfAborted();
          if (rollback && processed) throw new Error('INT19_CONTROLLED_INPUT_ROLLBACK');
          return processed;
        });
        current.throwIfAborted();
        if (!applied) return;
      }
      throw new Error('INT19 준비 입력 수 한도를 넘었습니다.');
    });
  }
  async function advance(tick: number) {
    return leased((lease, current) => new TurnLoop(db, lease).advanceTo(tick, current));
  }
  async function receipt(requestId: string, actor: Account = a) {
    const result = await api<Receipt>('campaign.request', { worldId, requestId }, actor);
    expect(result.code).toBeUndefined();
    if (!result.data) throw new Error('INT19 입력 결과가 없습니다.');
    return result.data;
  }
  async function input(
    path: 'campaign.relationship' | 'campaign.unit' | 'campaign.order',
    payload: unknown,
    actor: Actor = a,
    requestId = randomUUID(),
  ) {
    const result = await api<{ status: string }>(
      path,
      { worldId, requestId, payload, ...(path === 'campaign.unit' ? {} : { expectedUserId: actor.userId }) },
      actor,
      true,
    );
    expect(result.code, result.message).toBeUndefined();
    expect(result.data?.status).toBe('pending');
    return requestId;
  }
  async function applyInput(
    path: 'campaign.relationship' | 'campaign.unit' | 'campaign.order',
    payload: unknown,
    actor: Actor = a,
  ) {
    const requestId = await input(path, payload, actor);
    await drain();
    const result = await receipt(requestId, actor);
    expect(result.status).toBe('applied');
    return result;
  }
  async function order(id: number): Promise<CampaignOrder> {
    const found = (await snapshot()).state.campaign!.orders?.items.find((item) => item.id === id);
    if (!found) throw new Error('INT19 저장 지시가 없습니다.');
    return found;
  }
  async function issue(recipientId: number, commandKey = 'farm', args: unknown = {}) {
    const view = await board();
    const accepted = await applyInput('campaign.order', {
      type: 'issue',
      recipientId,
      command: { commandKey, args },
      revision: view.revision,
    });
    if (accepted.status !== 'applied' || accepted.kind !== 'campaign.order') throw new Error('INT19 지시 접수 실패');
    return accepted.result.orderId;
  }
  async function respond(id: number, accept: boolean, actor: Actor = b) {
    const view = await board(actor);
    return applyInput(
      'campaign.order',
      {
        type: 'respond',
        orderId: id,
        accept,
        revision: view.revision,
        expectedTurnRevision: view.next.turnRevision,
        expectedFirstSlot: view.next.firstSlot,
      },
      actor,
    );
  }
  async function setTurns(actor: Actor, commandKey = 'rest', args: unknown = {}) {
    const before = await snapshot(),
      revision = before.revisions[actor.generalId]!;
    const result = await api<{ ok: boolean }>(
      'turns.set',
      {
        worldId,
        revision,
        slots: [{ commandKey, args }, ...Array.from({ length: 29 }, () => ({ commandKey: 'rest', args: {} }))],
      },
      actor,
      true,
    );
    expect(result.code).toBeUndefined();
    expect(result.data?.ok).toBe(true);
  }
  async function executeOrder(id: number, expected: 'EXECUTED' | 'CANCELLED' | 'RESOLVED' = 'EXECUTED') {
    const before = await snapshot(),
      saved = await order(id),
      recipientId = saved.recipientId;
    const due = before.state.generals[recipientId]!.nextTurnTick;
    expect(saved.status).toBe('READY');
    const result = await advance(due);
    expect(result.filter((row) => row.generalId === recipientId && row.tick === due)).toHaveLength(1);
    const after = await snapshot(),
      resolved = await order(id);
    if (expected === 'RESOLVED') expect(['EXECUTED', 'FAILED']).toContain(resolved.status);
    else expect(resolved.status).toBe(expected);
    expect(resolved.resolvedTick).toBe(due);
    expect(after.revisions[recipientId]).toBe(before.revisions[recipientId]! + 1);
    expect(after.turns[recipientId]!.slice(0, 29)).toEqual(before.turns[recipientId]!.slice(1));
    expect(after.turns[recipientId]).toHaveLength(30);
    const logs = await db.generalLog.findMany({
      where: {
        worldId,
        generalId: recipientId,
        tick: due,
        commandKey: expected === 'CANCELLED' ? before.turns[recipientId]![0]!.commandKey : saved.command.commandKey,
      },
      orderBy: { ordinal: 'asc' },
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(new Set(logs.map((row) => row.sequence)).size).toBe(1);
    expect(logs.map((row) => row.ordinal)).toEqual(Array.from({ length: logs.length }, (_, i) => i));
    expect(logs.every((row) => row.kind === (resolved.status === 'FAILED' ? 'failure' : 'success'))).toBe(true);
    expect(logs.every((row) => !/[\r\n]/.test(row.text))).toBe(true);
    const unchanged = hashState(after);
    await advance(due);
    expect(hashState(await snapshot())).toBe(unchanged);
    expect((await order(id)).status).toBe(resolved.status);
    return after;
  }
  async function account(userId: string = randomUUID()): Promise<Account> {
    signal();
    await db.user.create({
      data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'int19-non-login-session-fixture' },
    });
    userIds.push(userId);
    signal();
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
    signal();
    return { userId, cookie: `sid=${session.token}` };
  }
  async function human(index: number): Promise<Actor> {
    const payload = {
      name: `지시검사${index}`,
      sex: 'MALE' as const,
      portraitId: null,
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
    };
    // 원본 NPC의 첫 달 전체를 준비에서 돌리지 않도록 실제 생성 함수로 초반 차례인 계정만 고른다.
    let selected: string | undefined;
    for (let attempt = 0; attempt < 100_000; attempt++) {
      const userId = randomUUID();
      const preview = buildCreatedGeneral({
        payload,
        userId,
        seed,
        id: Math.max(...initial.generals.map((general) => general.id)) + index + 1,
        startYear: initial.startYear,
        tick: 0,
        monthlyTick: 0,
        cityKeys: initial.cities.filter((city) => city.kind === 'CITY').map((city) => city.cityKey),
        unitSet: initial.unitSet,
      });
      if (preview.nextTurnTick > 0 && preview.nextTurnTick <= 10) {
        selected = userId;
        break;
      }
    }
    if (!selected) throw Error('INT19 초반 차례의 사람 고정물을 찾지 못했습니다.');
    const owner = await account(selected);
    const creating = track(() =>
      api<{ status: string }>(
        'general.create',
        {
          worldId,
          ...payload,
        },
        owner,
        true,
      ),
    );
    // beforeAll에서도 부르므로 expect.poll 대신 같은 한도로 직접 기다린다.
    for (let started = performance.now(); ; await delay(50, undefined, { signal: signal() })) {
      const count = await db.inputEvent.count({
        where: { worldId, userId: owner.userId, kind: 'general.create', status: 'PENDING' },
      });
      if (count === 1) break;
      if (performance.now() - started > 10_000) throw new Error('INT19 장수 생성 접수를 확인하지 못했습니다.');
    }
    await drain();
    // 생성 응답은 엔진 처리 대기가 길면 정상적으로 pending이므로 완료는 아래 장수 행으로 확인한다.
    expect(['created', 'pending']).toContain((await creating).data?.status);
    const general = await db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId, userId: owner.userId } },
    });
    expect(general.nextTurnTick).toBeLessThanOrEqual(10);
    expect(await db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
    expect((await snapshot()).state.campaign!.sources[String(general.id)]).toMatch(/^input:\d+#general:/);
    return { ...owner, generalId: general.id };
  }
  async function linkHumans() {
    const offered = await applyInput('campaign.relationship', {
      type: 'offer',
      targetId: b.generalId,
      relation: 'STAFF',
      revision: (await board()).revision,
    });
    if (offered.status !== 'applied' || offered.kind !== 'campaign.relationship' || offered.result.offerId === null)
      throw new Error('INT19 사람 제안 실패');
    await applyInput(
      'campaign.relationship',
      { type: 'respond', offerId: offered.result.offerId, accept: true, revision: (await board(b)).revision },
      b,
    );
    expect((await snapshot()).state.campaign!.links).toContainEqual({
      masterId: a.generalId,
      personId: b.generalId,
      relation: 'STAFF',
    });
  }

  beforeAll(
    () =>
      scope.run(AbortSignal.any([lifetime.signal, AbortSignal.timeout(115_000)]), () =>
        track(async () => {
          let started = performance.now();
          const measured = (phase: string) => {
            console.info(
              'INT19-setup',
              JSON.stringify({ mode, phase, elapsedMs: Math.round(performance.now() - started) }),
            );
            started = performance.now();
          };
          initial = await loadInitialWorldFromDb(db, {
            scenario: 'integration191',
            map: 'integration',
            statRules: 'five-stats',
            portraitMap: '191-map',
            seed,
          });
          measured('load-491');
          // 시험 전용 병종의 모집비만 분리해 원본 NPC의 자동 모병 비용을 보존한다.
          recruitmentType = Math.max(...initial.unitSet.crewTypes.map((type) => type.id)) + 1;
          initial.unitSet.crewTypes.push({
            ...initial.unitSet.crewTypes.find((type) => type.armType > 0)!,
            id: recruitmentType,
            cost: 0,
          });
          originHash = hashState(initial);
          for (let count = 0; count < 2; count++) {
            signal();
            const created = await saveInitialWorld(db, initial, {
              name: 'INT19 정식 HTTP 검사',
              turnTermMinutes: 60,
              endYear: 201,
              featureData: recruitmentFixtureData(initial),
            });
            worldIds.push(created.worldId);
            measured(`save-491-${count + 1}`);
            signal();
          }
          [worldId, otherWorldId] = worldIds as [string, string];
          otherHash = hashState(await snapshot(otherWorldId));
          signal();
          await controlClock(db, worldId, 'start');
          signal();
          app = await buildServer({ db, logging: false, publicOrigin: origin, now: () => now });
          signal();
          base = await app.listen({ host: '127.0.0.1', port: 0 });
          signal();
          a = await human(0);
          b = await human(1);
          measured('create-two-humans');
          outsider = await account();
          blocked = await account();
          signal();
          await db.user.update({ where: { id: blocked.userId }, data: { status: 'SANCTIONED' } });
          signal();
          nationId = [...initial.nations].sort((x, y) => {
            const count = (id: number, capital: number | null) =>
              initial.generals.filter(
                (g) => g.nationId === id && g.cityKey === capital && g.officerLevel !== 12 && g.activeFromYear <= 191,
              ).length;
            return count(y.id, y.capitalCityKey) - count(x.id, x.capitalCityKey) || x.id - y.id;
          })[0]!.id;
          for (const actor of [a, b]) await setTurns(actor, 'join', { nationId });
          const generated = await db.general.findMany({ where: { worldId, userId: { in: [a.userId, b.userId] } } });
          await advance(Math.max(...generated.map((g) => g.nextTurnTick)));
          measured('advance-join-with-491-npcs');
          for (const actor of [a, b]) {
            const general = (await snapshot()).state.generals[actor.generalId]!;
            expect(general.nationId).toBe(nationId);
            await setTurns(actor);
          }
        }),
      ),
    120_000,
  );

  afterAll(async () => {
    lifetime.abort();
    while (running.size) await Promise.allSettled([...running]);
    const errors: unknown[] = [];
    let closed = app === undefined;
    try {
      await app?.close();
      closed = true;
    } catch (error) {
      errors.push(error);
    }
    try {
      await db.sanction.deleteMany({ where: { id: { in: sanctionIds } } });
      expect(await db.sanction.count({ where: { id: { in: sanctionIds } } })).toBe(0);
    } catch (error) {
      errors.push(error);
    }
    if (closed) {
      if (!errors.length)
        try {
          await db.world.deleteMany({ where: { id: { in: worldIds } } });
        } catch (error) {
          errors.push(error);
        }
      if (!errors.length)
        try {
          await db.user.deleteMany({ where: { id: { in: userIds } } });
        } catch (error) {
          errors.push(error);
        }
    }
    console.info('INT19-cleanup', JSON.stringify({ mode, failed, closed, errors: errors.length }));
    try {
      await db.$disconnect();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'INT19 자기 서버·데이터·연결 정리에 실패했습니다.');
  }, 120_000);

  it('AC-INT-19B 정식53도시8관문·21국491명·제공 규칙과 생성출처·두 사람30칸·다른 월드를 보존한다', async () => {
    expect(initial.generals).toHaveLength(491);
    expect(initial.nations).toHaveLength(21);
    expect(initial.cities.filter((city) => city.kind === 'CITY')).toHaveLength(53);
    expect(initial.cities.filter((city) => city.kind === 'PASS')).toHaveLength(8);
    expect(hashState(initial)).toBe(originHash);
    const state = await snapshot();
    expect(providedRuleKeys).toEqual(features);
    expect(Object.keys(state.state.cityResources!.cities)).toHaveLength(initial.cities.length);
    expect(state.state.campaign).not.toHaveProperty('orders');
    expect(state.turns[a.generalId]).toHaveLength(30);
    expect(state.turns[b.generalId]).toHaveLength(30);
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    checkReplayOrigin(world.replayOrigin);
    expect(world.replayOrigin).toMatchObject({
      initial: { generals: applySexLedger(initial, loadSexLedger(initial.scenarioKey)) },
    });
    expect(hashState(await snapshot(otherWorldId))).toBe(otherHash);
    await linkHumans();
  });

  if (mode === 'authz') {
    for (const path of ['campaign.orders', 'campaign.order'] as const) {
      for (const category of categories) {
        it(
          `${path} ${category}`,
          authzCase(path, category, async () => {
            const view = await board(),
              before = hashState(await snapshot()),
              turns = await reservations();
            const events = await db.inputEvent.count({ where: { worldId } });
            const actor =
              category === 'unauthenticated'
                ? null
                : category === 'sanctioned'
                  ? blocked
                  : category === 'otherUser'
                    ? b
                    : a;
            const requestId = randomUUID();
            const input =
              path === 'campaign.orders'
                ? { worldId, ...(category === 'invalidInput' ? { generalId: a.generalId } : {}) }
                : {
                    worldId,
                    requestId,
                    expectedUserId: actor?.userId ?? a.userId,
                    payload: {
                      type: 'issue',
                      recipientId: category === 'otherUser' ? a.generalId : b.generalId,
                      command: { commandKey: 'farm', args: {} },
                      revision: view.revision,
                      ...(category === 'invalidInput' ? { issuerId: a.generalId } : {}),
                    },
                  };
            const result = await api<Board>(path, input, actor, path === 'campaign.order');
            if (category === 'success' || (category === 'otherUser' && path === 'campaign.orders')) {
              expect(result.code).toBeUndefined();
              if (path === 'campaign.order') {
                expect(hashState(await snapshot())).toBe(before);
                expect(await reservations()).toEqual(turns);
                await drain();
                const applied = await receipt(requestId);
                if (applied.status !== 'applied' || applied.kind !== 'campaign.order')
                  throw new Error('INT19 권한 성공 입력 결과가 없습니다.');
                await respond(applied.result.orderId, false);
                return;
              }
              expect(result.data?.userId).toBe(actor!.userId);
              expect(result.data?.actorId).toBe(category === 'otherUser' ? b.generalId : a.generalId);
              for (const order of result.data?.orders ?? [])
                expect(order.issuerId === result.data!.actorId || order.recipientId === result.data!.actorId).toBe(
                  true,
                );
            } else {
              expect(result.code).toBe(
                category === 'unauthenticated' || category === 'sanctioned' ? 'UNAUTHORIZED' : 'BAD_REQUEST',
              );
            }
            expect(hashState(await snapshot())).toBe(before);
            expect(await reservations()).toEqual(turns);
            expect(await db.inputEvent.count({ where: { worldId } })).toBe(events);
          }),
        );
      }
    }
  }

  if (mode === 'scenario') {
    it('접수·중복동시UUID·다른내용409·사람 본인거절은 실제 상태와 전체30칸을 바꾸지 않는다', async () => {
      const view = await board(),
        before = await snapshot(),
        turns = await reservations();
      const requestId = randomUUID(),
        payload: CampaignOrderInput = {
          type: 'issue',
          recipientId: b.generalId,
          command: { commandKey: 'farm', args: {} },
          revision: view.revision,
        };
      const envelope = { worldId, requestId, expectedUserId: a.userId, payload };
      const accepted = await Promise.all([
        api('campaign.order', envelope, a, true),
        api('campaign.order', envelope, a, true),
      ]);
      expect(accepted.every((result) => result.code === undefined)).toBe(true);
      expect(
        await db.inputEvent.count({ where: { worldId, userId: a.userId, idempotencyKey: `campaign:${requestId}` } }),
      ).toBe(1);
      expect(
        (
          await api(
            'campaign.order',
            { ...envelope, payload: { ...payload, command: { commandKey: 'commerce', args: {} } } },
            a,
            true,
          )
        ).code,
      ).toBe('CONFLICT');
      expect(hashState(await snapshot())).toBe(hashState(before));
      expect(await reservations()).toEqual(turns);
      await drain();
      const applied = await receipt(requestId);
      if (applied.status !== 'applied' || applied.kind !== 'campaign.order')
        throw new Error('INT19 사람 지시 생성 실패');
      expect((await order(applied.result.orderId)).status).toBe('PENDING');
      const afterApplication = hashState(await snapshot()),
        appliedEvents = await db.inputEvent.count({ where: { worldId } });
      expect((await api<{ status: string }>('campaign.order', envelope, a, true)).data?.status).toBe('applied');
      expect(hashState(await snapshot())).toBe(afterApplication);
      expect(await db.inputEvent.count({ where: { worldId } })).toBe(appliedEvents);
      const wrong = {
        type: 'respond',
        orderId: applied.result.orderId,
        accept: true,
        revision: (await board()).revision,
        expectedTurnRevision: view.next.turnRevision,
        expectedFirstSlot: view.next.firstSlot,
      };
      expect(
        (
          await api(
            'campaign.order',
            { worldId, requestId: randomUUID(), expectedUserId: a.userId, payload: wrong },
            a,
            true,
          )
        ).code,
      ).toBe('BAD_REQUEST');
      const beforeReject = await snapshot();
      await respond(applied.result.orderId, false);
      expect((await order(applied.result.orderId)).status).toBe('REJECTED');
      expect((await snapshot()).state.generals[b.generalId]!.gold).toBe(beforeReject.state.generals[b.generalId]!.gold);
      expect(await reservations()).toEqual(turns);
      expect((await receipt(requestId)).status).toBe('applied');
      expect((await api('campaign.request', { worldId, requestId }, b)).code).toBe('NOT_FOUND');
    });

    it('사람 본인 수락은 양쪽30칸을 보존하고 실제 다음 차례에만 내정을 한 번 실행한다', async () => {
      const id = await issue(b.generalId),
        turns = await reservations();
      await respond(id, true);
      expect((await order(id)).status).toBe('READY');
      expect(await reservations()).toEqual(turns);
      await executeOrder(id);
    }, 120_000);

    it('정상 NPC서약으로 직속을 만들고 NPC 내정 지시가 실제 차례를 한 번 사용한다', async () => {
      const before = await snapshot(),
        world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      const candidate = Object.values(before.state.generals)
        .filter((g) => g.userId === null && g.officerLevel !== 12)
        .sort((x, y) => x.id - y.id)
        .find((g) => {
          const result = applyCampaignRelationship(
            before.state,
            { type: 'offer', targetId: g.id, relation: 'LIEUTENANT', revision: before.state.campaign!.revision },
            a.generalId,
            before.state.campaign,
            { tick: world.clockTick, userId: a.userId, userActive: true },
          );
          return result.ok && result.result.accepted === true;
        });
      if (!candidate) throw new Error('INT19 정상 자금·동의 조건을 만족하는 NPC 서약 후보가 없습니다.');
      npcId = candidate.id;
      const inputResult = await applyInput('campaign.relationship', {
        type: 'offer',
        targetId: npcId,
        relation: 'LIEUTENANT',
        revision: before.state.campaign!.revision,
      });
      expect(inputResult).toMatchObject({ status: 'applied', result: { accepted: true, cost: 500 } });
      expect((await snapshot()).state.campaign!.links).toContainEqual({
        masterId: a.generalId,
        personId: npcId,
        relation: 'LIEUTENANT',
      });
      await executeOrder(await issue(npcId, 'farm'));
    }, 120_000);

    it('NPC 명시 모병 지시는 NPC자기 소유 부곡만 정상 생성하고 병력을 중복 저장하지 않는다', async () => {
      const before = await snapshot();
      const existing = before.state.campaign!.units.find((unit) => unit.ownerId === npcId);
      if (!existing) {
        await executeOrder(await issue(npcId, 'recruit', { crewType: recruitmentType, amount: 1, unitId: 'new' }));
      }
      const after = await snapshot(),
        owned = after.state.campaign!.units.filter((unit) => unit.ownerId === npcId);
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.every((unit) => unit.commanderId === npcId)).toBe(true);
      expect(Object.values(after.state.generals).every((general) => general.crew === 0)).toBe(true);
      if (!existing) expect(owned).toHaveLength(1);
    }, 120_000);

    it('현재 권한·계정ABA·세션·제재·타월드·위조 입력은 새 입력과 게임 상태를 만들지 않는다', async () => {
      const before = hashState(await snapshot()),
        turns = await reservations(),
        count = await db.inputEvent.count({ where: { worldId } });
      const payload = {
        type: 'issue',
        recipientId: b.generalId,
        command: { commandKey: 'farm', args: {} },
        revision: (await board()).revision,
      };
      const envelope = { worldId, requestId: randomUUID(), expectedUserId: a.userId, payload };
      expect((await api('campaign.order', envelope, null, true)).code).toBe('UNAUTHORIZED');
      expect((await api('campaign.order', envelope, b, true)).code).toBe('CONFLICT');
      expect((await api('campaign.order', { ...envelope, expectedUserId: 'not-a-uuid' }, a, true)).code).toBe(
        'BAD_REQUEST',
      );
      expect(
        (await api('campaign.order', { ...envelope, payload: { ...payload, issuerId: a.generalId } }, a, true)).code,
      ).toBe('BAD_REQUEST');
      expect((await api('campaign.order', { ...envelope, expectedUserId: outsider.userId }, outsider, true)).code).toBe(
        'NOT_FOUND',
      );
      expect((await api('campaign.order', { ...envelope, worldId: otherWorldId }, a, true)).code).toBe('NOT_FOUND');
      expect((await api('campaign.order', { ...envelope, expectedUserId: blocked.userId }, blocked, true)).code).toBe(
        'UNAUTHORIZED',
      );
      expect(hashState(await snapshot())).toBe(before);
      expect(await reservations()).toEqual(turns);
      expect(await db.inputEvent.count({ where: { worldId } })).toBe(count);
    });

    it('대기중 예약변경은 실제 차례의 지시를 취소하고 원래 새 예약 한 칸만 소비한다', async () => {
      const id = await issue(b.generalId);
      await respond(id, true);
      await setTurns(b);
      await executeOrder(id, 'CANCELLED');
    }, 120_000);

    it('정상 관계해제는 수락된 지시의 현재권한을 취소하며 본인NPC군주 요청도 본인수락을 기다린다', async () => {
      const id = await issue(b.generalId);
      await respond(id, true);
      await applyInput(
        'campaign.relationship',
        { type: 'release', personId: b.generalId, revision: (await board(b)).revision },
        b,
      );
      await executeOrder(id, 'CANCELLED');
      const view = await board(b);
      expect(view.npcSuperior).not.toBeNull();
      const result = await applyInput('campaign.order', { type: 'request', revision: view.revision }, b);
      if (result.status !== 'applied' || result.kind !== 'campaign.order') throw new Error('INT19 NPC상관 요청 실패');
      const requested = await order(result.result.orderId);
      expect(requested.issuerId).toBe(view.npcSuperior!.id);
      expect(requested.recipientId).toBe(b.generalId);
      expect(requested.status).toBe('PENDING');
      expect((await snapshot()).state.generals[requested.issuerId]!.userId).toBeNull();
      const turns = await reservations();
      await respond(requested.id, true, b);
      expect(await reservations()).toEqual(turns);
      await executeOrder(requested.id, 'RESOLVED');
      await linkHumans();
    }, 240_000);

    it('대기중 다른지시는409·후반실패는롤백되며 접수뒤바뀐수신예약을 엔진이거부한다', async () => {
      const view = await board();
      const payload = {
        type: 'issue',
        recipientId: b.generalId,
        command: { commandKey: 'farm', args: {} },
        revision: view.revision,
      };
      const request = await input('campaign.order', payload);
      expect(
        (
          await api(
            'campaign.order',
            { worldId, requestId: randomUUID(), expectedUserId: a.userId, payload: { ...payload, recipientId: npcId } },
            a,
            true,
          )
        ).code,
      ).toBe('CONFLICT');
      const before = hashState(await snapshot());
      let rolledBack = false;
      try {
        await drain(true);
      } catch (error) {
        const values = error instanceof AggregateError ? error.errors : [error];
        rolledBack = values.some(
          (value) => value instanceof Error && value.message === 'INT19_CONTROLLED_INPUT_ROLLBACK',
        );
      }
      expect(rolledBack).toBe(true);
      expect(hashState(await snapshot())).toBe(before);
      expect((await receipt(request)).status).toBe('pending');
      await drain();
      const applied = await receipt(request);
      if (applied.status !== 'applied' || applied.kind !== 'campaign.order')
        throw new Error('INT19 직렬화 성공 결과가 없습니다.');
      expect(
        await db.inputEvent.count({
          where: { worldId, userId: a.userId, idempotencyKey: `campaign:${request}`, status: 'APPLIED' },
        }),
      ).toBe(1);
      const recipient = await board(b);
      const accepting = await input(
        'campaign.order',
        {
          type: 'respond',
          orderId: applied.result.orderId,
          accept: true,
          revision: recipient.revision,
          expectedTurnRevision: recipient.next.turnRevision,
          expectedFirstSlot: recipient.next.firstSlot,
        },
        b,
      );
      await setTurns(b);
      await drain();
      expect(await receipt(accepting, b)).toMatchObject({ status: 'rejected', result: { code: 'STALE' } });
      expect((await order(applied.result.orderId)).status).toBe('PENDING');
      await respond(applied.result.orderId, false);
    }, 240_000);

    it('실제 접수 뒤 생긴 계정제재는 엔진에서 재검사하고 지시 상태를 쓰지 않는다', async () => {
      const payload = {
        type: 'issue',
        recipientId: b.generalId,
        command: { commandKey: 'farm', args: {} },
        revision: (await board()).revision,
      };
      const request = await input('campaign.order', payload),
        before = await snapshot();
      const sanction = await db.sanction.create({
        data: { userId: a.userId, worldId, reason: 'INT19 security fixture', createdBy: a.userId },
      });
      sanctionIds.push(sanction.id);
      try {
        signal();
        await drain();
        const stored = await db.inputEvent.findUniqueOrThrow({
          where: {
            worldId_userId_idempotencyKey: { worldId, userId: a.userId, idempotencyKey: `campaign:${request}` },
          },
        });
        expect(stored.status).toBe('REJECTED');
        expect(stored.result).toMatchObject({ code: 'ACTOR_SANCTIONED' });
        expect((await snapshot()).state.campaign).toEqual(before.state.campaign);
      } finally {
        await db.sanction.deleteMany({ where: { id: sanction.id } });
      }
      signal();
    });

    it('NPC이동·귀환 지시는 상관과 타인 소유 부곡을 옮기지 않으며 타인unit명령을 거부한다', async () => {
      const state = await snapshot(),
        npc = state.state.generals[npcId]!;
      const destination = state.state.cities[npc.cityKey]!.connections.find(
        (key) => state.state.cities[key]!.nationId === null || state.state.cities[key]!.nationId === npc.nationId,
      );
      if (!destination) throw new Error('INT19 현재 도로상 합법 NPC이동 거점이 없습니다.');
      const commanderLocation = state.state.generals[a.generalId]!.cityKey;
      await executeOrder(await issue(npcId, 'move', { cityKey: destination }));
      expect((await snapshot()).state.generals[npcId]!.cityKey).toBe(destination);
      expect((await snapshot()).state.generals[a.generalId]!.cityKey).toBe(commanderLocation);
      await executeOrder(await issue(npcId, 'return'));
      const returned = await snapshot();
      expect(returned.state.generals[npcId]!.cityKey).toBe(returned.state.nations[nationId]!.capitalCityKey);
      foreignUnitId = await prepareFixtureUnit(db, worldId, a.generalId, recruitmentType);
      const before = hashState(await snapshot()),
        count = await db.inputEvent.count({ where: { worldId } });
      expect(
        (
          await api(
            'campaign.order',
            {
              worldId,
              requestId: randomUUID(),
              expectedUserId: a.userId,
              payload: {
                type: 'issue',
                recipientId: npcId,
                command: { commandKey: 'train', args: { unitId: foreignUnitId } },
                revision: (await board()).revision,
              },
            },
            a,
            true,
          )
        ).code,
      ).toBe('BAD_REQUEST');
      expect(hashState(await snapshot())).toBe(before);
      expect(await db.inputEvent.count({ where: { worldId } })).toBe(count);
    }, 240_000);

    // 정식 491명·8개월 수출과 두 번 재생을 포함한 실측 350초. 차례 실행 사례의 한도는 유지한다.
    it('새 DB클라이언트 재접속과 실제 월 경계 archive 두 번 재생이 원생성·두월드·상태해시와 일치한다', async () => {
      const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      await advance(Math.ceil((world.clockTick + 1) / TICKS_PER_MONTH) * TICKS_PER_MONTH);
      const reopened = createDb(url.toString()),
        errors: unknown[] = [];
      try {
        expect(hashState(await snapshot(worldId, reopened))).toBe(hashState(await snapshot()));
      } catch (error) {
        errors.push(error);
      }
      try {
        await reopened.$disconnect();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'INT19 재접속 검증·연결 종료 실패');
      const archive = await exportReplay(db, worldId),
        months = (await snapshot()).monthlyTick / TICKS_PER_MONTH;
      expect(months).toBeGreaterThan(0);
      const first = replayArchive(archive, months);
      expect(replayArchive(archive, months)).toEqual(first);
      expect(first).toHaveLength(months);
      expect(first.at(-1)!.stateHash).toBe(hashState(await snapshot()));
      expect(hashState(await snapshot(otherWorldId))).toBe(otherHash);
      expect(hashState(initial)).toBe(originHash);
    }, 600_000);
  }
}
