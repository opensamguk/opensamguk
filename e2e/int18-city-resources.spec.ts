import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../apps/server/src/router';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { assertLease, lockLease, releaseLease } from '../apps/engine/src/lease';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildCreatedGeneral, TICKS_PER_MONTH, type WorldInit } from '../packages/rules/src/index';
import { applyCityPreparation, type CityPreparationKey } from '../packages/rules/src/cityResources/preparation';
import { recruitCost } from '../packages/rules/src/commands/statScores';
import { BALANCE } from '../packages/rules/src/balance';
import { test as legalTest, expect, type LegalStack } from './legalFixture';
import { e2eDatabaseUrl, TEST_PASSWORD } from './account';
import { holdLease, type LeaseHold } from './game';
import { trpcCalls } from './t210-fixture';

// AC-INT-18C: 실제 공개 dist·PG·API·Chromium의 도시 모집/준비/배속 경계다.
// 역사 인물과 원생성은 그대로 둔다. 실제 사람 생성·임관 뒤 자기 사람 직책 한 개를
// 통제하는 시점을 따로 기록한다. 전투·점령·정식 한 기수 종료 인수는 이 파일의 주장이 아니다.
type Outputs = inferRouterOutputs<AppRouter>;
type Allocation = inferRouterInputs<AppRouter>['cityResources']['allocate'];
type Board = Extract<Outputs['cityResources']['get'], { visible: true }>;
type Receipt = Outputs['cityResources']['request'];
type OwnedWorld = {
  id: string;
  initial: WorldInit;
  hold?: LeaseHold;
  loop?: TurnLoop;
  deleted: boolean;
};
type Actor = {
  userId: string;
  generalId: number;
  context: BrowserContext;
  page: Page;
  unitId: number;
};
type ApiResult<T> = {
  http: number;
  code: string | undefined;
  data: T | undefined;
};
type Call = { path: string; input: unknown };
const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
  'stratagem-basic',
  'treaty',
];

