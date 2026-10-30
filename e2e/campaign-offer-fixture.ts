import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  test as standaloneBase,
  expect,
  type Browser,
  type Cookie,
  type Page,
  type Route,
  type Request,
} from '@playwright/test';
import type { OfferRuntime } from './campaign-offer-ci-stack';
import type { readCampaignBoard } from '../apps/server/src/game/campaignApi';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { hashState } from '../packages/shared/src/node/hashState';
import { e2eDatabaseUrl, appOrigin, TEST_PASSWORD } from './account';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, renewLease, releaseLease, lockLease, assertLease, LEASE_TTL_MS } from '../apps/engine/src/lease';
import { bounded, WorkScope, guardedDb, guardedUi, mayDeleteFixtureRows } from '../tools/campaign-offer-lifetime';
import { query as rawQuery, ApiError, type LeaseHold } from './game';

const standalone = standaloneBase.extend<Record<never, never>, { offerRuntime: OfferRuntime | undefined }>({
  offerRuntime: [undefined, { scope: 'worker' }],
});
// 순수 수명 검사는 Playwright worker hook을 불러오지 않는다. 전용 구성만 실제 공개 stack을 사용한다.
const base =
  process.env.CAMPAIGN_OFFER_CI_STACK === '1'
    ? ((await import('./campaign-offer-ci-stack')).test as typeof standalone)
    : standalone;

const pageScopes = new WeakMap<Page, WorkScope>();
const pageOrigins = new WeakMap<Page, string>();
let passwordHash: Promise<string> | undefined;
export function query<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const scope = pageScopes.get(page);
  if (!scope) throw new Error('등록된 시험 페이지만 요청할 수 있습니다.');
  return scope.work('HTTP query', () => rawQuery<T>(page, path, input));
}
export function mutate<T = Record<string, unknown>>(page: Page, path: string, input: unknown): Promise<T> {
  const scope = pageScopes.get(page);
  if (!scope) throw new Error('등록된 시험 페이지만 접수할 수 있습니다.');
  return scope.work('HTTP mutation', async () => {
    const response = await page.request.post(`/trpc/${path}`, {
      data: input,
      headers: { Origin: pageOrigins.get(page) ?? appOrigin() },
    });
    const body = (await response.json()) as { result?: { data?: T }; error?: { data?: { code?: string } } };
    if (!response.ok()) throw new ApiError(path, response.status(), body.error?.data?.code);
    return body.result?.data as T;
  });
}

export type Board = Awaited<ReturnType<typeof readCampaignBoard>>;
export type Offer = {
  worldId: string;
  requestId: string;
  expectedUserId: string;
  payload: {
    type: 'offer';
    targetId: number;
    relation: 'LIEUTENANT';
    revision: number;
  };
};
type User = { page: Page; id: string; email: string; cookies: Cookie[] };
type World = { id: string; hold: LeaseHold; tick: number };
type Call = { path: string; input: unknown; index: number };

