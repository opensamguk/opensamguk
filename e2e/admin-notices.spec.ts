import { randomBytes } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test as base, expect, apiMutate, type T210World } from './t210-fixture';
import { adminRole } from './adminSetup';
import { TEST_PASSWORD } from './account';
import { holdLease, type LeaseHold } from './game';
import { cleanupHeldWorld } from './heldWorldCleanup';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { hashState } from '../packages/shared/src/node/hashState';

const test = base.extend<Record<never, never>, { noticeEmailPolicy: void }>({
  noticeEmailPolicy: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const before = process.env.EMAIL_VERIFICATION_REQUIRED;
      process.env.EMAIL_VERIFICATION_REQUIRED = '1';
      try {
        await use();
      } finally {
        if (before === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
        else process.env.EMAIL_VERIFICATION_REQUIRED = before;
      }
    },
    { scope: 'worker', auto: true },
  ],
});
test.use({ actionTimeout: 10_000 });
const executions = new Set<Promise<unknown>>();
const observations = new Set<Promise<unknown>>();
function observe<T>(pending: Promise<T>) {
  observations.add(pending);
  executions.add(pending);
  void pending
    .finally(() => {
      observations.delete(pending);
      executions.delete(pending);
    })
    .catch(() => undefined);
  return pending;
}
function track<T>(work: () => Promise<T>) {
  const pending = Promise.resolve().then(work);
  executions.add(pending);
  void pending.finally(() => executions.delete(pending)).catch(() => undefined);
  return pending;
}
async function settled() {
  while (executions.size) await Promise.allSettled([...executions]);
}
test.beforeEach(settled);
test.afterEach(settled);
const calls = (request: Request, name: string) =>
  new URL(request.url()).pathname.split('/').at(-1)?.split(',').includes(name) ?? false;
