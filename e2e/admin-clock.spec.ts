import { randomUUID } from 'node:crypto';
import type { Locator, Page, Request, Route } from '@playwright/test';
import { test, expect } from './legalFixture';
import { sanctionAccount, sanctionCalls } from './adminSanctionSetup';
import { clockWorld, executeClock, clockHuman, clockGameRows, clockControls } from './adminClockSetup';
import { controlClock } from '../apps/engine/src/world/clock';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { TEST_PASSWORD } from './account';
import { Prisma } from '../packages/db/src/generated/prisma/client';

const running = new Set<Promise<unknown>>(),
  jobs = new Set<Promise<void>>(),
  errors: unknown[] = [];
const releases: Array<() => Promise<unknown>> = [],
  unlocks: Array<() => void> = [];
function track(body: () => Promise<void>) {
  const work = Promise.resolve().then(body);
  running.add(work);
  void work.finally(() => running.delete(work)).catch(() => undefined);
  return work;
}
function routeWork(body: () => Promise<void>) {
  const work = body();
  jobs.add(work);
  void work.then(
    () => jobs.delete(work),
    (error) => {
      jobs.delete(work);
      errors.push(error);
    },
  );
  return work;
}
test.afterEach(async ({ page }) => {
  for (const unlock of unlocks.splice(0)) unlock();
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  while (running.size) await Promise.allSettled([...running]);
  while (jobs.size) await Promise.allSettled([...jobs]);
  for (const release of releases.splice(0).reverse())
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
  const failures = errors.splice(0);
  if (failures.length) throw new AggregateError(failures, '시계 화면 시험·자기 자원 정리 실패');
});
async function confirm(controls: Locator, reason = '시계 화면 실제 검사') {
  await controls.getByLabel('시계 조치 사유 (1~200자)', { exact: true }).fill(reason);
  await controls
    .getByRole('checkbox', { name: '대상·현재 상태·사유와 시계 조치를 확인했습니다.', exact: true })
    .check();
}
async function result(controls: Locator, text: string) {
  await controls.getByRole('button', { name: '요청 결과 조회', exact: true }).click();
  await expect(controls.getByRole('status').filter({ hasText: text })).toBeVisible();
}
async function responsive(page: Page, phase: string) {
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.locator('main button,main a,main input,main select,main textarea').evaluateAll((elements) =>
        elements
          .filter((element) => {
            const r = element.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
          })
          .map((element) => element.tagName),
      ),
    ).toEqual([]);
    if ([375, 1440].includes(width))
      await page.screenshot({ path: test.info().outputPath('clock-' + phase + '-' + width + '.png'), fullPage: true });
  }
}
const calls = (request: Request, path = 'admin.world.requestClock') => sanctionCalls(request, path);
async function actualRoute(page: Page, path: string, effect: (route: Route) => Promise<void>) {
  let once = true;
  await page.route('**/trpc/**', (route) => {
    if (!once || !calls(route.request(), path)) return route.continue();
    once = false;
    return routeWork(() => effect(route));
  });
}
async function waitSignal(signal: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('실제 시계 응답 관측 기한을 넘겼습니다.')), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function actor(page: Page, stack: Parameters<typeof clockWorld>[0]) {
  await stack.restart(null, true);
  return sanctionAccount(stack, page, true);
}