// page.evaluate fetch는 실제 브라우저의 cookie/Origin을 쓴다. 응답을 대체하지 않는다.
async function api<T>(page: Page, path: string, input: unknown, mutation = false): Promise<ApiResult<T>> {
  const result = await page.evaluate(
    async ({ path, input, mutation }) => {
      const response = await fetch(
        `/trpc/${path}${mutation || input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
        {
          method: mutation ? 'POST' : 'GET',
          credentials: 'same-origin',
          ...(mutation
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input),
              }
            : {}),
        },
      );
      const body = (await response.json()) as {
        result?: { data?: unknown };
        error?: { data?: { code?: string } };
      };
      return {
        http: response.status,
        code: body.error?.data?.code,
        data: body.result?.data,
      };
    },
    { path, input, mutation },
  );
  return result as ApiResult<T>;
}
async function read<T>(page: Page, path: string, input: unknown): Promise<T> {
  const result = await api<T>(page, path, input);
  expect(result.http, path).toBe(200);
  expect(result.code, path).toBeUndefined();
  if (result.data === undefined) throw new Error(`${path} 실제 응답이 없습니다.`);
  return result.data;
}
function watch(page: Page) {
  const calls: Call[] = [];
  page.on('request', (request) => {
    for (const call of trpcCalls(request))
      if (['cityResources.get', 'cityResources.allocate', 'cityResources.request', 'turns.set'].includes(call.path))
        calls.push(call);
  });
  return calls;
}
function resourcePanel(page: Page) {
  return page.getByRole('region', { name: '도시 금·쌀·수비병', exact: true });
}
async function photo(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function touchTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

type Journey = {
  origin(info: TestInfo): Promise<void>;
  commands(info: TestInfo): Promise<void>;
  boundaries(info: TestInfo): Promise<void>;
};
type CityRun = {
  worlds: OwnedWorld[];
  contexts: BrowserContext[];
  users: Array<{ id: string; worldId: string }>;
  active: Set<Promise<unknown>>;
  bodies: Promise<void>[];
  evidence: Record<string, unknown>;
  controller: AbortController;
  body: Promise<void> | undefined;
  failed: boolean;
  errors: unknown[];
  journey: Journey | undefined;
  phase: number;
  completedStepIds: string[];
  passedPhaseIds: number[];
  caseReceipts: Array<{ phase: number; status: string; elapsedMs: number }>;
  run(work: () => Promise<void>): Promise<void>;
  reject(error: unknown): void;
  closeContexts(): Promise<void>;
};
const CASE_BUDGET_MS = 600_000;
const LIFECYCLE_BUDGET_MS = 180_000;
// Three separate AC cases have a NEW aggregate scheduling budget; old single-case performance did not pass.
const SUITE_BUDGET_MS = 3 * CASE_BUDGET_MS + 2 * LIFECYCLE_BUDGET_MS;

// The worker owns the fresh worlds, contexts and leases across exactly three dependent cases.
// A test-local watchdog never aborts a successful boundary; any failed case preserves all owned rows.
const test = legalTest.extend<{ cityCase: CityRun }, { cityJourney: CityRun }>({
  cityJourney: [
    async ({ legalStack, browser }, use) => {
      const controller = new AbortController();
      const closingContexts = new Map<BrowserContext, Promise<void>>();
      const scope: CityRun = {
        worlds: [],
        contexts: [],
        users: [],
        active: new Set(),
        bodies: [],
        evidence: {
          publicBuild: true,
          actualPostgres: true,
          actualBrowserHttp: true,
          syntheticWorld: false,
          controlledChanges: [],
          fullSeasonAcceptance: false,
          combatCaptureAcceptance: false,
          caseBudgetMs: CASE_BUDGET_MS,
          preemptiveAbortMs: CASE_BUDGET_MS - 30_000,
          teardownBudgetMs: LIFECYCLE_BUDGET_MS,
          suiteBudgetMs: SUITE_BUDGET_MS,
          newAggregateSchedulingBudget: true,
          oldSingleCasePerformancePassed: false,
        },
        controller,
        body: undefined,
        failed: false,
        errors: [],
        journey: undefined,
        phase: 0,
        completedStepIds: [],
        passedPhaseIds: [],
        caseReceipts: [],
        reject(error) {
          scope.failed = true;
          legalStack.failed = true;
          if (!scope.errors.includes(error)) scope.errors.push(error);
          if (!controller.signal.aborted) controller.abort(error);
        },
        run(work) {
          if (scope.body) throw new Error('아직 정착하지 않은 도시 검사가 있습니다.');
          controller.signal.throwIfAborted();
          const body = Promise.resolve().then(work);
          scope.body = body;
          scope.bodies.push(body);
          void body.catch((error: unknown) => scope.reject(error));
          return body;
        },
        async closeContexts() {
          for (const context of scope.contexts) {
            let closing = closingContexts.get(context);
            if (!closing) {
              closing = context.close().catch((error: unknown) => scope.reject(error));
              closingContexts.set(context, closing);
            }
            await closing;
          }
        },
      };
      const attempt = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          scope.reject(error);
        }
      };
      const aggregateWatchdog = setTimeout(() => {
        scope.reject(new Error('INT18 직렬 세 검사 합계 36분 제한에 도달했습니다.'));
        void scope.closeContexts();
      }, SUITE_BUDGET_MS);
      try {
        scope.journey = await createJourney(legalStack, browser, scope);
        await use(scope);
      } catch (error) {
        scope.reject(error);
      } finally {
        if (!controller.signal.aborted) controller.abort(new Error('INT18 직렬 검사 종료'));
        await scope.closeContexts();
        for (const body of scope.bodies) await attempt(() => body);
        while (scope.active.size) {
          const settled = await Promise.allSettled([...scope.active]);
          for (const result of settled) if (result.status === 'rejected') scope.reject(result.reason);
        }
        await scope.closeContexts();
        const allCasesPassed =
          !scope.failed &&
          scope.phase === 3 &&
          JSON.stringify(scope.passedPhaseIds) === '[1,2,3]' &&
          JSON.stringify(scope.completedStepIds) === '["F01","F02","F03","F04","F05","F06","F07","F08"]';
        if (!allCasesPassed) scope.reject(new Error('INT18 세 검사와 여덟 단계가 모두 완료되지 않았습니다.'));
        for (const world of scope.worlds) {
          if (!world.hold) {
            scope.reject(new Error('실행권을 얻지 못한 자기 월드를 보존합니다.'));
            continue;
          }
          try {
            world.hold.done.abort();
          } catch (error) {
            scope.reject(error);
          }
          await attempt(() => world.hold!.renewal);
          if (world.hold.lost) scope.reject(world.hold.lost);
        }
        if (allCasesPassed && !scope.failed) {
          await attempt(async () => {
            const url = new URL(e2eDatabaseUrl());
            const [database] = await legalStack.db.$queryRaw<
              Array<{ name: string }>
            >`SELECT current_database() AS name`;
            if (
              !['127.0.0.1', 'localhost'].includes(url.hostname) ||
              url.pathname.slice(1) !== legalStack.database ||
              database?.name !== legalStack.database
            )
              throw new Error('자기 loopback 전용 DB를 확인하지 못해 데이터를 보존합니다.');
            const owned = [...scope.worlds].sort((left, right) => left.id.localeCompare(right.id));
            if (owned.some((world) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(world.id) || !world.hold))
              throw new Error('자기 UUID와 실행권을 확인하지 못했습니다.');
            await legalStack.db.$transaction(
              async (tx) => {
                for (const world of owned) {
                  await lockLease(tx, world.hold!.lease);
                  await tx.$queryRaw`SELECT id FROM "World" WHERE id=${world.id} FOR UPDATE`;
                  await assertLease(tx, world.hold!.lease);
                }
                for (const world of owned) await tx.world.delete({ where: { id: world.id } });
                for (const user of scope.users) {
                  if (!owned.some((world) => world.id === user.worldId)) throw new Error('소유 월드 밖의 계정입니다.');
                  await tx.user.delete({ where: { id: user.id } });
                }
              },
              { timeout: 30_000 },
            );
            for (const world of owned) world.deleted = true;
          });
        }
        for (const world of scope.worlds) {
          if (!world.hold) continue;
          await attempt(() => releaseLease(world.hold!.db, world.hold!.lease));
          await attempt(() => world.hold!.db.$disconnect());
        }
        clearTimeout(aggregateWatchdog);
        scope.evidence.cleanup = {
          bodySettled: true,
          bodyCount: scope.bodies.length,
          caseCount: scope.caseReceipts.length,
          enginePromisesSettled: scope.active.size === 0,
          failed: scope.failed,
          worlds: scope.worlds.map((world) => ({
            worldId: world.id,
            deleted: world.deleted,
            retained: !world.deleted,
          })),
          users: scope.users.map((user) => ({
            userId: user.id,
            retained: !scope.worlds.find((world) => world.id === user.worldId)?.deleted,
          })),
          errorCount: scope.errors.length,
        };
        const receipt = {
          version: 1,
          database: legalStack.database,
          allCasesPassed: allCasesPassed && !scope.failed,
          completedPhaseIds: scope.passedPhaseIds,
          completedStepIds: scope.completedStepIds,
          caseReceipts: scope.caseReceipts,
          ...scope.evidence,
        };
        await attempt(async () => {
          const output = new URL('../test-results/', import.meta.url);
          await mkdir(output, { recursive: true });
          await writeFile(
            new URL('int18-city-journey-' + legalStack.database + '.json', output),
            JSON.stringify(receipt, null, 2) + '\n',
            { flag: 'wx' },
          );
        });
      }
      if (scope.errors.length) throw new AggregateError(scope.errors, 'INT18 3개 검사 또는 자기 자원 정리 실패');
    },
    { scope: 'worker', timeout: LIFECYCLE_BUDGET_MS },
  ],
  cityCase: [
    async ({ cityJourney }, use, info) => {
      const scope = cityJourney,
        phase = scope.phase + 1,
        started = Date.now();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const attempt = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          scope.reject(error);
        }
      };
      try {
        scope.controller.signal.throwIfAborted();
        expect(info.timeout).toBe(CASE_BUDGET_MS);
        expect(scope.passedPhaseIds).toEqual(Array.from({ length: phase - 1 }, (_, i) => i + 1));
        watchdog = setTimeout(
          () => {
            scope.reject(new Error('INT18 개별 검사 본문 실행 제한에 도달했습니다.'));
            void scope.closeContexts();
          },
          Math.max(1000, info.timeout - 30_000),
        );
        await use(scope);
      } catch (error) {
        scope.reject(error);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (info.status !== info.expectedStatus)
          scope.reject(new Error('INT18 runner 상태: ' + (info.status ?? 'unknown')));
        if (scope.failed) await scope.closeContexts();
        if (scope.body) await attempt(() => scope.body!);
        while (scope.active.size) {
          const settled = await Promise.allSettled([...scope.active]);
          for (const result of settled) if (result.status === 'rejected') scope.reject(result.reason);
        }
        if (scope.failed) await scope.closeContexts();
        if (!scope.failed && info.status === info.expectedStatus && scope.phase === phase)
          scope.passedPhaseIds.push(phase);
        else if (!scope.failed) scope.reject(new Error('INT18 단계 본문이 완료되지 않았습니다.'));
        scope.caseReceipts.push({ phase, status: scope.failed ? 'failed' : 'passed', elapsedMs: Date.now() - started });
        scope.body = undefined;
        await attempt(() =>
          info.attach('int18-city-resources-case-receipt', {
            body: JSON.stringify(
              {
                phase,
                status: info.status,
                completedPhaseIds: scope.passedPhaseIds,
                completedStepIds: scope.completedStepIds,
                ...scope.evidence,
              },
              null,
              2,
            ),
            contentType: 'application/json',
          }),
        );
      }
      if (scope.failed) throw new AggregateError(scope.errors, 'INT18 개별 검사 실패: 후속 검사와 원장을 보존합니다.');
    },
    { timeout: LIFECYCLE_BUDGET_MS },
  ],
});

test.describe.serial('AC-INT-18C 공개 빌드 정식 도시 자원 직렬 인수', () => {
  test.beforeAll(({ cityJourney }) => {
    test.setTimeout(LIFECYCLE_BUDGET_MS);
    expect(cityJourney.phase).toBe(0);
    expect(cityJourney.journey).toBeDefined();
  });
  test.afterEach(({ cityCase }, info) => {
    if (info.status !== info.expectedStatus)
      cityCase.reject(new Error('INT18 afterEach 상태: ' + (info.status ?? 'unknown')));
  });
  test.afterAll(({ cityJourney }) => {
    test.setTimeout(LIFECYCLE_BUDGET_MS);
    try {
      expect(cityJourney.phase).toBe(3);
      expect(cityJourney.passedPhaseIds).toEqual([1, 2, 3]);
      expect(cityJourney.completedStepIds).toEqual(['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08']);
      expect(cityJourney.failed).toBe(false);
    } catch (error) {
      cityJourney.reject(error);
      throw error;
    }
  });
  test('AC-INT-18C-01 원생성·사람·임관·이동·30칸·빈 부곡', async ({ cityCase }, info) => {
    test.setTimeout(CASE_BUDGET_MS);
    await cityCase.run(async () => {
      expect(cityCase.phase).toBe(0);
      await cityCase.journey!.origin(info);
      cityCase.phase = 1;
    });
  });
  test('AC-INT-18C-02 실제 세수·도시 모병·징병·훈련·사기와 단차감', async ({ cityCase }, info) => {
    test.setTimeout(CASE_BUDGET_MS);
    await cityCase.run(async () => {
      expect(cityCase.phase).toBe(1);
      await cityCase.journey!.commands(info);
      cityCase.phase = 2;
    });
  });
  test('AC-INT-18C-03 배속 권한·멱등·375px·구판·재시작 복구', async ({ cityCase }, info) => {
    test.setTimeout(CASE_BUDGET_MS);
    await cityCase.run(async () => {
      expect(cityCase.phase).toBe(2);
      await cityCase.journey!.boundaries(info);
      cityCase.phase = 3;
    });
  });
});

async function createJourney(legalStack: LegalStack, browser: Browser, cityRun: CityRun): Promise<Journey> {
  const db = legalStack.db;
  const databaseUrl = e2eDatabaseUrl();
  expect(new URL(databaseUrl).pathname.slice(1)).toBe(legalStack.database);
  const manifest = JSON.parse(
    await readFile(new URL('../apps/web/dist/public-build.json', import.meta.url), 'utf8'),
  ) as { mode: string };
  expect(manifest.mode).toBe('public');
  const { worlds, contexts, users, active, evidence } = cityRun;
  const controlledChanges = evidence.controlledChanges as unknown[];
  function track<T>(work: Promise<T>): Promise<T> {
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => undefined);
    return work;
  }
  function allocationResponse(actor: Actor, worldId: string) {
    return track(
      actor.page
        .waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            trpcCalls(response.request()).some((call) => {
              const input = call.input as Partial<Allocation>;
              return (
                call.path === 'cityResources.allocate' &&
                input.worldId === worldId &&
                input.expectedUserId === actor.userId
              );
            }),
          { timeout: 10_000 },
        )
        .then(async (response) => {
          expect(response.status()).toBe(200);
          const calls = trpcCalls(response.request()),
            index = calls.findIndex((call) => call.path === 'cityResources.allocate');
          const body: unknown = await response.json();
          const item = (Array.isArray(body) ? body[index] : body) as { result?: { data?: Receipt } };
          return { input: calls[index]!.input as Allocation, data: item.result?.data };
        }),
    );
  }
  async function snapshot(world: OwnedWorld) {
    return db.$transaction((tx) => loadReplayState(tx, world.id), {
      isolationLevel: 'RepeatableRead',
    });
  }
  async function advance(world: OwnedWorld, tick: number) {
    cityRun.controller.signal.throwIfAborted();
    if (!world.hold || !world.loop) throw new Error('자기 실행권이 없습니다.');
    if (world.hold.lost) throw world.hold.lost;
    const signal = AbortSignal.any([cityRun.controller.signal, AbortSignal.timeout(120_000)]);
    const executions = await track(world.loop.advanceTo(tick, signal));
    signal.throwIfAborted();
    if (world.hold.lost) throw world.hold.lost;
    const row = await db.world.findUniqueOrThrow({ where: { id: world.id } });
    expect(row.status).toBe('RUNNING');
    expect(row.clockTick).toBe(tick);
    return executions;
  }
  async function drain(world: OwnedWorld) {
    const { clockTick } = await db.world.findUniqueOrThrow({
      where: { id: world.id },
    });
    return advance(world, clockTick);
  }
  async function createWorld(enabled: boolean) {
    cityRun.controller.signal.throwIfAborted();
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'int18-chromium-formal-v1',
    });
    initial.ruleFeatures = features.filter((key) => enabled || key !== 'city-resources-v1');
    expect(initial.generals).toHaveLength(491);
    expect(initial.nations).toHaveLength(21);
    expect(initial.cities.filter((city) => city.kind === 'CITY')).toHaveLength(53);
    expect(initial.cities.filter((city) => city.kind === 'PASS')).toHaveLength(8);
    cityRun.controller.signal.throwIfAborted();
    const { worldId } = await saveInitialWorld(db, initial, {
      name: enabled ? 'INT18 Chromium 정식 도시 자원' : 'INT18 Chromium 기존 판',
      turnTermMinutes: 60,
      endYear: 201,
    });
    const world: OwnedWorld = { id: worldId, initial, deleted: false };
    worlds.push(world);
    cityRun.controller.signal.throwIfAborted();
    world.hold = await holdLease(worldId);
    cityRun.controller.signal.throwIfAborted();
    world.loop = new TurnLoop(world.hold.db, world.hold.lease);
    await controlClock(db, worldId, 'start');
    return world;
  }
  const person = (world: OwnedWorld, actor: Actor) =>
    db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: world.id, id: actor.generalId } },
    });
  const turns = (world: OwnedWorld, actor: Actor) =>
    db.generalTurn.findMany({
      where: { worldId: world.id, generalId: actor.generalId },
      orderBy: { slot: 'asc' },
    });
  async function createActor(world: OwnedWorld, name: string): Promise<Actor> {
    cityRun.controller.signal.throwIfAborted();
    // 시험 UUID만 골라 실제 생성 함수가 주는 월 offset의 NPC 경합을 피한다. RNG/장수 tick은 고치지 않는다.
    const initial = world.initial;
    const used = await db.general.findMany({
      where: { worldId: world.id },
      select: { nextTurnTick: true },
    });
    let userId = '';
    for (let index = 0; index < 1000; index++) {
      const candidate = randomUUID();
      const created = buildCreatedGeneral({
        payload: {
          name,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
          portraitId: null,
        },
        seed: initial.seed,
        userId: candidate,
        id: 492,
        startYear: initial.startYear,
        monthlyTick: 0,
        tick: 0,
        cityKeys: initial.cities.filter((city) => city.kind === 'CITY').map((city) => city.cityKey),
        unitSet: initial.unitSet,
      });
      if (
        created.nextTurnTick >= 200 &&
        created.nextTurnTick <= 1500 &&
        !used.some((general) => general.nextTurnTick % TICKS_PER_MONTH === created.nextTurnTick)
      ) {
        userId = candidate;
        break;
      }
    }
    if (!userId) throw new Error('NPC와 다른 합법 사람 생성 offset을 찾지 못했습니다.');
    const session = newSession(Date.now());
    const passwordHash = await hashPassword(TEST_PASSWORD);
    cityRun.controller.signal.throwIfAborted();
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        passwordHash,
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    users.push({ id: userId, worldId: world.id });
    cityRun.controller.signal.throwIfAborted();
    const context = await browser.newContext({
      baseURL: legalStack.origin,
      viewport: { width: 1280, height: 900 },
    });
    contexts.push(context);
    cityRun.controller.signal.throwIfAborted();
    await context.addCookies([
      {
        name: 'sid',
        value: session.token,
        url: legalStack.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    await page.goto(`/w/${world.id}/create`);
    await expect(page.getByRole('spinbutton')).toHaveCount(5);
    await page.getByLabel('이름', { exact: true }).fill(name);
    await page.getByRole('button', { name: '고르게 나누기', exact: true }).click();
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await expect
      .poll(() =>
        db.inputEvent.count({
          where: {
            worldId: world.id,
            userId,
            kind: 'general.create',
            status: 'PENDING',
          },
        }),
      )
      .toBe(1);
    await drain(world);
    await expect(page).toHaveURL(`${legalStack.origin}/w/${world.id}`);
    const general = await db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId: world.id, userId } },
    });
    const state = await snapshot(world);
    expect(general.id).toBeGreaterThan(491);
    expect(state.state.campaign!.sources[String(general.id)]).toMatch(/^input:\d+#general:\d+$/);
    const actor = { userId, generalId: general.id, context, page, unitId: 0 };
    expect(await turns(world, actor)).toHaveLength(30);
    return actor;
  }
  async function put(actor: Actor, slot: number, name: string, fields: Record<string, string> = {}) {
    await actor.page.bringToFront();
    const editor = actor.page.getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator(`tr[data-slot="${slot}"]`).click();
    await editor.getByLabel('명령 찾기', { exact: true }).fill(name);
    await editor.getByRole('radio', { name, exact: true }).check();
    for (const [label, value] of Object.entries(fields)) {
      const control = editor
        .getByRole('combobox', { name: label, exact: true })
        .or(editor.getByRole('spinbutton', { name: label, exact: true }))
        .or(editor.getByRole('textbox', { name: label, exact: true }));
      if ((await control.evaluate((element) => element.tagName)) === 'SELECT') await control.selectOption(value);
      else await control.fill(value);
    }
    await editor.getByRole('button', { name: `${slot}번 칸에 넣기`, exact: true }).click();
    await expect(editor.locator(`tr[data-slot="${slot}"]`)).toContainText(name);
  }
  async function save(actor: Actor) {
    const editor = actor.page.getByTestId('turn-editor');
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByTestId('draft-state')).toHaveText('저장된 목록');
  }
  async function join(world: OwnedWorld, actor: Actor, nationId: number) {
    await put(actor, 1, '임관', { '대상 국가': String(nationId) });
    await save(actor);
    const tick = (await person(world, actor)).nextTurnTick;
    await advance(world, tick);
    expect((await person(world, actor)).nationId).toBe(nationId);
    await actor.page.reload();
  }
  async function board(world: OwnedWorld, actor: Actor, cityKey: number): Promise<Board> {
    const response = await read<Outputs['cityResources']['get']>(actor.page, 'cityResources.get', {
      worldId: world.id,
      cityKey,
    });
    expect(response.userId).toBe(actor.userId);
    if (!response.visible) throw new Error('시험하는 자국 도시의 상세 조회가 거부됐습니다.');
    expect(response.cityKey).toBe(cityKey);
    return response;
  }
  async function showResources(world: OwnedWorld, actor: Actor, cityKey: number) {
    await actor.page.bringToFront();
    const value = await board(world, actor, cityKey);
    const panel = resourcePanel(actor.page);
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText(`금 ${value.resources.gold.toLocaleString('ko-KR')}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByText(`쌀 ${value.resources.rice.toLocaleString('ko-KR')}`, {
        exact: true,
      }),
    ).toBeVisible();
    const troops = value.resources.garrison.reduce((sum, row) => sum + row.troops, 0);
    await expect(
      panel.getByText(`수비병 합계 ${troops.toLocaleString('ko-KR')}명`, {
        exact: true,
      }),
    ).toBeVisible();
    for (const row of value.resources.garrison) {
      const name = value.armyTypes.find((type) => type.id === row.crewType)!.name;
      const visible = panel
        .getByRole('table', { name: '병종별 도시 수비병', exact: true })
        .getByRole('row')
        .filter({ has: actor.page.getByRole('cell', { name, exact: true }) });
      for (const [index, count] of [row.troops, row.train, row.atmos].entries())
        await expect(visible.getByRole('cell').nth(index + 1)).toHaveText(count.toLocaleString('ko-KR'));
    }
    return value;
  }
  let a: OwnedWorld | undefined, b: OwnedWorld | undefined, legacy: OwnedWorld | undefined;
  let owner: Actor | undefined, other: Actor | undefined;
  let cityKey = 0,
    nationId = 0,
    isolatedHash = '';
  let request: Allocation | undefined;
  let browserCalls: Call[] = [];

  let main: OwnedWorld, isolated: OwnedWorld, oldWorld: OwnedWorld;
  let actor: Actor, protectedActor: Actor;
  let info: TestInfo;
  async function step(id: string, title: string, body: () => Promise<void>) {
    cityRun.controller.signal.throwIfAborted();
    if (cityRun.completedStepIds.includes(id)) throw new Error('이미 끝난 도시 검사를 다시 실행할 수 없습니다.');
    await test.step(title, body);
    cityRun.completedStepIds.push(id);
  }
  return {
    async origin(currentInfo) {
      info = currentInfo;
      await step('F01', 'F01 정식 191년491장수21국61거점 새 판·두 월드·구판 원생성', async () => {
        a = await createWorld(true);
        b = await createWorld(true);
        legacy = await createWorld(false);
        const [first, second, old] = await Promise.all([snapshot(a), snapshot(b), snapshot(legacy)]);
        for (const world of [a, b, legacy]) {
          expect(await db.general.count({ where: { worldId: world.id } })).toBe(491);
          expect(await db.nation.count({ where: { worldId: world.id } })).toBe(21);
          expect(await db.city.count({ where: { worldId: world.id } })).toBe(61);
        }
        expect(first.state.cityResources).toEqual(second.state.cityResources);
        const ledger = first.state.cityResources!;
        expect(Object.keys(ledger.cities)).toHaveLength(61);
        for (const row of Object.values(ledger.cities)) expect(row).toEqual({ gold: 0, rice: 0, garrison: [] });
        expect(old.state.cityResources).toBeUndefined();
        expect((await db.world.findUniqueOrThrow({ where: { id: legacy.id } })).cityResourcesState).toBeNull();
        isolatedHash = hashState(second);
        evidence.formalOrigin = {
          generals: 491,
          nations: 21,
          cities: 53,
          passes: 8,
          ledgerKeys: 61,
        };
      });
      main = a!;
      isolated = b!;
      oldWorld = legacy!;
      await step('F02', 'F02 화면 실제 사람 생성·임관·각자 2월 이동·30칸·빈 부곡', async () => {
        owner = await createActor(main, '도시검사1');
        other = await createActor(main, '도시검사2');
        // 아직 모집/정산하지 않았으므로 실제 사람 생성 뒤 첫 상세 화면에서만 0 panel을 검사한다.
        await showResources(main, owner, (await person(main, owner)).cityKey);
        await photo(owner.page, info, '01-formal-new-empty-city');
        // 공용 금을 먼저 쓰는 NPC를 제거하거나 자금을 채우지 않는다.
        // 실제 유언국 수도에 임관한 뒤 각 사람이 자기 예약으로 자동까지 이동한다.
        const nation = main.initial.nations.find((row) => row.id === 4);
        if (!nation) throw new Error('정식 191년의 유언국이 없습니다.');
        expect(nation.capitalCityKey).toBe(5);
        const fundingRoute = [5, 87, 44];
        for (const key of fundingRoute)
          expect(main.initial.cities.find((city) => city.cityKey === key)).toMatchObject({ nationId: nation.id });
        expect(main.initial.cities.find((city) => city.cityKey === 87)?.kind).toBe('PASS');
        expect(main.initial.cities.find((city) => city.cityKey === 44)?.kind).toBe('CITY');
        nationId = nation.id;
        cityKey = nation.capitalCityKey;
        // 두 사람 예약을 먼저 저장한 뒤 큰 tick까지 진행한다. 시계를 뒤로 이동하지 않는다.
        for (const actor of [owner, other]) {
          await put(actor, 1, '임관', { '대상 국가': String(nationId) });
          await save(actor);
        }
        const people = await Promise.all([person(main, owner), person(main, other)]);
        await advance(main, Math.max(...people.map((row) => row.nextTurnTick)));
        for (const actor of [owner, other]) {
          expect(await person(main, actor)).toMatchObject({
            nationId,
            cityKey,
            officerLevel: 1,
          });
          await actor.page.reload();
        }
        const movementEvidence: Array<{ generalId: number; tick: number; from: number; to: number }> = [];
        for (let hop = 1; hop < fundingRoute.length; hop++) {
          const from = fundingRoute[hop - 1]!,
            to = fundingRoute[hop]!;
          const beforeMove = (await snapshot(main)).state;
          expect(beforeMove.cities[from]!.connections).toContain(to);
          expect(beforeMove.cities[to]!.nationId).toBe(nationId);
          const due: Array<{ generalId: number; tick: number }> = [];
          for (const actor of [owner, other]) {
            expect((await person(main, actor)).cityKey).toBe(from);
            const oldTurns = await turns(main, actor);
            await put(actor, 1, '이동', { '대상 도시': String(to) });
            const peer = actor === owner ? other : owner;
            const peerTurns = await turns(main, peer);
            await save(actor);
            expect(await turns(main, peer)).toEqual(peerTurns);
            expect((await turns(main, actor)).slice(1)).toEqual(oldTurns.slice(1));
            // 예약 저장은 두 사람 어느 쪽의 실제 위치도 옮기지 않는다.
            for (const separate of [owner, other]) expect((await person(main, separate)).cityKey).toBe(from);
            const tick = (await person(main, actor)).nextTurnTick;
            expect(tick, '각 hop은 해당 사람의 다음 한 달 턴으로 실행한다').toBe(
              people.find((row) => row.id === actor.generalId)!.nextTurnTick + hop * TICKS_PER_MONTH,
            );
            due.push({ generalId: actor.generalId, tick });
          }
          const executions = await advance(main, Math.max(...due.map((row) => row.tick)));
          expect(executions.filter((row) => due.some((person) => person.generalId === row.generalId))).toEqual(
            due
              .map(({ generalId, tick }) => ({ generalId, tick, commandKey: 'move' }))
              .sort((left, right) => left.tick - right.tick || left.generalId - right.generalId),
          );
          for (const actor of [owner, other]) {
            const tick = due.find((row) => row.generalId === actor.generalId)!.tick;
            expect(await person(main, actor)).toMatchObject({ nationId, cityKey: to, officerLevel: 1 });
            expect(
              await db.generalLog.findFirstOrThrow({
                where: { worldId: main.id, generalId: actor.generalId, tick, commandKey: 'move' },
              }),
            ).toMatchObject({ kind: 'success' });
            expect(await turns(main, actor)).toHaveLength(30);
            movementEvidence.push({ generalId: actor.generalId, tick, from, to });
            await actor.page.reload();
          }
        }
        cityKey = 44;
        evidence.normalFundingPrecondition = {
          nationId,
          capitalCityKey: nation.capitalCityKey,
          cityKey,
          route: fundingRoute,
          movements: movementEvidence,
          independentHumanCommands: true,
          resourceOrPositionInjection: false,
        };
        const campaign = owner.page.getByRole('region', {
          name: '개인 휘하·부곡',
          exact: true,
        });
        await campaign
          .getByRole('combobox', { name: '새 부곡 지휘관', exact: true })
          .selectOption(String(owner.generalId));
        await campaign.getByRole('combobox', { name: '새 부곡 병종', exact: true }).selectOption('1100');
        await campaign.getByRole('button', { name: '빈 부곡 편성', exact: true }).click();
        await expect
          .poll(() =>
            db.inputEvent.count({
              where: {
                worldId: main.id,
                kind: 'campaign.unit',
                status: 'PENDING',
              },
            }),
          )
          .toBe(1);
        await drain(main);
        const state = (await snapshot(main)).state;
        const unit = state.campaign!.units.find((row) => row.ownerId === owner!.generalId);
        expect(unit).toMatchObject({
          troops: 0,
          commanderId: owner.generalId,
          crewType: 1100,
        });
        owner.unitId = unit!.id;
        expect(state.generals[owner.generalId]!.crew).toBe(0);
        expect(await turns(main, other)).toHaveLength(30);
        await expect(campaign).toContainText('소유 부곡 1개');
        await photo(owner.page, info, '02-person-30slots-empty-unit');
      });
    },
    async commands(currentInfo) {
      info = currentInfo;
      actor = owner!;
      protectedActor = other!;
      browserCalls = watch(actor.page);
      await step('F03', 'F03 실제 세수 후 도시 모병·징병·훈련·사기 예약과 단차감', async () => {
        // 임의 자금 없이 실제 월 경계를 진행한다. 금0이면 다음 실제 수확까지 기다린다.
        for (let month = 0; month < 7; month++) {
          const state = (await snapshot(main)).state;
          if (state.cityResources!.cities[String(cityKey)]!.gold >= 1000) break;
          const current = (await db.world.findUniqueOrThrow({ where: { id: main.id } })).clockTick;
          await advance(main, (Math.floor(current / TICKS_PER_MONTH) + 1) * TICKS_PER_MONTH);
        }
        expect((await snapshot(main)).state.cityResources!.cities[String(cityKey)]!.gold).toBeGreaterThanOrEqual(1000);
        await actor.page.reload();
        const commands: Array<{
          key: CityPreparationKey;
          name: string;
          args: Record<string, number | string>;
        }> = [
          { key: 'recruit', name: '모병', args: { amount: 40, crewType: 1100 } },
          {
            key: 'conscript',
            name: '징병',
            args: { amount: 10, crewType: 1100 },
          },
          {
            key: 'train',
            name: '훈련',
            args: { target: 'city', crewType: 1100 },
          },
          {
            key: 'morale',
            name: '사기진작',
            args: { target: 'city', crewType: 1100 },
          },
        ];
        for (const command of commands) {
          const fields: Record<string, string> =
            command.key === 'recruit' || command.key === 'conscript'
              ? { 수량: String(command.args.amount), '병종 번호': '1100' }
              : { '훈련·사기 대상': 'city', '병종 번호': '1100' };
          await put(actor, 1, command.name, fields);
          await save(actor);
          const saved = await turns(main, actor);
          expect(saved[0]).toMatchObject({
            commandKey: command.key,
            args: command.args,
            explicit: true,
          });
          expect(saved[0]!.args).not.toHaveProperty('unitId');
          const humanTick = (await person(main, actor)).nextTurnTick;
          await advance(main, humanTick - 1);
          const before = await snapshot(main);
          const due = await db.general.findMany({
            where: {
              worldId: main.id,
              nextTurnTick: humanTick,
              activeFromYear: {
                lte: before.state.startYear + Math.floor(humanTick / (12 * TICKS_PER_MONTH)),
              },
            },
            select: { id: true, userId: true },
          });
          expect(due, 'humanTick 단차에 다른 NPC/사람을 섞지 않는다').toEqual([
            { id: actor.generalId, userId: actor.userId },
          ]);
          expect(humanTick % TICKS_PER_MONTH, '같은 단차에 월 정산 경계를 섞지 않는다').not.toBe(0);
          const general = before.state.generals[actor.generalId]!,
            city = before.state.cities[cityKey]!,
            resource = before.state.cityResources!.cities[String(cityKey)]!,
            army = main.initial.unitSet.crewTypes.find((row) => row.id === 1100 && row.armType > 0);
          expect(general).toMatchObject({ cityKey: 44, nationId: 4 });
          expect(city.nationId).toBe(4);
          expect(army, '실제 원본 병종 1100이 필요하다').toBeDefined();
          const recruiting = command.key === 'recruit' || command.key === 'conscript';
          const requiredGold = recruiting
            ? recruitCost(before.state, general, Number(command.args.amount), army!.cost, command.key === 'conscript')
            : BALANCE.DRILL_COST;
          const garrison = resource.garrison.find((row) => row.crewType === 1100);
          evidence.fundingPrecondition = {
            tick: humanTick,
            commandKey: command.key,
            cityKey,
            gold: resource.gold,
            requiredGold,
            population: city.population,
            requiredPopulation: recruiting ? Number(command.args.amount) : 0,
            garrison: garrison ?? null,
            actualNpcPrefixCompleted: true,
          };
          const previousPreconditions = (evidence.cityCommandPreconditions ?? []) as unknown[];
          previousPreconditions.push(evidence.fundingPrecondition);
          evidence.cityCommandPreconditions = previousPreconditions;
          expect(
            resource.gold,
            `${command.key}: NPC 실행 뒤 실제 도시 금이 필요비용 이상이어야 한다`,
          ).toBeGreaterThanOrEqual(requiredGold);
          if (recruiting) expect(city.population).toBeGreaterThanOrEqual(Number(command.args.amount));
          else {
            expect(garrison, `${command.key}: 실제 모집된 도시 수비병이 필요하다`).toBeDefined();
            expect(garrison!.troops).toBeGreaterThan(0);
            expect(
              garrison![command.key === 'train' ? 'train' : 'atmos'],
              '원본 NPC 준비 뒤에도 훈련 여유가 있어야 한다',
            ).toBeLessThan(100);
          }
          const expected = applyCityPreparation(
            before.state,
            {
              generalId: actor.generalId,
              tick: humanTick,
              unitSet: main.initial.unitSet,
            },
            command.key,
            command.args,
          );
          if (!expected.ok) throw new Error(`${command.key}: ${expected.code}: ${expected.message}`);
          const protectedTurns = await turns(main, protectedActor);
          const executions = await advance(main, humanTick);
          expect(executions).toEqual([
            {
              generalId: actor.generalId,
              tick: humanTick,
              commandKey: command.key,
            },
          ]);
          const after = await snapshot(main);
          expect(after.state.cityResources).toEqual(expected.state.cityResources);
          expect(after.state.cities[cityKey]).toEqual(expected.state.cities[cityKey]);
          expect(after.state.campaign!.units).toEqual(before.state.campaign!.units);
          for (const id of Object.keys(before.state.nations).map(Number))
            expect([after.state.nations[id]!.gold, after.state.nations[id]!.rice]).toEqual([
              before.state.nations[id]!.gold,
              before.state.nations[id]!.rice,
            ]);
          expect([after.state.generals[actor.generalId]!.gold, after.state.generals[actor.generalId]!.rice]).toEqual([
            before.state.generals[actor.generalId]!.gold,
            before.state.generals[actor.generalId]!.rice,
          ]);
          expect(await turns(main, protectedActor)).toEqual(protectedTurns);
          expect(
            await db.generalLog.findFirstOrThrow({
              where: {
                worldId: main.id,
                generalId: actor.generalId,
                tick: humanTick,
              },
            }),
          ).toMatchObject({ kind: 'success', commandKey: command.key });
          await actor.page.reload();
          await showResources(main, actor, cityKey);
        }
        await photo(actor.page, info, '03-city-recruited-trained-morale');
        expect(hashState(await snapshot(isolated))).toBe(isolatedHash);
      });
    },
    async boundaries(currentInfo) {
      info = currentInfo;
      await step('F04', 'F04 일반 장수403·쿠키 신원409 미접수 뒤 통제 직책 UI 배속', async () => {
        const rejected = {
          worldId: main.id,
          requestId: randomUUID(),
          expectedUserId: actor.userId,
          payload: { cityKey, unitId: actor.unitId, crewType: 1100, amount: 10 },
        };
        const eventCount = await db.inputEvent.count({
          where: { worldId: main.id },
        });
        const beforeDenied = await snapshot(main);
        expect(await api(actor.page, 'cityResources.allocate', rejected, true)).toMatchObject({
          http: 403,
          code: 'FORBIDDEN',
        });
        const preflight = await read<Outputs['auth']['me']>(actor.page, 'auth.me', undefined);
        expect(preflight.user?.id).toBe(actor.userId);
        expect(
          await api(
            protectedActor.page,
            'cityResources.allocate',
            {
              ...rejected,
              requestId: randomUUID(),
              expectedUserId: preflight.user!.id,
            },
            true,
          ),
        ).toMatchObject({ http: 409, code: 'CONFLICT' });
        cityRun.controller.signal.throwIfAborted();
        const anonymous = await browser.newContext({ baseURL: legalStack.origin });
        contexts.push(anonymous);
        cityRun.controller.signal.throwIfAborted();
        const anonymousPage = await anonymous.newPage();
        await anonymousPage.goto('/login');
        expect(
          await api(anonymousPage, 'cityResources.allocate', { ...rejected, requestId: randomUUID() }, true),
        ).toMatchObject({ http: 401, code: 'UNAUTHORIZED' });
        expect(await db.inputEvent.count({ where: { worldId: main.id } })).toBe(eventCount);
        expect(await snapshot(main)).toEqual(beforeDenied);
        // 자기 사람 직책만 시험용으로 바꾼다. 금·병력·소속·위치·역사 인물은 바꾸지 않는다.
        const role = [5, 6, 7, 8, 9, 10, 11].find(
          (level) =>
            !Object.values(beforeDenied.state.generals).some(
              (general) => general.nationId === nationId && general.officerLevel === level,
            ),
        );
        if (role === undefined || !main.hold) throw new Error('자기 사람만의 권한 고정물을 만들지 못했습니다.');
        cityRun.controller.signal.throwIfAborted();
        await db.$transaction(async (tx) => {
          await lockLease(tx, main.hold!.lease);
          await tx.$queryRaw`SELECT id FROM "World" WHERE id=${main.id} FOR UPDATE`;
          cityRun.controller.signal.throwIfAborted();
          await tx.general.update({
            where: { worldId_id: { worldId: main.id, id: actor.generalId } },
            data: { officerLevel: role },
          });
          await assertLease(tx, main.hold!.lease);
          cityRun.controller.signal.throwIfAborted();
        });
        controlledChanges.push({
          worldId: main.id,
          generalId: actor.generalId,
          field: 'officerLevel',
          before: 1,
          after: role,
          reason: '실제 생성·출사 뒤 배속 권한 UI 고정물',
          fullSeasonEvidence: false,
        });
        await actor.page.reload();
        await actor.page.bringToFront();
        expect((await board(main, actor, cityKey)).canAllocate).toBe(true);
        const form = actor.page.getByRole('form', {
          name: '도시 병력 배속',
          exact: true,
        });
        await expect(form).toBeVisible();
        const unitSelect = form.getByRole('combobox', { name: '배속할 부곡', exact: true });
        await expect(unitSelect).toBeEnabled();
        await expect(unitSelect.locator(`option[value="${actor.unitId}"]`)).toHaveCount(1);
        await unitSelect.selectOption(String(actor.unitId));
        await form.getByLabel('배속 인원', { exact: true }).fill('10');
        const start = browserCalls.length;
        const acceptedResponse = allocationResponse(actor, main.id);
        await form.getByRole('button', { name: '도시 수비병을 부곡에 배속', exact: true }).click();
        await actor.page.keyboard.press('Enter');
        await actor.page.keyboard.press('Enter');
        await expect
          .poll(() => browserCalls.slice(start).filter((call) => call.path === 'cityResources.allocate').length)
          .toBe(1);
        request = browserCalls.slice(start).find((call) => call.path === 'cityResources.allocate')!.input as Allocation;
        expect(request).toMatchObject({
          worldId: main.id,
          expectedUserId: actor.userId,
          payload: rejected.payload,
        });
        const accepted = await acceptedResponse;
        expect(accepted.input).toEqual(request);
        expect(accepted.data).toMatchObject({ userId: actor.userId, requestId: request.requestId, status: 'pending' });
        expect(
          await read<Receipt>(actor.page, 'cityResources.request', {
            worldId: main.id,
            requestId: request.requestId,
          }),
        ).toMatchObject({
          userId: actor.userId,
          requestId: request.requestId,
          status: 'pending',
        });
        await expect(resourcePanel(actor.page)).toContainText('배속 요청을 확인하는 중입니다.');
        await photo(actor.page, info, '04-allocation-pending');
        await actor.page.reload();
        await expect(resourcePanel(actor.page)).toContainText('배속 요청을 확인하는 중입니다.');
        const before = await snapshot(main),
          protectedTurns = await turns(main, protectedActor),
          ownerTurns = await turns(main, actor);
        await drain(main);
        await expect(resourcePanel(actor.page)).toContainText('도시 병력을 부곡에 배속했습니다.');
        const receipt = await read<Receipt>(actor.page, 'cityResources.request', {
          worldId: main.id,
          requestId: request.requestId,
        });
        expect(receipt).toMatchObject({
          userId: actor.userId,
          requestId: request.requestId,
          status: 'applied',
        });
        const after = await snapshot(main);
        const oldCity = before.state.cityResources!.cities[String(cityKey)]!,
          newCity = after.state.cityResources!.cities[String(cityKey)]!;
        const oldUnit = before.state.campaign!.units.find((unit) => unit.id === actor.unitId)!,
          newUnit = after.state.campaign!.units.find((unit) => unit.id === actor.unitId)!;
        expect(newCity.garrison.find((row) => row.crewType === 1100)!.troops).toBe(
          oldCity.garrison.find((row) => row.crewType === 1100)!.troops - 10,
        );
        expect(newUnit.troops).toBe(oldUnit.troops + 10);
        const transferred = oldCity.garrison.find((row) => row.crewType === 1100)!;
        expect([newUnit.train, newUnit.atmos]).toEqual([
          Math.floor((oldUnit.troops * oldUnit.train + 10 * transferred.train) / (oldUnit.troops + 10)),
          Math.floor((oldUnit.troops * oldUnit.atmos + 10 * transferred.atmos) / (oldUnit.troops + 10)),
        ]);
        expect(newUnit.troops + newCity.garrison.reduce((sum, row) => sum + row.troops, 0)).toBe(
          oldUnit.troops + oldCity.garrison.reduce((sum, row) => sum + row.troops, 0),
        );
        expect([newCity.gold, newCity.rice]).toEqual([oldCity.gold, oldCity.rice]);
        expect(after.state.cities).toEqual(before.state.cities);
        expect(after.state.nations).toEqual(before.state.nations);
        expect(after.state.generals).toEqual(before.state.generals);
        expect(after.state.campaign!.links).toEqual(before.state.campaign!.links);
        expect([newUnit.ownerId, newUnit.commanderId]).toEqual([oldUnit.ownerId, oldUnit.commanderId]);
        expect(await turns(main, protectedActor)).toEqual(protectedTurns);
        expect(await turns(main, actor)).toEqual(ownerTurns);
        expect(browserCalls.slice(start).filter((call) => call.path === 'cityResources.allocate')).toHaveLength(1);
        await photo(actor.page, info, '05-allocation-applied');
        evidence.allocation = {
          requestId: request.requestId,
          result: receipt,
          cityDecrease: 10,
          unitIncrease: 10,
        };
      });
      await step('F05', 'F05 도시 선택·저장 전 초안·375px·키보드', async () => {
        await put(actor, 4, '농지 개간');
        const editor = actor.page.getByTestId('turn-editor');
        const identity = await editor.elementHandle();
        const current = (await snapshot(main)).state;
        const second = Object.values(current.cities).find(
          (city) => city.nationId === nationId && city.cityKey !== cityKey && city.kind === 'CITY',
        );
        if (!second) throw new Error('정식 국가의 두 번째 도시를 찾지 못했습니다.');
        await actor.page.getByTestId('world-map').locator(`[data-city-key="${second.cityKey}"]`).focus();
        await actor.page.keyboard.press('Enter');
        await expect(
          actor.page.getByRole('region', { name: '도시 정보', exact: true }).locator('[data-city-key]'),
        ).toHaveAttribute('data-city-key', String(second.cityKey));
        await showResources(main, actor, second.cityKey);
        expect(await editor.evaluate((node, original) => node === original, identity)).toBe(true);
        await expect(editor.locator('tr[data-slot="4"]')).toContainText('농지 개간');
        const enemy = Object.values(current.cities).find(
          (city) => city.nationId !== null && city.nationId !== nationId,
        );
        if (!enemy) throw new Error('실제 공개 범위 검사용 타국 도시가 없습니다.');
        await actor.page.getByTestId('world-map').locator(`[data-city-key="${enemy.cityKey}"]`).focus();
        await actor.page.keyboard.press('Enter');
        await expect(resourcePanel(actor.page)).toContainText('자기 국가 도시나 내 장수가 있는 도시에서만');
        await expect(resourcePanel(actor.page).getByText(/^금 /)).toHaveCount(0);
        expect(
          await read<Outputs['cityResources']['get']>(actor.page, 'cityResources.get', {
            worldId: main.id,
            cityKey: enemy.cityKey,
          }),
        ).toEqual({ userId: actor.userId, cityKey: enemy.cityKey, visible: false });
        await actor.page.setViewportSize({ width: 375, height: 812 });
        await actor.page.getByRole('button', { name: '내 도시로', exact: true }).click();
        await showResources(main, actor, cityKey);
        await expect(editor.locator('tr[data-slot="4"]')).toContainText('농지 개간');
        const form = actor.page.getByRole('form', { name: '도시 병력 배속', exact: true });
        await expect(form).toBeVisible();
        const select = form.getByRole('combobox', { name: '배속할 부곡', exact: true });
        await expect(select).toBeEnabled();
        await expect(select.locator(`option[value="${actor.unitId}"]`)).toHaveCount(1);
        await touchTarget(select);
        await touchTarget(actor.page.getByLabel('배속 인원', { exact: true }));
        await select.selectOption(String(actor.unitId));
        await select.focus();
        await actor.page.keyboard.press('Tab');
        await expect(actor.page.getByLabel('배속 인원', { exact: true })).toBeFocused();
        expect(await actor.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await photo(actor.page, info, '06-city-allocation-375px');
        await actor.page.setViewportSize({ width: 1280, height: 900 });
        await editor.getByRole('button', { name: '편집 취소', exact: true }).click();
      });
      await step('F06', 'F06 실제 HTTP 동일 UUID 한 번·다른 내용409·타인 결과404', async () => {
        const accepted = request!;
        const before = await snapshot(main);
        const count = await db.inputEvent.count({ where: { worldId: main.id } });
        expect(await api(actor.page, 'cityResources.allocate', accepted, true)).toMatchObject({
          http: 200,
          data: {
            userId: actor.userId,
            requestId: accepted.requestId,
            status: 'applied',
          },
        });
        expect(
          await api(
            actor.page,
            'cityResources.allocate',
            { ...accepted, payload: { ...accepted.payload, amount: 11 } },
            true,
          ),
        ).toMatchObject({ http: 409, code: 'CONFLICT' });
        expect(
          await api(protectedActor.page, 'cityResources.request', {
            worldId: main.id,
            requestId: accepted.requestId,
          }),
        ).toMatchObject({ http: 404, code: 'NOT_FOUND' });
        expect(await db.inputEvent.count({ where: { worldId: main.id } })).toBe(count);
        expect(await snapshot(main)).toEqual(before);
        expect(
          await db.inputEvent.count({
            where: {
              worldId: main.id,
              userId: actor.userId,
              idempotencyKey: `city.resources:${accepted.requestId}`,
            },
          }),
        ).toBe(1);
        expect(hashState(await snapshot(isolated))).toBe(isolatedHash);
        evidence.rejections = {
          unauthenticated: 401,
          forbidden: 403,
          identityConflict: 409,
          changedPayload: 409,
          otherAccount: 404,
          rejectedInputCount: 0,
        };
      });
      await step('F07', 'F07 구판은 도시 원장 UI/API 없음·기존 부곡 인자 보존', async () => {
        const oldActor = await createActor(oldWorld, '구판검사');
        const oldCalls = watch(oldActor.page);
        await join(oldWorld, oldActor, nationId);
        const summary = await read<Outputs['world']['summary']>(oldActor.page, 'world.summary', {
          worldId: oldWorld.id,
        });
        expect(Object.hasOwn(summary, 'cityResourcesEnabled')).toBe(false);
        await expect(resourcePanel(oldActor.page)).toHaveCount(0);
        await put(oldActor, 1, '모병', {
          수량: '1',
          '병종 번호': '1100',
          '부곡 번호': '1',
        });
        await expect(oldActor.page.getByTestId('turn-editor').getByLabel('부곡 번호', { exact: true })).toBeVisible();
        await expect(
          oldActor.page.getByTestId('turn-editor').getByLabel('훈련·사기 대상', { exact: true }),
        ).toHaveCount(0);
        expect(oldCalls.filter((call) => call.path.startsWith('cityResources.'))).toHaveLength(0);
        expect((await db.world.findUniqueOrThrow({ where: { id: oldWorld.id } })).cityResourcesState).toBeNull();
        await photo(oldActor.page, info, '07-legacy-without-city-resources');
      });
      await step('F08', 'F08 같은 탭 pending을 API 재시작 뒤 복구·새 context는 알려진 UUID 조회', async () => {
        await actor.page.bringToFront();
        const form = actor.page.getByRole('form', {
          name: '도시 병력 배속',
          exact: true,
        });
        await expect(form).toBeVisible();
        const unitSelect = form.getByRole('combobox', { name: '배속할 부곡', exact: true });
        await expect(unitSelect).toBeEnabled();
        await expect(unitSelect.locator(`option[value="${actor.unitId}"]`)).toHaveCount(1);
        await unitSelect.selectOption(String(actor.unitId));
        await form.getByLabel('배속 인원', { exact: true }).fill('1');
        const start = browserCalls.length;
        const acceptedResponse = allocationResponse(actor, main.id);
        await form.getByRole('button', { name: '도시 수비병을 부곡에 배속', exact: true }).click();
        await expect
          .poll(() => browserCalls.slice(start).filter((call) => call.path === 'cityResources.allocate').length)
          .toBe(1);
        const pending = browserCalls.slice(start).find((call) => call.path === 'cityResources.allocate')!
          .input as Allocation;
        const admitted = await acceptedResponse;
        expect(admitted.input).toEqual(pending);
        expect(admitted.data).toMatchObject({ userId: actor.userId, requestId: pending.requestId, status: 'pending' });
        await expect
          .poll(() =>
            db.inputEvent.count({
              where: {
                worldId: main.id,
                userId: actor.userId,
                idempotencyKey: `city.resources:${pending.requestId}`,
                status: 'PENDING',
              },
            }),
          )
          .toBe(1);
        await legalStack.restart(null);
        await actor.page.reload();
        await expect(resourcePanel(actor.page)).toContainText('배속 요청을 확인하는 중입니다.');
        expect(browserCalls.slice(start).filter((call) => call.path === 'cityResources.allocate')).toHaveLength(1);
        await drain(main);
        await expect(resourcePanel(actor.page)).toContainText('도시 병력을 부곡에 배속했습니다.');
        cityRun.controller.signal.throwIfAborted();
        const fresh = await browser.newContext({
          baseURL: legalStack.origin,
          storageState: await actor.context.storageState(),
        });
        contexts.push(fresh);
        cityRun.controller.signal.throwIfAborted();
        const page = await fresh.newPage();
        await page.goto(`/w/${main.id}`);
        expect(
          await page.evaluate(
            (key) => sessionStorage.getItem(key),
            `city.resources.pending:${actor.userId}:${main.id}`,
          ),
        ).toBeNull();
        const receipt = await read<Receipt>(page, 'cityResources.request', {
          worldId: main.id,
          requestId: pending.requestId,
        });
        expect(receipt).toMatchObject({
          userId: actor.userId,
          requestId: pending.requestId,
          status: 'applied',
        });
        expect(
          await db.inputEvent.count({
            where: {
              worldId: main.id,
              userId: actor.userId,
              idempotencyKey: `city.resources:${pending.requestId}`,
            },
          }),
        ).toBe(1);
        evidence.restart = {
          sameTabPendingRecovery: true,
          newContextKnownUuidQueryOnly: true,
          requestId: pending.requestId,
        };
      });
    },
  };
}