async function fixture(world: T210World) {
  const admin = await world.user('ruler'),
    actor = await world.user('member');
  await adminRole(world, admin, 'grant');
  await world.hold.db.user.update({ where: { id: actor.userId }, data: { emailVerifiedAt: new Date() } });
  return { admin, actor, db: world.hold.db };
}
async function openNotices(page: Page) {
  await page.goto('/admin/notices');
  await expect(page.getByRole('heading', { name: '공지 관리', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '목록 조회', exact: true }).click();
  await expect(page.getByRole('button', { name: '공지 발행', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '목록 조회', exact: true })).toBeEnabled();
}
async function fillNotice(page: Page, title: string, body: string) {
  await page.getByLabel('제목', { exact: true }).fill(title);
  await page.getByRole('textbox', { name: '본문', exact: true }).fill(body);
}
async function frames(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test('T3-06 AC-M3-04 실제 정식 두 월드·로비 공지 발행 수정 숨김과 응답 유실의 같은 요청 재시도', ({ world }) =>
  track(async () => {
    test.setTimeout(180_000);
    const { admin, actor, db } = await fixture(world),
      page = admin.page,
      tag = randomBytes(5).toString('hex'),
      title = '공지-' + tag,
      body = '<img src=x onerror="window.noticeInjected=1">\n본문 ' + tag;
    const holds: LeaseHold[] = [],
      routes = new Set<Promise<unknown>>(),
      routeErrors: unknown[] = [],
      errors: unknown[] = [];
    let createdWorldId: string | null = null;
    try {
      const worlds: string[] = [];
      for (const suffix of ['a', 'b']) {
        const initial = await loadInitialWorld({
          scenario: 'integration191',
          map: 'integration',
          statRules: 'five-stats',
          portraitMap: '191-map',
          seed: 'notice-' + tag + suffix,
        });
        initial.ruleFeatures = [
          'campaign-assignment-v2',
          'campaign-v1',
          'five-stats',
          'operational-map',
          'personnel',
          'policy',
          'stratagem-basic',
          'treaty',
        ];
        expect(initial.nations).toHaveLength(21);
        expect(initial.generals).toHaveLength(491);
        const saved = await saveInitialWorld(db, initial, {
          name: '공지 정식191 ' + tag + suffix,
          turnTermMinutes: 60,
          endYear: 201,
        });
        createdWorldId = saved.worldId;
        const hold = await holdLease(saved.worldId);
        holds.push(hold);
        createdWorldId = null;
        await controlClock(hold.db, saved.worldId, 'start');
        await apiMutate(world, actor, 'general.create', {
          worldId: saved.worldId,
          name: '공지장수',
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        });
        await new TurnLoop(hold.db, hold.lease).advanceTo(0);
        expect(await db.general.count({ where: { worldId: saved.worldId } })).toBe(492);
        expect(await db.generalTurn.count({ where: { worldId: saved.worldId } })).toBe(492 * 30);
        worlds.push(saved.worldId);
      }
      const hashes = await Promise.all(worlds.map(async (id) => hashState(await readWorldState(db, id))));
      await openNotices(page);
      let lose = true,
        failGuard = false;
      const submissions: string[] = [];
      await page.route('**/trpc/**', (route) => {
        if (failGuard && calls(route.request(), 'admin.whoami')) return route.abort('failed');
        if (!calls(route.request(), 'admin.notice.create')) return route.continue();
        submissions.push(route.request().postData()!);
        const pending = (async () => {
          const response = await route.fetch();
          await response.body();
          if (lose) {
            expect(response.status()).toBe(200);
            lose = false;
            await route.abort('failed');
          } else await route.fulfill({ response });
        })();
        routes.add(pending);
        void pending.catch((error) => routeErrors.push(error));
        void pending.finally(() => routes.delete(pending)).catch(() => undefined);
        return pending;
      });
      await fillNotice(page, title, body);
      await page.getByRole('button', { name: '공지 발행', exact: true }).click();
      await expect(page.getByRole('button', { name: '같은 요청 다시 확인', exact: true })).toBeVisible();
      const stored = await db.notice.findFirstOrThrow({ where: { title } });
      expect(await db.notice.count({ where: { title } })).toBe(1);
      expect(await db.auditLog.count({ where: { targetId: stored.id, action: 'notice.create' } })).toBe(1);
      const checked = observe(
        page.waitForResponse((response) => calls(response.request(), 'admin.whoami'), { timeout: 10_000 }),
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await checked;
      await expect(page.getByLabel('제목', { exact: true })).toHaveValue(title);
      await expect(page.getByLabel('제목', { exact: true })).toBeDisabled();
      failGuard = true;
      const failedCheck = observe(
        page.waitForEvent('requestfailed', { predicate: (request) => calls(request, 'admin.whoami'), timeout: 10_000 }),
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await failedCheck;
      await expect(page.getByRole('alert')).toContainText('작성 내용은 이 탭에 보존했습니다.');
      failGuard = false;
      const recoveredCheck = observe(
        page.waitForResponse((response) => calls(response.request(), 'admin.whoami'), { timeout: 10_000 }),
      );
      await page.getByRole('button', { name: '다시 시도', exact: true }).click();
      await recoveredCheck;
      await expect(page.getByLabel('제목', { exact: true })).toHaveValue(title);
      await expect(page.getByRole('button', { name: '같은 요청 다시 확인', exact: true })).toBeVisible();
      await page.getByRole('link', { name: '감사 기록', exact: true }).click();
      expect(new URL(page.url()).pathname).toBe('/admin/notices');
      await expect(page.getByRole('button', { name: '같은 요청 다시 확인', exact: true })).toBeVisible();
      const ledger = await db.adminNoticeRequest.findFirstOrThrow({ where: { noticeId: stored.id } });
      const untilNextMinute = 60_000 - (Date.now() % 60_000);
      if (untilNextMinute < 5_000) await new Promise((resolve) => setTimeout(resolve, untilNextMinute + 100));
      let retryAfter = 0;
      // 같은 성공 요청만 실제로 반복해 한도를 채운다. 한도·서버 시각을 주입하지 않는다.
      for (let attempt = 0; attempt < 241; attempt++) {
        const repeated = await page.request.post(world.stack.webOrigin + '/trpc/admin.notice.create', {
          headers: { origin: world.stack.webOrigin },
          data: { scope: 'LOBBY', title, body, idempotencyKey: ledger.idempotencyKey },
        });
        await repeated.body();
        if (repeated.status() === 429) {
          retryAfter = Number(repeated.headers()['retry-after']);
          break;
        }
        expect(repeated.status()).toBe(200);
      }
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      await page.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('요청이 많습니다.');
      await expect(page.getByLabel('제목', { exact: true })).toBeDisabled();
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toBe(submissions[0]);
      const retryButton = page.getByRole('button', { name: '같은 요청 다시 확인', exact: true });
      await expect(page.getByText(/^다시 확인까지 \d+초$/)).toBeVisible();
      await expect(retryButton).toBeDisabled();
      await expect(retryButton).toBeEnabled({ timeout: 65_000 });
      await page.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).click();
      await expect(page.getByText('공지를 발행했습니다.', { exact: true })).toBeVisible();
      expect(submissions).toHaveLength(3);
      expect(submissions[2]).toBe(submissions[0]);
      expect(await db.notice.count({ where: { title } })).toBe(1);
      expect(await db.auditLog.count({ where: { targetId: stored.id, action: 'notice.create' } })).toBe(1);
      expect(await db.adminNoticeRequest.count({ where: { noticeId: stored.id } })).toBe(1);
      const row = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(row).toContainText(body);
      expect(await row.locator('img,script').count()).toBe(0);
      expect(await page.evaluate(() => 'noticeInjected' in window)).toBe(false);
      await actor.page.goto('/lobby');
      await expect(actor.page.getByText(body, { exact: true })).toBeVisible();
      await row.getByRole('button', { name: '수정·숨김 선택', exact: true }).click();
      await fillNotice(page, title + ' 수정', body + ' 수정');
      await page.getByRole('button', { name: '수정 저장', exact: true }).click();
      await expect(page.getByText('공지를 수정했습니다.', { exact: true })).toBeVisible();
      await actor.page.reload();
      await expect(actor.page.getByText(body + ' 수정', { exact: true })).toBeVisible();
      await page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: title + ' 수정', exact: true }) })
        .getByRole('button', { name: '수정·숨김 선택', exact: true })
        .click();
      await page.getByLabel('숨김 사유', { exact: true }).fill('시험 종료 ' + tag);
      await page.getByLabel('일반 화면에서 숨기고 이력을 보존합니다.', { exact: true }).check();
      await page.getByRole('button', { name: '공지 숨김', exact: true }).click();
      await expect(page.getByText('공지를 숨겼습니다.', { exact: true })).toBeVisible();
      const hiddenLobby = observe(
        actor.page.waitForResponse((response) => calls(response.request(), 'lobby.notices'), { timeout: 10_000 }),
      );
      await actor.page.reload();
      const hiddenRead = await hiddenLobby;
      expect(hiddenRead.status()).toBe(200);
      await hiddenRead.body();
      await frames(actor.page);
      await expect(actor.page.getByText(body + ' 수정', { exact: true })).toHaveCount(0);
      expect((await db.notice.findUniqueOrThrow({ where: { id: stored.id } })).revision).toBe(2);
      expect((await db.notice.findUniqueOrThrow({ where: { id: stored.id } })).hiddenAt).not.toBeNull();

      // 로비와 두 정식 월드의 공개 범위가 섞이지 않는다.
      await page.getByLabel('공지 범위').selectOption('WORLD');
      await page.getByLabel('월드 UUID', { exact: true }).fill(worlds[0]!);
      await page.getByRole('button', { name: '목록 조회', exact: true }).click();
      await fillNotice(page, '월드 ' + tag, '첫 월드만 ' + tag);
      await page.getByRole('button', { name: '공지 발행', exact: true }).click();
      await expect(page.getByText('공지를 발행했습니다.', { exact: true })).toBeVisible();
      await actor.page.goto('/w/' + worlds[0] + '/messages');
      await actor.page.getByRole('tab', { name: '전체', exact: true }).click();
      await expect(actor.page.getByRole('region', { name: '월드 공지' })).toContainText('첫 월드만 ' + tag);
      await actor.page.goto('/w/' + worlds[1] + '/messages');
      const secondWorldNotices = observe(
        actor.page.waitForResponse((response) => calls(response.request(), 'notice.world.list'), { timeout: 10_000 }),
      );
      await actor.page.getByRole('tab', { name: '전체', exact: true }).click();
      const secondRead = await secondWorldNotices;
      expect(secondRead.status()).toBe(200);
      expect(await secondRead.text()).not.toContain('첫 월드만 ' + tag);
      await frames(actor.page);
      await expect(actor.page.getByText('첫 월드만 ' + tag, { exact: true })).toHaveCount(0);
      const lobbyNotices = observe(
        actor.page.waitForResponse((response) => calls(response.request(), 'lobby.notices'), { timeout: 10_000 }),
      );
      await actor.page.goto('/lobby');
      const lobbyRead = await lobbyNotices;
      expect(lobbyRead.status()).toBe(200);
      expect(await lobbyRead.text()).not.toContain('첫 월드만 ' + tag);
      await frames(actor.page);
      await expect(actor.page.getByText('첫 월드만 ' + tag, { exact: true })).toHaveCount(0);
      for (const width of [375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await frames(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(
          await page
            .getByRole('button', { name: '공지 발행', exact: true })
            .evaluate((el) => el.getBoundingClientRect().height >= 44),
        ).toBe(true);
        await page.screenshot({ path: test.info().outputPath('notice-' + width + '.png'), fullPage: true });
      }
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      expect(await Promise.all(worlds.map(async (id) => hashState(await readWorldState(db, id))))).toEqual(hashes);
      await page.getByRole('link', { name: '감사 기록', exact: true }).click();
      await page.getByLabel('대상', { exact: true }).fill(stored.id);
      await page.getByRole('button', { name: '조회', exact: true }).click();
      const audit = page.getByRole('table', { name: '감사 조회 결과' });
      await expect(audit).toContainText('notice.create');
      await expect(audit).toContainText('notice.update');
      await expect(audit).toContainText('notice.hide');
      await expect(audit).not.toContainText(body);
    } catch (error) {
      errors.push(error);
    } finally {
      await Promise.allSettled([...routes]);
      if (routeErrors.length) errors.push(...routeErrors);
      try {
        await page.unrouteAll({ behavior: 'wait' });
      } catch (error) {
        errors.push(error);
      }
      try {
        await page.close();
        await actor.page.close();
      } catch (error) {
        errors.push(error);
      }
      await Promise.allSettled([...observations]);
      for (const hold of holds.reverse())
        try {
          await cleanupHeldWorld(hold, world.stack.databaseUrl);
        } catch (error) {
          errors.push(error);
        }
      if (createdWorldId) errors.push(new Error('실행권을 얻지 못한 자기 월드를 보존했습니다.'));
    }
    if (errors.length) throw new AggregateError(errors, '공지 화면 본문·실제 요청·자기 월드 정리 실패');
  }));

test('T3-06 AC-M3-04 공지50개 커서·키보드와 권한 회수 뒤 작성 내용 소거', ({ world }) =>
  track(async () => {
    const { admin, actor, db } = await fixture(world),
      page = admin.page,
      tag = randomBytes(5).toString('hex');
    await db.notice.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        scope: 'LOBBY' as const,
        worldId: null,
        title: tag + '-' + index,
        body: '목록 ' + tag,
        publishedAt: new Date('2020-01-01T00:00:00Z'),
      })),
    });
    const expected = await db.notice.findMany({
      where: { scope: 'LOBBY', worldId: null },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    await page.goto('/admin/notices');
    const requests: Request[] = [];
    page.on('request', (request) => {
      if (calls(request, 'admin.notice.list')) requests.push(request);
    });
    await frames(page);
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: '목록 조회', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-notice-id]')).toHaveCount(50);
    const ids = await page
      .locator('[data-notice-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-notice-id')));
    expect(ids).toEqual(expected.slice(0, 50).map((row) => row.id));
    await page.getByRole('button', { name: '다음50개', exact: true }).click();
    await expect(page.locator('[data-notice-id]')).toHaveCount(expected.length - 50);
    expect(
      await page
        .locator('[data-notice-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-notice-id'))),
    ).toEqual(expected.slice(50).map((row) => row.id));
    await fillNotice(page, '미전송 ' + tag, '개인 작성 ' + tag);
    await adminRole(world, admin, 'revoke');
    await page.getByRole('button', { name: '공지 발행', exact: true }).click();
    await expect(page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('개인 작성 ' + tag);
    expect(await db.notice.count({ where: { title: '미전송 ' + tag } })).toBe(0);
    await actor.page.goto('/admin/notices');
    await expect(actor.page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
    await admin.context.clearCookies();
    await page.goto('/admin/notices');
    await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/notices');
  }));