test('T3-06 AC-M3-04 정식 두 월드·사람30칸의 실제 시작/일시정지/재개·격리·네 폭', ({ page, legalStack: stack }) =>
  track(async () => {
    const admin = await actor(page, stack),
      other = await clockWorld(stack, releases),
      target = await clockWorld(stack, releases, false);
    await clockHuman(page, stack, other, admin.id);
    const otherBefore = await clockGameRows(stack, other.id, true);
    const controls = await clockControls(page, stack, target.id);
    await responsive(page, 'form');
    await page.setViewportSize({ width: 375, height: 900 });
    await controls.getByLabel('조치할 월드', { exact: true }).focus();
    await page.keyboard.press('Tab');
    const reason = controls.getByLabel('시계 조치 사유 (1~200자)', { exact: true });
    await expect(reason).toBeFocused();
    await reason.fill('정식191 첫 시작');
    await page.keyboard.press('Tab');
    await expect(controls.getByRole('checkbox')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(controls.getByRole('checkbox')).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(controls.getByRole('button', { name: '시작 요청 확정', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(controls.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
    expect((await stack.db.world.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('PREOPEN');
    await executeClock(target);
    await result(controls, '적용 완료 · 개장 전 → 진행 중');
    await expect(controls.getByText('적용 시각 (한국)', { exact: false })).toBeVisible();
    await clockHuman(page, stack, target, admin.id);
    const gameBefore = await clockGameRows(stack, target.id);
    for (const [action, before, after] of [
      ['일시정지', 'RUNNING', 'PAUSED'],
      ['재개', 'PAUSED', 'RUNNING'],
    ] as const) {
      await controls.getByRole('button', { name: '새 요청 작성', exact: true }).click();
      await page.getByRole('button', { name: '월드 조회', exact: true }).click();
      await controls.getByLabel('조치할 월드', { exact: true }).selectOption(target.id);
      await confirm(controls, '정식191 ' + action);
      await controls.getByRole('button', { name: action + ' 요청 확정', exact: true }).click();
      await expect(controls.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
      expect((await stack.db.world.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(before);
      await executeClock(target);
      await result(controls, '적용 완료');
      expect((await stack.db.world.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(after);
    }
    expect(await clockGameRows(stack, target.id)).toBe(gameBefore);
    expect(await clockGameRows(stack, other.id, true)).toBe(otherBefore);
    expect(
      await stack.db.inputEvent.count({
        where: { worldId: target.id, kind: { startsWith: 'admin.world.' }, status: 'APPLIED' },
      }),
    ).toBe(3);
    for (const world of [target, other]) {
      expect(await stack.db.nation.count({ where: { worldId: world.id } })).toBe(21);
      expect(await stack.db.general.count({ where: { worldId: world.id, userId: null } })).toBe(491);
      const human = await stack.db.general.findUniqueOrThrow({
        where: { worldId_userId: { worldId: world.id, userId: admin.id } },
      });
      expect(await stack.db.generalTurn.count({ where: { worldId: world.id, generalId: human.id } })).toBe(30);
    }
    await responsive(page, 'applied');
    await page.getByRole('link', { name: '감사 기록', exact: true }).click();
    await expect(page.getByRole('heading', { name: '감사 기록', exact: true })).toBeVisible();
  }));

test('T3-06 AC-M3-04 재조회로 시작이 일시정지로 바뀌면 확인을 해제하고 형식·종료·사유를 막는다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    await actor(page, stack);
    const world = await clockWorld(stack, releases, false),
      controls = await clockControls(page, stack, world.id);
    let writes = 0;
    page.on('request', (request) => {
      if (calls(request)) writes++;
    });
    await confirm(controls);
    await expect(controls.getByRole('button', { name: '시작 요청 확정', exact: true })).toBeEnabled();
    await controlClock(world.hold.db, world.id, 'start');
    await page.getByRole('button', { name: '월드 조회', exact: true }).click();
    await expect(controls.getByRole('checkbox')).not.toBeChecked();
    await expect(controls.getByRole('button', { name: '일시정지 요청 확정', exact: true })).toBeDisabled();
    await controls.getByLabel('조치할 월드', { exact: true }).selectOption(world.id);
    await confirm(controls, '   ');
    await expect(controls.getByRole('button', { name: '일시정지 요청 확정', exact: true })).toBeDisabled();
    const original = await stack.db.world.findUniqueOrThrow({ where: { id: world.id } });
    await stack.db.world.update({
      where: { id: world.id },
      data: {
        replayFormat: 2,
        campaignState: Prisma.DbNull,
        operationalMap: Prisma.DbNull,
        ruleFeatures: original.ruleFeatures.filter(
          (feature) => !['campaign-v1', 'operational-map', 'campaign-assignment-v2'].includes(feature),
        ),
      },
    });
    await page.getByRole('button', { name: '월드 조회', exact: true }).click();
    await controls.getByLabel('조치할 월드', { exact: true }).selectOption(world.id);
    await expect(controls).toContainText('이 월드의 재생 형식에서는');
    await expect(controls.getByRole('button', { name: '일시정지 요청 확정', exact: true })).toBeDisabled();
    // 조작 실행 증거가 아닌 목록 차단 자료다. 이 월드에서는 엔진을 실행하지 않는다.
    await stack.db.world.update({
      where: { id: world.id },
      data: {
        replayFormat: 3,
        campaignState: original.campaignState ?? Prisma.DbNull,
        operationalMap: original.operationalMap ?? Prisma.DbNull,
        ruleFeatures: original.ruleFeatures,
        status: 'ENDED',
      },
    });
    await page.getByRole('button', { name: '월드 조회', exact: true }).click();
    await controls.getByLabel('조치할 월드', { exact: true }).selectOption(world.id);
    await expect(controls).toContainText('종료한 월드에는');
    expect(writes).toBe(0);
  }));

test('T3-06 AC-M3-04 실제 접수 응답 유실은 같은 키 한 행으로 확인하고 조회는 변경을 보내지 않는다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    const admin = await actor(page, stack),
      world = await clockWorld(stack, releases),
      controls = await clockControls(page, stack, world.id),
      requests: unknown[] = [];
    page.on('request', (request) => {
      if (calls(request)) requests.push(request.postDataJSON());
    });
    await actualRoute(page, 'admin.world.requestClock', async (route) => {
      const actual = await route.fetch({ timeout: 10_000 });
      expect(actual.status()).toBe(200);
      await route.abort('failed');
    });
    await confirm(controls);
    await controls.getByRole('button', { name: '일시정지 요청 확정', exact: true }).click();
    await expect(controls.getByRole('alert')).toContainText('결과를 확인하지 못했습니다');
    await controls.getByRole('button', { name: '같은 요청 접수 확인', exact: true }).click();
    await expect(controls.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(
      await stack.db.inputEvent.count({ where: { worldId: world.id, userId: admin.id, kind: 'admin.world.pause' } }),
    ).toBe(1);
    expect(
      await stack.db.auditLog.count({
        where: { worldId: world.id, actorUserId: admin.id, action: 'world.pause.requested' },
      }),
    ).toBe(1);
    await executeClock(world);
    await result(controls, '적용 완료');
    expect(requests).toHaveLength(2);
  }));

for (const rejected of [false, true])
  test(`T3-06 AC-M3-04 ${rejected ? '접수 뒤 상태 변경의 REJECTED' : '명확한 미접수'} 후 메뉴 차단을 푼다`, ({
    page,
    legalStack: stack,
  }) =>
    track(async () => {
      const admin = await actor(page, stack),
        world = await clockWorld(stack, releases),
        controls = await clockControls(page, stack, world.id);
      await confirm(controls);
      if (!rejected)
        await actualRoute(page, 'admin.world.requestClock', async (route) => {
          await controlClock(world.hold.db, world.id, 'pause');
          const actual = await route.fetch({ timeout: 10_000 });
          expect(actual.status()).toBe(409);
          await route.fulfill({ response: actual });
        });
      await controls.getByRole('button', { name: '일시정지 요청 확정', exact: true }).click();
      if (rejected) {
        await expect(controls.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
        await controlClock(world.hold.db, world.id, 'pause');
        await executeClock(world);
        await result(controls, '적용하지 않음');
        expect(
          await stack.db.inputEvent.count({ where: { worldId: world.id, userId: admin.id, status: 'REJECTED' } }),
        ).toBe(1);
      } else {
        await expect(controls.getByRole('alert')).toContainText('접수하지 못했습니다');
        expect(await stack.db.inputEvent.count({ where: { worldId: world.id, userId: admin.id } })).toBe(0);
      }
      await page.getByRole('link', { name: '감사 기록', exact: true }).click();
      await expect(page.getByRole('heading', { name: '감사 기록', exact: true })).toBeVisible();
    }));

for (const change of ['account', 'role'] as const)
  test(`T3-06 AC-M3-04 실제 me 뒤 ${change} 전환은 시계 접수0·초안 소거`, ({ page, browser, legalStack: stack }) =>
    track(async () => {
      const admin = await actor(page, stack),
        world = await clockWorld(stack, releases),
        context = await browser.newContext();
      releases.push(() => context.close());
      const other = await sanctionAccount(stack, await context.newPage(), true),
        controls = await clockControls(page, stack, world.id);
      let writes = 0;
      page.on('request', (request) => {
        if (calls(request)) writes++;
      });
      await actualRoute(page, 'auth.me', async (route) => {
        const actual = await route.fetch({ timeout: 10_000 });
        expect(actual.status()).toBe(200);
        if (change === 'account')
          expect(
            (
              await page.request.post(stack.origin + '/trpc/auth.login', {
                headers: { Origin: stack.origin },
                data: { email: other.email, password: TEST_PASSWORD },
                timeout: 10_000,
              })
            ).status(),
          ).toBe(200);
        else await changeAdminRole(stack.db, { email: admin.email, role: 'USER', reason: '시계 조치 전 권한 회수' });
        await route.fulfill({ response: actual });
      });
      await confirm(controls, '이전 관리자 사유');
      await controls.getByRole('button', { name: '일시정지 요청 확정', exact: true }).click();
      if (change === 'role') await expect(page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
      else {
        await expect(page.getByLabel('조치할 월드', { exact: true })).toHaveValue('');
        await expect(page.getByLabel('시계 조치 사유 (1~200자)', { exact: true })).toHaveValue('');
      }
      while (jobs.size) await Promise.allSettled([...jobs]);
      expect(writes).toBe(0);
      expect(
        await stack.db.inputEvent.count({ where: { worldId: world.id, kind: { startsWith: 'admin.world.' } } }),
      ).toBe(0);
    }));

test('T3-06 AC-M3-04 접수 뒤 권한 회수는 DB 기각·결과 API403을 유지한다', ({ page, legalStack: stack }) =>
  track(async () => {
    const admin = await actor(page, stack),
      world = await clockWorld(stack, releases),
      controls = await clockControls(page, stack, world.id);
    await confirm(controls);
    await controls.getByRole('button', { name: '일시정지 요청 확정', exact: true }).click();
    await expect(controls.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
    const input = await stack.db.inputEvent.findFirstOrThrow({
      where: { worldId: world.id, userId: admin.id, kind: 'admin.world.pause' },
    });
    await changeAdminRole(stack.db, { email: admin.email, role: 'USER', reason: '접수 뒤 관리자 권한 회수' });
    await executeClock(world);
    expect((await stack.db.inputEvent.findUniqueOrThrow({ where: { id: input.id } })).status).toBe('REJECTED');
    const response = await page.request.get(
      stack.origin +
        '/trpc/admin.world.clockRequest?input=' +
        encodeURIComponent(
          JSON.stringify({ expectedUserId: admin.id, worldId: world.id, idempotencyKey: input.idempotencyKey }),
        ),
      { timeout: 10_000 },
    );
    expect(response.status()).toBe(403);
    await controls.getByRole('button', { name: '요청 결과 조회', exact: true }).click();
    await expect(page.getByRole('region', { name: '월드 시계 조치', exact: true })).toHaveCount(0);
  }));

test('T3-06 AC-M3-04 실제 늦은 결과 응답은 계정 전환 뒤 표시하지 않는다', ({ page, browser, legalStack: stack }) =>
  track(async () => {
    await actor(page, stack);
    const world = await clockWorld(stack, releases),
      controls = await clockControls(page, stack, world.id),
      context = await browser.newContext();
    releases.push(() => context.close());
    const other = await sanctionAccount(stack, await context.newPage(), true);
    await confirm(controls, '늦은 이전 사유');
    await controls.getByRole('button', { name: '일시정지 요청 확정', exact: true }).click();
    await expect(controls.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
    let release!: () => void, fetched!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      actualFetched = new Promise<void>((resolve) => {
        fetched = resolve;
      });
    unlocks.push(release);
    await actualRoute(page, 'admin.world.clockRequest', async (route) => {
      const actual = await route.fetch({ timeout: 10_000 });
      expect(actual.status()).toBe(200);
      fetched();
      await gate;
      await route.fulfill({ response: actual });
    });
    await controls.getByRole('button', { name: '요청 결과 조회', exact: true }).click();
    await waitSignal(actualFetched);
    expect(
      (
        await page.request.post(stack.origin + '/trpc/auth.login', {
          headers: { Origin: stack.origin },
          data: { email: other.email, password: TEST_PASSWORD },
          timeout: 10_000,
        })
      ).status(),
    ).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    release();
    while (jobs.size) await Promise.allSettled([...jobs]);
    await expect(controls).not.toContainText('늦은 이전 사유');
    await expect(controls).not.toContainText('접수됨 · 엔진 처리 대기');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const recheck = controls.getByRole('button', { name: '계정과 권한 다시 확인', exact: true });
    if (await recheck.isVisible()) await recheck.click();
    await expect(page.getByLabel('시계 조치 사유 (1~200자)', { exact: true })).toHaveValue('');
  }));

test('T3-06 AC-M3-04 실제429는 Retry-After 동안 재접수를 막고 새 입력을 만들지 않는다', ({ page, legalStack: stack }) =>
  track(async () => {
    const admin = await actor(page, stack),
      world = await clockWorld(stack, releases),
      controls = await clockControls(page, stack, world.id),
      input = {
        expectedUserId: admin.id,
        worldId: world.id,
        action: 'pause',
        reason: '자기 요청 한도 준비',
        idempotencyKey: randomUUID(),
      };
    const untilMinute = 60_000 - (Date.now() % 60_000);
    if (untilMinute < 10_000) await new Promise((resolve) => setTimeout(resolve, untilMinute + 100));
    for (let count = 0; count < 120; count++)
      expect(
        (
          await page.request.post(stack.origin + '/trpc/admin.world.requestClock', {
            headers: { Origin: stack.origin },
            data: input,
            timeout: 10_000,
          })
        ).status(),
      ).toBe(200);
    await confirm(controls);
    await controls.getByRole('button', { name: '일시정지 요청 확정', exact: true }).click();
    await expect(controls.getByRole('alert')).toContainText('요청이 많습니다');
    await expect(controls.getByRole('status').filter({ hasText: '초 뒤' })).toBeVisible();
    await expect(controls.getByRole('button', { name: '같은 요청 접수 확인', exact: true })).toBeDisabled();
    expect(
      await stack.db.inputEvent.count({ where: { worldId: world.id, userId: admin.id, kind: 'admin.world.pause' } }),
    ).toBe(1);
  }));