export function calls(request: Request): Call[] {
  const url = new URL(request.url());
  const names = url.pathname.split('/trpc/')[1]?.split(',') ?? [];
  const body = request.method() === 'GET' ? url.searchParams.get('input') : request.postData();
  const data = body ? JSON.parse(body) : undefined;
  return names.map((path, index) => ({ path, index, input: url.searchParams.has('batch') ? data?.[index] : data }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

type ProgressPhase =
  | 'public-metadata'
  | 'account-context'
  | 'account-password'
  | 'account-create'
  | 'account-cookie'
  | 'account-auth'
  | 'world-resources'
  | 'world-persist'
  | 'world-lease'
  | 'world-start'
  | 'human-create-page'
  | 'human-create-form'
  | 'human-create-input'
  | 'human-create-advance'
  | 'human-create-url'
  | 'join-inputs'
  | 'join-advance'
  | 'consent-offer'
  | 'consent-accept'
  | 'consent-release'
  | 'world-snapshot'
  | 'final-board-navigation'
  | 'final-board-response'
  | 'final-panel'
  | 'test-body'
  | 'cleanup';
const diagnosticTaskLabels = new Set([
  'prepare',
  'test body',
  'HTTP query',
  'HTTP mutation',
  'engine advance',
  'acquire lease',
  'new context',
  'new page',
  'password hash',
  'create account',
  'session cookie',
  'create world',
  'temporary DB client',
  'route or response observer',
  'route fetch',
  'offer click',
  'manual offer route fetch',
  'UI goto',
  'UI waitForResponse',
  'UI click',
  'UI fill',
  'UI json',
  'UI post',
  'UI get',
  'findMany',
  'findFirstOrThrow',
  'count',
  '$transaction',
  '$queryRaw',
  '$executeRaw',
]);
function diagnosticPending(tasks: Array<{ label: string; settled: boolean }>) {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    if (task.settled) continue;
    const label = diagnosticTaskLabels.has(task.label) ? task.label : 'other';
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

// Request.timing은 응답 전에0이다. 도착 순서와 실제 capture-click 경계만 쓴다.
export class OfferRequestOrder {
  private sequence = 0;
  private readonly arrivals = new WeakMap<object, number>();
  private boundary: number | null = null;
  private claimed = false;
  observe(request: object) {
    if (!this.arrivals.has(request)) this.arrivals.set(request, ++this.sequence);
  }
  arm() {
    if (this.boundary !== null) throw new Error('한 제안의 클릭 경계는 한 번만 기록합니다.');
    this.boundary = this.sequence;
  }
  beforeClick(request: object) {
    const arrival = this.arrivals.get(request);
    return this.boundary !== null && arrival !== undefined && arrival <= this.boundary;
  }
  claim(request: object) {
    const arrival = this.arrivals.get(request);
    if (this.claimed || this.boundary === null || arrival === undefined || arrival <= this.boundary) return false;
    this.claimed = true;
    return true;
  }
}

export async function settleIndependentJoins<T>(work: Array<() => Promise<T>>, cancel: () => void): Promise<T[]> {
  let cancelled = false;
  const results = await Promise.allSettled(
    work.map((start) =>
      Promise.resolve()
        .then(start)
        .catch((error: unknown) => {
          if (!cancelled) {
            cancelled = true;
            cancel();
          }
          throw error;
        }),
    ),
  );
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown);
  if (failures.length) throw new AggregateError(failures, '독립 월드 출사 처리 실패');
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export class OfferFixture {
  constructor(
    private readonly cleanupAuditDb: () => PrismaClient = () => createDb(e2eDatabaseUrl()),
    private readonly runtime?: OfferRuntime,
  ) {}
  private origin() {
    return this.runtime?.origin ?? appOrigin();
  }
  users: User[] = [];
  worlds: World[] = [];
  createdWorlds = new Set<string>();
  releases: Array<() => void> = [];
  readonly scope = new WorkScope();
  readonly rawHolds = new Map<string, LeaseHold>();
  readonly clients = new Set<PrismaClient>();
  readonly contexts = new Set<ReturnType<Page['context']>>();
  journal: unknown[] = [];
  deliveredBoard: Board | undefined;
  closing = false;
  private readonly requestOrder = new OfferRequestOrder();
  private readonly progressStartedAt = Date.now();
  private currentPhase: ProgressPhase = 'public-metadata';
  progress(phase: ProgressPhase) {
    this.currentPhase = phase;
    console.log('[campaign-offer-phase]', JSON.stringify({ phase, elapsedMs: Date.now() - this.progressStartedAt }));
  }
  progressPending(event: 'timeout' | 'finalize') {
    console.log(
      '[campaign-offer-pending]',
      JSON.stringify({
        event,
        phase: this.currentPhase,
        elapsedMs: Date.now() - this.progressStartedAt,
        pending: diagnosticPending(this.scope.summary()),
      }),
    );
  }
  describeFailure = (reason: unknown) => {
    let text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    text = text.split(/\r?\n/).find((line) => line.trim()) ?? 'Unknown failure';
    if (reason instanceof Error && reason.cause !== undefined) text += ` <- ${String(reason.cause).split(/\r?\n/)[0]}`;
    for (const user of this.users)
      for (const cookie of user.cookies) if (cookie.value) text = text.replaceAll(cookie.value, '[private cookie]');
    for (const value of [process.env.DATABASE_URL, process.env.TEST_DATABASE_URL])
      if (value) {
        text = text.replaceAll(value, '[private DB URL]');
        const password = decodeURIComponent(new URL(value).password);
        if (password) text = text.replaceAll(password, '[private]');
      }
    return text.slice(0, 180);
  };
  run(work: () => Promise<void>) {
    this.progress('test-body');
    return this.scope.cancellable(this.scope.work('test body', work));
  }
  track<T>(task: Promise<T>) {
    return this.scope.retain('route or response observer', task);
  }
  async withDb<T>(work: (db: PrismaClient) => Promise<T>): Promise<T> {
    this.scope.check();
    const raw = createDb(e2eDatabaseUrl());
    this.clients.add(raw);
    return this.scope.retain(
      'temporary DB client',
      (async () => {
        try {
          return await work(guardedDb(raw, this.scope));
        } finally {
          await raw.$disconnect();
          this.clients.delete(raw);
        }
      })(),
    );
  }
  async hold(worldId: string) {
    this.scope.check();
    const raw = createDb(e2eDatabaseUrl());
    this.clients.add(raw);
    const lease = await this.scope.work('acquire lease', () => acquireLease(guardedDb(raw, this.scope), worldId));
    if (!lease) throw new Error('자기 시험 실행권을 얻지 못했습니다.');
    const done = new AbortController();
    const hold: LeaseHold = { db: raw, lease, done, renewal: Promise.resolve() };
    this.rawHolds.set(worldId, hold);
    hold.renewal = (async () => {
      while (!done.signal.aborted) {
        try {
          await delay(LEASE_TTL_MS / 3, undefined, { signal: done.signal });
          await renewLease(raw, lease);
        } catch (error) {
          if (!done.signal.aborted) hold.lost = error;
          return;
        }
      }
    })();
    const guarded = guardedDb(raw, this.scope);
    return new Proxy(hold, {
      get(target, key) {
        return key === 'db' ? guarded : Reflect.get(target, key);
      },
    });
  }
  async prepare(browser: Browser) {
    if (!this.runtime && process.env.CAMPAIGN_OFFER_PUBLIC_DIST !== '1')
      throw new Error('공개 dist 전용 실행기가 필요합니다.');
    this.progress('public-metadata');
    const meta = await (await fetch(`${this.origin()}/public-build.json`, { signal: this.scope.signal })).json();
    expect(meta.mode).toBe('public');
    for (let i = 0; i < 2; i++) {
      this.scope.check();
      this.progress('account-context');
      const context = await this.scope.work(
        'new context',
        () => browser.newContext({ baseURL: this.origin(), viewport: { width: 1440, height: 900 } }),
        (value) => this.contexts.add(value),
      );
      const page = guardedUi(await this.scope.work('new page', () => context.newPage()), this.scope);
      page.on('request', (request) => this.requestOrder.observe(request));
      pageScopes.set(page, this.scope);
      pageOrigins.set(page, this.origin());
      // 생성 도중 실패해도 자기 context와 계정의 수명을 추적한다.
      const user: User = { page, id: '', email: `e2e-offer-${randomUUID()}@example.test`, cookies: [] };
      this.users.push(user);
      this.progress('account-password');
      const hash = await this.scope.work('password hash', () => (passwordHash ??= hashPassword(TEST_PASSWORD)));
      this.scope.check();
      const session = newSession(Date.now());
      this.progress('account-create');
      await this.scope.work(
        'create account',
        () =>
          this.withDb((db) =>
            db.user.create({
              data: {
                email: user.email,
                passwordHash: hash,
                sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
              },
              select: { id: true },
            }),
          ),
        (row) => {
          user.id = row.id;
        },
      );
      this.progress('account-cookie');
      await this.scope.work('session cookie', () =>
        context.addCookies([
          { name: 'sid', value: session.token, url: this.origin(), httpOnly: true, sameSite: 'Lax' },
        ]),
      );
      user.cookies = await context.cookies(this.origin());
      this.progress('account-auth');
      user.id = (await query<{ user: { id: string } }>(page, 'auth.me')).user.id;
    }
    const joinTargets: Array<{ world: World; tick: number }> = [];
    for (let i = 0; i < 2; i++) {
      // 결과를 골라내지 않는 고정 시드. 두 월드는 사람 UUID·입력·일정을 공유한다.
      this.progress('world-resources');
      const initial = await loadInitialWorld({
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'int11-offer-controlled-npc-v1',
      });
      initial.ruleFeatures = [
        'campaign-v1',
        'five-stats',
        'operational-map',
        'personnel',
        'policy',
        'stratagem-basic',
        'treaty',
      ];
      expect(initial.generals).toHaveLength(491);
      expect(initial.nations).toHaveLength(21);
      this.scope.check();
      this.progress('world-persist');
      const { worldId } = await this.scope.work(
        'create world',
        () =>
          this.withDb(async (db) => {
            const result = await saveInitialWorld(db, initial, {
              name: `휘하 실제 대조 ${i}`,
              turnTermMinutes: 60,
              endYear: 201,
            });
            this.createdWorlds.add(result.worldId);
            return result;
          }),
        (result) => this.createdWorlds.add(result.worldId),
      );
      this.progress('world-lease');
      const hold = await this.hold(worldId);
      const world = { id: worldId, hold, tick: 0 };
      this.worlds.push(world);
      this.progress('world-start');
      await controlClock(hold.db, worldId, 'start');
      for (const [index, user] of this.users.entries()) {
        this.progress('human-create-page');
        await user.page.goto(`/w/${worldId}/create`);
        this.progress('human-create-form');
        await expect(user.page.getByRole('spinbutton')).toHaveCount(5);
        await user.page.getByLabel('이름', { exact: true }).fill(`제안장수${index}`);
        await user.page.getByRole('button', { name: '고르게 나누기' }).click();
        this.progress('human-create-input');
        await user.page.getByRole('button', { name: '장수 만들기', exact: true }).click();
        await expect
          .poll(() => hold.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
          .toBe(1);
        this.progress('human-create-advance');
        await this.advance(world, 0);
        this.progress('human-create-url');
        await expect(user.page).toHaveURL(`${this.origin()}/w/${worldId}`);
      }
      const humans = await hold.db.general.findMany({
        where: { worldId, userId: { in: this.users.map((u) => u.id) } },
        orderBy: { id: 'asc' },
      });
      expect(humans.map((g) => g.id)).toEqual([492, 493]);
      this.progress('join-inputs');
      for (const user of this.users)
        await mutate(user.page, 'turns.set', {
          worldId,
          revision: 0,
          slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
        });
      joinTargets.push({ world, tick: Math.max(...humans.map((g) => g.nextTurnTick)) });
    }
    // 서로 다른 월드의 실행권·시드·입력은 독립이다. 둘 다 정착한 뒤 동의 절차를 잇는다.
    this.progress('join-advance');
    await settleIndependentJoins(
      joinTargets.map(
        ({ world, tick }) =>
          () =>
            this.advance(world, tick),
      ),
      () => this.scope.cancel(),
    );
    for (const world of this.worlds) for (const user of this.users) await user.page.goto(`/w/${world.id}`);
    await settleIndependentJoins(
      this.worlds.map((world) => () => this.prepareConsent(world)),
      () => this.scope.cancel(),
    );
    this.progress('world-snapshot');
    expect(hashState(await this.snapshot(this.worlds[0]!))).toBe(hashState(await this.snapshot(this.worlds[1]!)));
    const page = this.users[0]!.page;
    const loaded = this.track(
      page.waitForResponse((response) =>
        calls(response.request()).some(
          (call) =>
            call.path === 'campaign.get' && (call.input as { worldId?: string })?.worldId === this.worlds[0]!.id,
        ),
      ),
    );
    this.progress('final-board-navigation');
    await page.goto(`/w/${this.worlds[0]!.id}`);
    this.progress('final-board-response');
    const response = await loaded;
    const call = calls(response.request()).find((call) => call.path === 'campaign.get')!;
    const body = await response.json();
    this.deliveredBoard = (Array.isArray(body) ? body[call.index] : body).result.data as Board;
    this.progress('final-panel');
    await expect(this.panel()).toBeVisible();
  }
  private async prepareConsent(world: World) {
    const { id: worldId, hold } = world;
    const board = await this.board(world);
    expect(board.resources.gold).toBeGreaterThanOrEqual(500);
    expect(board.cityKey).toBe((await this.board(world, 1)).cityKey);
    expect(await hold.db.generalTurn.count({ where: { worldId, generalId: 493 } })).toBe(30);
    // 사람 휘하는 본인의 실제 응답 후에만 성립한다. 이후 해제해 NPC 시험의 초기 상태를 맞춘다.
    this.progress('world-snapshot');
    const humanBefore = await this.snapshot(world);
    this.progress('consent-offer');
    const offerId = randomUUID();
    await mutate(this.users[0]!.page, 'campaign.relationship', {
      worldId,
      requestId: offerId,
      expectedUserId: this.users[0]!.id,
      payload: { type: 'offer', targetId: 493, relation: 'STAFF', revision: board.revision },
    });
    await this.advance(world, world.tick);
    const offered = await this.board(world, 1);
    expect(offered.links).toHaveLength(0);
    const humanOffer = offered.offers.find((o) => o.personId === 493 && o.status === 'PENDING');
    expect(humanOffer).toBeDefined();
    this.progress('consent-accept');
    await mutate(this.users[1]!.page, 'campaign.relationship', {
      worldId,
      requestId: randomUUID(),
      payload: { type: 'respond', offerId: humanOffer!.id, accept: true, revision: offered.revision },
    });
    await this.advance(world, world.tick);
    const accepted = await this.board(world, 1);
    expect(accepted.links).toContainEqual({ masterId: 492, personId: 493, relation: 'STAFF' });
    this.progress('consent-release');
    await mutate(this.users[1]!.page, 'campaign.relationship', {
      worldId,
      requestId: randomUUID(),
      payload: { type: 'release', personId: 493, revision: accepted.revision },
    });
    await this.advance(world, world.tick);
    expect((await this.board(world)).links).toHaveLength(0);
    this.progress('world-snapshot');
    const humanAfter = await this.snapshot(world);
    for (const id of [492, 493]) expect(humanAfter.state.generals[id]!.gold).toBe(humanBefore.state.generals[id]!.gold);
    expect(humanAfter.turns).toEqual(humanBefore.turns);
    expect(humanAfter.revisions).toEqual(humanBefore.revisions);
    this.journal.push({ humanConsent: worldId, requestId: offerId, cost: 0 });
  }
  panel() {
    return this.users[0]!.page.getByRole('region', { name: '개인 휘하·부곡' });
  }
  board(world = this.worlds[0]!, user = 0) {
    this.scope.check();
    return query<Board>(this.users[user]!.page, 'campaign.get', { worldId: world.id });
  }
  snapshot(world: World) {
    this.scope.check();
    return world.hold.db.$transaction((tx) => loadReplayState(tx, world.id), { isolationLevel: 'RepeatableRead' });
  }
  async advance(world: World, tick: number) {
    if (this.closing) throw new Error('정리가 시작되어 새 엔진 진행을 막습니다.');
    expect(world.hold.lost).toBeUndefined();
    this.scope.check();
    const startedAt = Date.now();
    const executions = await this.scope.work('engine advance', () =>
      new TurnLoop(world.hold.db, world.hold.lease).advanceTo(tick, this.scope.signal),
    );
    world.tick = tick;
    const observation = { tick, executions: executions.length, elapsedMs: Date.now() - startedAt };
    this.journal.push({ engineAdvance: { worldId: world.id, ...observation } });
    console.log('[campaign-offer-advance]', JSON.stringify(observation));
  }
  async npcCommit() {
    const [main, control] = this.worlds as [World, World];
    const actorCity = (await this.board(main)).cityKey;
    // 관찰 횟수는 최대 40개 due tick. 결과를 얻기 위한 재실행·seed 재선택은 없다.
    for (let step = 0; step < 40; step++) {
      this.scope.check();
      const due = await control.hold.db.general.findFirstOrThrow({
        where: { worldId: control.id, activeFromYear: { lte: 191 } },
        orderBy: [{ nextTurnTick: 'asc' }, { id: 'asc' }],
      });
      const human = await control.hold.db.general.aggregate({
        where: { worldId: control.id, userId: { not: null } },
        _min: { nextTurnTick: true },
      });
      expect(due.nextTurnTick).toBeLessThan(human._min.nextTurnTick!);
      expect(Math.floor(due.nextTurnTick / 10000)).toBe(Math.floor(control.tick / 10000));
      const before = (await this.snapshot(control)).state.campaign!.revision;
      const tick = due.nextTurnTick;
      await settleIndependentJoins(
        [control, main].map((world) => () => this.advance(world, tick)),
        () => this.scope.cancel(),
      );
      const logs = await control.hold.db.generalLog.findMany({
        where: { worldId: control.id, tick, kind: 'success', commandKey: { in: ['recruit', 'train', 'morale'] } },
      });
      const ids = logs.map((log) => log.generalId);
      const others = await control.hold.db.general.findMany({
        where: { worldId: control.id, id: { in: ids }, userId: null, cityKey: { not: actorCity } },
      });
      const after = (await this.snapshot(control)).state.campaign!.revision;
      expect(hashState(await this.snapshot(main))).toBe(hashState(await this.snapshot(control)));
      if (others.length && after > before) {
        const matching = await main.hold.db.generalLog.findMany({
          where: {
            worldId: main.id,
            tick,
            kind: 'success',
            generalId: { in: others.map((g) => g.id) },
            commandKey: { in: ['recruit', 'train', 'morale'] },
          },
        });
        expect(matching.length).toBeGreaterThan(0);
        this.journal.push({
          npcCommit: { tick, before, after, logs: matching.map((l) => ({ id: l.generalId, command: l.commandKey })) },
        });
        return;
      }
    }
    throw new Error('40개 정상 due tick에서 다른 도시 NPC 개정 commit을 찾지 못했습니다. 재시도하지 않습니다.');
  }
  candidate(board: Board) {
    const npc = board.people.find(
      (p) =>
        !p.isHuman &&
        board.candidates.includes(p.id) &&
        p.renownCost + board.renownUsed <= board.renownCapacity &&
        !board.npcPledge.attempts.some((a) => a.personId === p.id && a.month === board.npcPledge.month),
    );
    expect(npc).toBeDefined();
    return npc!;
  }
  async draft() {
    this.scope.check();
    const page = this.users[0]!.page;
    const editor = page.getByTestId('turn-editor');
    await editor.locator('tr[data-slot="30"]').click();
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
    await editor.getByRole('button', { name: /에 넣기$/ }).click();
    const node = await editor.elementHandle();
    const url = page.url();
    const turns = await this.worlds[0]!.hold.db.generalTurn.findMany({
      where: { worldId: this.worlds[0]!.id },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    });
    return async () => {
      expect(page.url()).toBe(url);
      expect(
        await node!.evaluate(
          (element) => element.isConnected && element === document.querySelector('[data-testid="turn-editor"]'),
        ),
      ).toBe(true);
      await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
      expect(
        await this.worlds[0]!.hold.db.generalTurn.findMany({
          where: { worldId: this.worlds[0]!.id },
          orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
        }),
      ).toEqual(turns);
    };
  }
  async gateRead(targetName: string) {
    this.scope.check();
    const page = this.users[0]!.page;
    const button = this.panel().getByRole('button', { name: `${targetName}에게 제안`, exact: true });
    await this.panel().getByLabel('제안할 관계').selectOption('LIEUTENANT');
    const clickBinding = 'offerClick' + randomUUID().replaceAll('-', '');
    await page.exposeFunction(clickBinding, () => this.requestOrder.arm());
    await button.evaluate(
      (element, binding) =>
        element.addEventListener(
          'click',
          () => {
            // capture에서 보낸 binding 메시지는 React의 새 요청보다 먼저 도착한다.
            void (window as unknown as Record<string, () => Promise<void>>)[binding]!();
          },
          { once: true, capture: true },
        ),
      clickBinding,
    );
    const seen = deferred<Board>(),
      gate = deferred<void>();
    this.releases.push(() => {
      gate.resolve();
      seen.reject(new Error('정리 중 최신 조회 대기를 끝냅니다.'));
    });
    let armed = true;
    const handler = (route: Route) =>
      this.track(
        (async () => {
          if (this.scope.signal.aborted) return route.abort('aborted');
          const call = calls(route.request()).find((c) => c.path === 'campaign.get');
          if (!armed || !call || route.request().method() !== 'GET') return route.fallback();
          if (!this.requestOrder.claim(route.request())) return route.fallback();
          armed = false;
          const response = await this.scope.work('route fetch', () => route.fetch());
          const json = await response.json();
          const board = (Array.isArray(json) ? json[call.index] : json).result.data as Board;
          seen.resolve(board);
          await gate.promise;
          if (this.scope.signal.aborted) return route.abort('aborted');
          await route.fulfill({ response });
        })().catch((reason: unknown) => {
          if (this.scope.isExpectedCancellation(reason)) {
            seen.reject(reason);
            throw reason;
          }
          const error = new Error('실제 최신 조회 응답 전달에 실패했습니다.', { cause: reason });
          seen.reject(error);
          throw error;
        }),
      );
    await page.route('**/trpc/**', handler);
    return {
      click: () => {
        return this.scope.work('offer click', () => button.click());
      },
      seen: seen.promise,
      release: () => gate.resolve(),
    };
  }
  async holdPolls() {
    this.scope.check();
    const page = this.users[0]!.page;
    const gate = deferred<void>();
    this.releases.push(() => gate.resolve());
    let holding = true;
    await page.route('**/trpc/**', (route) =>
      this.track(
        (async () => {
          if (this.scope.signal.aborted) return route.abort('aborted');
          if (
            !holding ||
            route.request().method() !== 'GET' ||
            !calls(route.request()).some((c) => c.path === 'campaign.get')
          )
            return route.fallback();
          try {
            const response = await this.scope.work('route fetch', () => route.fetch());
            await gate.promise;
            if (this.scope.signal.aborted) return route.abort('aborted');
            await route.fulfill({ response });
          } catch (error) {
            // 명시적 재조회가 취소한 자기 이전 poll만 허용한다.
            const ownFreshReadCancelledOldPoll =
              !this.scope.signal.aborted &&
              this.requestOrder.beforeClick(route.request()) &&
              route.request().failure()?.errorText === 'net::ERR_ABORTED';
            if (!ownFreshReadCancelledOldPoll) throw error;
          }
        })(),
      ),
    );
    return () => {
      holding = false;
      gate.resolve();
    };
  }
  observePosts() {
    const rows: Array<{ input: Offer; cookieIsB: boolean; status: number }> = [];
    const page = this.users[0]!.page;
    const bCookie = this.users[1]!.page.context().cookies(this.origin());
    page.on('response', (response) => {
      this.track(
        (async () => {
          if (this.scope.signal.aborted) return;
          if (response.request().method() !== 'POST') return;
          for (const call of calls(response.request()).filter((c) => c.path === 'campaign.relationship')) {
            const token = (await bCookie).find((c) => c.name === 'sid')!.value;
            const cookie = await response.request().headerValue('cookie');
            rows.push({
              input: call.input as Offer,
              cookieIsB: cookie?.split(';').some((v) => v.trim() === `sid=${token}`) ?? false,
              status: response.status(),
            });
          }
        })(),
      );
    });
    return rows;
  }
  async switchTo(user: number) {
    this.scope.check();
    const cookies = this.users[user]!.cookies;
    await this.users[0]!.page.context().addCookies(cookies.filter((c) => c.name === 'sid'));
  }
  async input(requestId: string) {
    this.scope.check();
    return this.worlds[0]!.hold.db.inputEvent.findFirstOrThrow({
      where: { worldId: this.worlds[0]!.id, idempotencyKey: `campaign:${requestId}` },
    });
  }
  async cleanup(bodyPassed: boolean) {
    const failedBeforeCleanup = this.scope.failures().length > 0;
    const errors: string[] = [];
    this.closing = true;
    this.scope.cancel();
    for (const release of this.releases) release();
    const closedContexts: boolean[] = [];
    await Promise.all(
      [...this.contexts].map(async (context) => {
        try {
          await bounded('context close', context.close(), 10000);
          closedContexts.push(true);
        } catch {
          closedContexts.push(false);
          errors.push('context close uncertain');
        }
      }),
    );
    let tasksSettled = false;
    try {
      await this.scope.settle(35000);
      tasksSettled = true;
    } catch {
      errors.push('body/routes/SQL/engine unsettled');
    }
    for (const hold of this.rawHolds.values()) hold.done.abort();
    let renewalsSettled = true;
    await Promise.all(
      [...this.rawHolds.values()].map(async (hold) => {
        try {
          await bounded('renewal settlement', hold.renewal, 5000);
        } catch {
          renewalsSettled = false;
          errors.push('renewal unsettled');
        }
      }),
    );
    const settledTaskFailures = this.scope.failures(this.describeFailure);
    if (settledTaskFailures.length) errors.push('tracked task failure after settlement; preserve rows');
    const canDelete = mayDeleteFixtureRows({
      bodyPassed,
      hadFailure: failedBeforeCleanup || settledTaskFailures.length > 0 || errors.length > 0,
      tasksSettled,
      renewalsSettled,
      contextsClosed: closedContexts.every(Boolean),
      ownershipCertain:
        this.createdWorlds.size === this.rawHolds.size && [...this.rawHolds.values()].every((hold) => !hold.lost),
    });
    let worldsDeleted = false,
      accountsDeleted = false;
    if (canDelete && this.rawHolds.size) {
      const primary = [...this.rawHolds.values()][0]!;
      try {
        // 자기 월드 두 개와 계정을 한 트랜잭션으로 삭제한다. 중간 실패는 모두 보존한다.
        await bounded(
          'atomic own data cleanup',
          primary.db.$transaction(
            async (tx) => {
              for (const hold of this.rawHolds.values()) await lockLease(tx, hold.lease);
              for (const id of this.createdWorlds) await tx.$queryRaw`SELECT id FROM "World" WHERE id=${id} FOR UPDATE`;
              for (const hold of this.rawHolds.values()) await assertLease(tx, hold.lease);
              await tx.world.deleteMany({ where: { id: { in: [...this.createdWorlds] } } });
              await tx.user.deleteMany({ where: { email: { in: this.users.map((u) => u.email) } } });
            },
            { timeout: 10000, maxWait: 3000 },
          ),
          15000,
        );
        worldsDeleted = true;
        accountsDeleted = true;
        this.createdWorlds.clear();
      } catch {
        errors.push('atomic cleanup failed; preserve rows');
      }
    }
    const leasesReleased: boolean[] = [];
    if (!worldsDeleted && tasksSettled)
      await Promise.all(
        [...this.rawHolds.values()].map(async (hold) => {
          try {
            await bounded('release owned lease', releaseLease(hold.db, hold.lease), 5000);
            leasesReleased.push(true);
          } catch {
            leasesReleased.push(false);
            errors.push('owned lease release uncertain');
          }
        }),
      );
    // 실패·시간초과여도 연결 정리는 데이터 보존과 별도로 시도한다.
    await Promise.all(
      [...this.clients].map(async (client) => {
        try {
          await bounded('DB disconnect', client.$disconnect(), 5000);
          this.clients.delete(client);
        } catch {
          errors.push('DB disconnect uncertain');
        }
      }),
    );
    const auditor = this.cleanupAuditDb();
    let worldRows: number | undefined,
      accountRows: number | undefined,
      auditDisconnected = false;
    try {
      await Promise.all([
        bounded(
          'owned world count',
          auditor.world.count({ where: { id: { in: this.worlds.map((w) => w.id).concat([...this.createdWorlds]) } } }),
          5000,
        ).then((value) => {
          worldRows = value;
        }),
        bounded(
          'owned account count',
          auditor.user.count({ where: { email: { in: this.users.map((u) => u.email) } } }),
          5000,
        ).then((value) => {
          accountRows = value;
        }),
      ]);
    } catch {
      errors.push('retained row count uncertain');
    } finally {
      try {
        await bounded('audit disconnect', auditor.$disconnect(), 5000);
        auditDisconnected = true;
      } catch {
        errors.push('audit disconnect uncertain');
      }
    }
    return {
      bodyPassed,
      failedBeforeCleanup,
      tasksSettled,
      renewalsSettled,
      contextsClosed: closedContexts.every(Boolean),
      taskSummary: this.scope.summary(this.describeFailure),
      taskFailures: this.scope.failures(this.describeFailure),
      taskFailureCount: this.scope.failures().length,
      preserveFailureRows: !canDelete || !worldsDeleted,
      worldIds: [...new Set(this.worlds.map((w) => w.id).concat([...this.createdWorlds]))],
      holds: [...this.rawHolds.entries()].map(([worldId, hold]) => ({
        worldId,
        fencingToken: hold.lease.fencingToken,
        leaseLost: !!hold.lost,
        renewalStopped: hold.done.signal.aborted,
      })),
      worldsDeleted,
      accountsDeleted,
      worldRows,
      accountRows,
      leasesReleased,
      allTrackedClientsDisconnected: this.clients.size === 0,
      auditDisconnected,
      errors,
    };
  }
}

export function assertCleanupPassed(cleanup: Awaited<ReturnType<OfferFixture['cleanup']>>, fixtureFailed = false) {
  if (
    fixtureFailed ||
    !cleanup.tasksSettled ||
    cleanup.taskFailureCount ||
    cleanup.errors.length ||
    !cleanup.allTrackedClientsDisconnected ||
    !cleanup.auditDisconnected
  )
    throw new Error('시험 실패 또는 불확실한 정리: controlled-cleanup-v3.json을 확인하세요.');
}

export const test = base.extend<{ offer: OfferFixture }>({
  offer: async ({ browser, offerRuntime }, use, info) => {
    const offer = new OfferFixture(undefined, offerRuntime);
    const timer = setTimeout(() => {
      offer.progressPending('timeout');
      offer.scope.cancel();
    }, info.timeout);
    let fixtureFailed = false;
    try {
      await offer.scope.cancellable(offer.scope.work('prepare', () => offer.prepare(browser)));
      await use(offer);
    } catch {
      fixtureFailed = true;
    } finally {
      offer.progressPending('finalize');
      clearTimeout(timer);
      offer.scope.cancel();
    }
    if (fixtureFailed || info.status !== 'passed') offerRuntime?.failed();
    try {
      offer.progress('cleanup');
      const cleanup = await offer.cleanup(!fixtureFailed && info.status === 'passed');
      await writeFile(
        info.outputPath('controlled-cleanup-v3.json'),
        JSON.stringify({ cleanup, journal: offer.journal }, null, 2),
      );
      console.log(
        '[campaign-offer-cleanup]',
        JSON.stringify({
          fixtureFailed,
          tasksSettled: cleanup.tasksSettled,
          pending: diagnosticPending(cleanup.taskSummary),
          renewalsSettled: cleanup.renewalsSettled,
          contextsClosed: cleanup.contextsClosed,
          allTrackedClientsDisconnected: cleanup.allTrackedClientsDisconnected,
          auditDisconnected: cleanup.auditDisconnected,
          errors: cleanup.errors.length,
          taskFailures: cleanup.taskFailureCount,
          preserveFailureRows: cleanup.preserveFailureRows,
          worldsDeleted: cleanup.worldsDeleted,
          accountsDeleted: cleanup.accountsDeleted,
        }),
      );
      assertCleanupPassed(cleanup, fixtureFailed);
    } catch (error) {
      offerRuntime?.failed();
      throw error;
    }
  },
});
export { expect, hashState, randomUUID };