test('T3-06 AC-M3-04 신원 조회 응답 대기 중 계정 전환 뒤 이전 화면은 쓰기를 보내지 않는다', ({ world }) =>
  track(async () => {
    const { admin, actor, db } = await fixture(world),
      page = admin.page,
      tag = randomBytes(5).toString('hex'),
      title = '전송 중단 ' + tag;
    await adminRole(world, actor, 'grant');
    const { email } = await db.user.findUniqueOrThrow({ where: { id: actor.userId } });
    await openNotices(page);
    await fillNotice(page, title, '전환 전 내용 ' + tag);
    const other = await admin.context.newPage(),
      pending = new Set<Promise<unknown>>(),
      errors: unknown[] = [];
    let release = () => {},
      observed = () => {},
      rejectReady: (error: unknown) => void = () => {},
      first = true;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = observe(
      new Promise<void>((resolve, reject) => {
        observed = resolve;
        rejectReady = reject;
        timer = setTimeout(() => reject(new Error('신원 조회 응답을 관측하지 못했습니다.')), 10_000);
      }),
    );
    // 관측 실패도 finally의 정착까지 처리한 뒤 함께 보고한다.
    void ready.catch(() => undefined);
    let writes = 0;
    page.on('request', (request) => {
      if (calls(request, 'admin.notice.create')) writes++;
    });
    await page.route('**/trpc/**', (route) => {
      if (!first || !calls(route.request(), 'auth.me')) return route.continue();
      first = false;
      const task = (async () => {
        const response = await route.fetch();
        await response.body();
        expect(response.status()).toBe(200);
        observed();
        await gate;
        try {
          await route.fulfill({ response });
        } catch (error) {
          if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(route.request().failure()?.errorText ?? '')) throw error;
        }
      })();
      pending.add(task);
      void task.catch((error) => {
        errors.push(error);
        rejectReady(error);
      });
      void task.finally(() => pending.delete(task)).catch(() => undefined);
      return task;
    });
    try {
      await page.getByRole('button', { name: '공지 발행', exact: true }).click();
      await ready;
      clearTimeout(timer);
      const login = await other.request.post(world.stack.webOrigin + '/trpc/auth.login', {
        headers: { origin: world.stack.webOrigin },
        data: { email, password: TEST_PASSWORD },
      });
      await login.body();
      expect(login.status()).toBe(200);
      const checked = observe(
        page.waitForResponse((response) => calls(response.request(), 'admin.whoami'), { timeout: 10_000 }),
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await checked;
      await expect(page.getByText('공지 범위를 조회한 뒤 작성할 수 있습니다.', { exact: true })).toBeVisible();
      release();
      await Promise.allSettled([...pending]);
      await frames(page);
      expect(writes).toBe(0);
      expect(await db.notice.count({ where: { title } })).toBe(0);
      await expect(page.locator('body')).not.toContainText('전환 전 내용 ' + tag);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
      rejectReady(new Error('신원 조회 관측을 종료했습니다.'));
      release();
      await Promise.allSettled([...pending]);
      try {
        await page.unrouteAll({ behavior: 'wait' });
      } catch (error) {
        errors.push(error);
      }
      try {
        await other.close();
        await page.close();
      } catch (error) {
        errors.push(error);
      }
      await Promise.allSettled([...observations]);
    }
    if (errors.length) throw new AggregateError(errors, '지연 신원 조회와 계정 전환 검사 실패');
  }));
