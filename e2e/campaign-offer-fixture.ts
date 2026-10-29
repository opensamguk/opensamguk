import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test as base, expect, type Browser, type Cookie, type Page, type Route, type Request } from '@playwright/test';
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
import { query as rawQuery, mutate as rawMutate, type LeaseHold } from './game';

const pageScopes = new WeakMap<Page, WorkScope>();
let passwordHash: Promise<string> | undefined;
export function query<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const scope = pageScopes.get(page);
  if (!scope) throw new Error('등록된 시험 페이지만 요청할 수 있습니다.');
  return scope.work('HTTP query', () => rawQuery<T>(page, path, input));
}
export function mutate<T = Record<string, unknown>>(page: Page, path: string, input: unknown): Promise<T> {
  const scope = pageScopes.get(page);
  if (!scope) throw new Error('등록된 시험 페이지만 접수할 수 있습니다.');
  return scope.work('HTTP mutation', () => rawMutate<T>(page, path, input));
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

export class OfferFixture {
  constructor(private readonly cleanupAuditDb: () => PrismaClient = () => createDb(e2eDatabaseUrl())) {}
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
  private offerClickStartedAt = 0;
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
    if (process.env.CAMPAIGN_OFFER_PUBLIC_DIST !== '1') throw new Error('공개 dist 전용 실행기가 필요합니다.');
    const meta = await (await fetch(`${appOrigin()}/public-build.json`, { signal: this.scope.signal })).json();
    expect(meta.mode).toBe('public');
    for (let i = 0; i < 2; i++) {
      this.scope.check();
      const context = await this.scope.work(
        'new context',
        () => browser.newContext({ baseURL: appOrigin(), viewport: { width: 1440, height: 900 } }),
        (value) => this.contexts.add(value),
      );
      const page = guardedUi(await this.scope.work('new page', () => context.newPage()), this.scope);
      pageScopes.set(page, this.scope);
      // 생성 도중 실패해도 자기 context와 계정의 수명을 추적한다.
      const user: User = { page, id: '', email: `e2e-offer-${randomUUID()}@example.test`, cookies: [] };
      this.users.push(user);
      const hash = await this.scope.work('password hash', () => (passwordHash ??= hashPassword(TEST_PASSWORD)));
      this.scope.check();
      const session = newSession(Date.now());
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
      await this.scope.work('session cookie', () =>
        context.addCookies([{ name: 'sid', value: session.token, url: appOrigin(), httpOnly: true, sameSite: 'Lax' }]),
      );
      user.cookies = await context.cookies(appOrigin());
      user.id = (await query<{ user: { id: string } }>(page, 'auth.me')).user.id;
    }
    for (let i = 0; i < 2; i++) {
      // 결과를 골라내지 않는 고정 시드. 두 월드는 사람 UUID·입력·일정을 공유한다.
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
      const hold = await this.hold(worldId);
      const world = { id: worldId, hold, tick: 0 };
      this.worlds.push(world);
      await controlClock(hold.db, worldId, 'start');
      for (const [index, user] of this.users.entries()) {
        await user.page.goto(`/w/${worldId}/create`);
        await expect(user.page.getByRole('spinbutton')).toHaveCount(5);
        await user.page.getByLabel('이름', { exact: true }).fill(`제안장수${index}`);
        await user.page.getByRole('button', { name: '고르게 나누기' }).click();
        await user.page.getByRole('button', { name: '장수 만들기', exact: true }).click();
        await expect
          .poll(() => hold.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
          .toBe(1);
        await this.advance(world, 0);
        await expect(user.page).toHaveURL(`${appOrigin()}/w/${worldId}`);
      }
      const humans = await hold.db.general.findMany({
        where: { worldId, userId: { in: this.users.map((u) => u.id) } },
        orderBy: { id: 'asc' },
      });
      expect(humans.map((g) => g.id)).toEqual([492, 493]);
      for (const user of this.users)
        await mutate(user.page, 'turns.set', {
          worldId,
          revision: 0,
          slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
        });
      await this.advance(world, Math.max(...humans.map((g) => g.nextTurnTick)));
      for (const user of this.users) await user.page.goto(`/w/${worldId}`);
      const board = await this.board(world);
      expect(board.resources.gold).toBeGreaterThanOrEqual(500);
      expect(board.cityKey).toBe((await this.board(world, 1)).cityKey);
      expect(await hold.db.generalTurn.count({ where: { worldId, generalId: 493 } })).toBe(30);
      // 사람 휘하는 본인의 실제 응답 후에만 성립한다. 이후 해제해 NPC 시험의 초기 상태를 맞춘다.
      const humanBefore = await this.snapshot(world);
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
      await mutate(this.users[1]!.page, 'campaign.relationship', {
        worldId,
        requestId: randomUUID(),
        payload: { type: 'respond', offerId: humanOffer!.id, accept: true, revision: offered.revision },
      });
      await this.advance(world, world.tick);
      const accepted = await this.board(world, 1);
      expect(accepted.links).toContainEqual({ masterId: 492, personId: 493, relation: 'STAFF' });
      await mutate(this.users[1]!.page, 'campaign.relationship', {
        worldId,
        requestId: randomUUID(),
        payload: { type: 'release', personId: 493, revision: accepted.revision },
      });
      await this.advance(world, world.tick);
      expect((await this.board(world)).links).toHaveLength(0);
      const humanAfter = await this.snapshot(world);
      for (const id of [492, 493])
        expect(humanAfter.state.generals[id]!.gold).toBe(humanBefore.state.generals[id]!.gold);
      expect(humanAfter.turns).toEqual(humanBefore.turns);
      expect(humanAfter.revisions).toEqual(humanBefore.revisions);
      this.journal.push({ humanConsent: worldId, requestId: offerId, cost: 0 });
    }
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
    await page.goto(`/w/${this.worlds[0]!.id}`);
    const response = await loaded;
    const call = calls(response.request()).find((call) => call.path === 'campaign.get')!;
    const body = await response.json();
    this.deliveredBoard = (Array.isArray(body) ? body[call.index] : body).result.data as Board;
    await expect(this.panel()).toBeVisible();
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
    await this.scope.work('engine advance', () =>
      new TurnLoop(world.hold.db, world.hold.lease).advanceTo(tick, this.scope.signal),
    );
    world.tick = tick;
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
      await this.advance(control, tick);
      await this.advance(main, tick);
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
    await button.evaluate((element) =>
      element.addEventListener(
        'click',
        () => {
          document.documentElement.dataset.offerClick = String(Date.now());
        },
        { once: true, capture: true },
      ),
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
          const clickedAt = Number(await page.evaluate(() => document.documentElement.dataset.offerClick ?? 0));
          if (!clickedAt || route.request().timing().startTime < clickedAt) return route.fallback();
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
        this.offerClickStartedAt = Date.now();
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
              this.offerClickStartedAt > 0 &&
              route.request().timing().startTime < this.offerClickStartedAt &&
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
    const bCookie = this.users[1]!.page.context().cookies(appOrigin());
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
  offer: async ({ browser }, use, info) => {
    const offer = new OfferFixture();
    const timer = setTimeout(() => offer.scope.cancel(), info.timeout);
    let fixtureFailed = false;
    try {
      await offer.scope.cancellable(offer.scope.work('prepare', () => offer.prepare(browser)));
      await use(offer);
    } catch {
      fixtureFailed = true;
    } finally {
      clearTimeout(timer);
      offer.scope.cancel();
    }
    const cleanup = await offer.cleanup(!fixtureFailed && info.status === 'passed');
    await writeFile(
      info.outputPath('controlled-cleanup-v3.json'),
      JSON.stringify({ cleanup, journal: offer.journal }, null, 2),
    );
    assertCleanupPassed(cleanup, fixtureFailed);
  },
});
export { expect, hashState, randomUUID };
