import { createHash, randomUUID } from 'node:crypto';
import type { Page, Route, Locator } from '@playwright/test';
import { test, expect, type LegalStack } from './legalFixture';
import { sanctionAccount, sanctionCalls } from './adminSanctionSetup';
import { clockWorld } from './adminClockSetup';
import {
  endActor,
  endWorld,
  endClock,
  applyEnd,
  endControls,
  confirmEnd,
  endSubmit,
  endQuery,
  endFootprint,
  endWorldInvariant,
} from './adminEndSetup';
import { controlClock } from '../apps/engine/src/world/clock';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { TEST_PASSWORD } from './account';

const releases: Array<() => Promise<unknown>> = [],
  unlocks: Array<() => void> = [],
  bodies = new Set<Promise<unknown>>(),
  routes = new Set<Promise<unknown>>(),
  errors: unknown[] = [];
function track<T>(set: Set<Promise<unknown>>, run: () => Promise<T>) {
  const promise = Promise.resolve().then(run);
  set.add(promise);
  void promise.then(
    () => set.delete(promise),
    (error) => {
      errors.push(error);
      set.delete(promise);
    },
  );
  return promise;
}
test.afterEach(async ({ page, legalStack }) => {
  for (const unlock of unlocks.splice(0)) unlock();
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  while (bodies.size) await Promise.allSettled([...bodies]);
  while (routes.size) await Promise.allSettled([...routes]);
  for (const release of releases.splice(0).reverse())
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
  const failures = [...new Set(errors.splice(0))];
  if (failures.length) {
    legalStack.failed = true;
    throw new AggregateError(failures, '종료 화면 본문·응답·자원 정리 실패');
  }
});
const calls = (route: Route, path: string) => sanctionCalls(route.request(), path);
async function actualRoute(page: Page, path: string, effect: (route: Route) => Promise<void>) {
  let once = true;
  await page.route('**/trpc/**', (route) => {
    if (!once || !calls(route, path)) return route.continue();
    once = false;
    return track(routes, () => effect(route));
  });
}
function actualResponse(page: Page, path: string) {
  return track(routes, async () => {
    const response = await page.waitForResponse((item) => sanctionCalls(item.request(), path), { timeout: 15_000 });
    await response.body();
    return response;
  });
}
async function lateReply(route: Route, response: Awaited<ReturnType<Route['fetch']>>) {
  try {
    await route.fulfill({ response });
  } catch (error) {
    // 허용한 fault는 실제 브라우저가 abort했다고 관측한 요청에 한정한다.
    try {
      await expect.poll(() => route.request().failure()?.errorText ?? '', { timeout: 5_000 }).toContain('ERR_ABORTED');
    } catch (observation) {
      throw new AggregateError([error, observation], '늦은 응답 취소·정착 확인 실패', { cause: observation });
    }
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  unlocks.push(release);
  return { promise, release };
}
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('실제 응답 관측 기한 초과')), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function privateAbsent(page: Page, marker: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (value) =>
            (document.body.textContent ?? '').includes(value) ||
            [...document.querySelectorAll('input,textarea')].some((element) =>
              (element as HTMLInputElement | HTMLTextAreaElement).value.includes(value),
            ),
          marker,
        ),
      { timeout: 10_000 },
    )
    .toBe(false);
}
async function prepared(page: Page, stack: LegalStack) {
  const admin = await endActor(page, stack),
    other = await endWorld(page, stack, admin.id, releases),
    target = await endWorld(page, stack, admin.id, releases);
  const stored = await stack.db.world.findUniqueOrThrow({ where: { id: target.id } });
  return { admin, other, target, stored };
}
async function pending(dialog: Locator) {
  await endSubmit(dialog).click();
  await expect(dialog.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
}
async function ownInput(stack: LegalStack, worldId: string) {
  return stack.db.inputEvent.findFirstOrThrow({ where: { worldId, kind: 'admin.world.end' } });
}
async function responsive(page: Page, dialog: Locator, phase: string) {
  const rows = [];
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const measurement = await dialog.evaluate((node) => ({
      overflow: node.scrollWidth > node.clientWidth,
      dialogWidth: node.getBoundingClientRect().width,
    }));
    expect(measurement.overflow).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const small = await dialog.locator('button,input,textarea,select').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44);
        })
        .map((element) => element.tagName),
    );
    expect(small).toEqual([]);
    rows.push({ width, ...measurement });
    if ([375, 1440].includes(width))
      await page.screenshot({ path: test.info().outputPath('end-' + phase + '-' + width + '.png'), fullPage: true });
  }
  await test.info().attach('end-' + phase + '-widths', { body: JSON.stringify(rows), contentType: 'application/json' });
}

test('END01 AC-M3-04 정식 두 월드·사람30칸의 실제 종료·감사·격리·네 폭·키보드', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { admin, other, target, stored } = await prepared(page, stack),
      before = await endFootprint(stack, target.id),
      peer = await endFootprint(stack, other.id, true);
    const dialog = await endControls(page, stack, target.id);
    await expect(
      dialog.getByText('사람 장수가 있는 운영 월드의 종료에는 소유자 승인이 필요합니다.', { exact: true }),
    ).toBeVisible();
    await responsive(page, dialog, 'confirm');
    await dialog.getByLabel('현재 월드 이름 그대로 입력', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('종료 사유 (1~200자)', { exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByLabel('현재 월드 이름 그대로 입력', { exact: true })).toBeFocused();
    await confirmEnd(dialog, stored.name);
    await dialog.getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(endSubmit(dialog)).toBeDisabled();
    await page.keyboard.press('Space');
    await endSubmit(dialog).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('접수됨 · 엔진 처리 대기', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await applyEnd(target);
    await endQuery(dialog).click();
    await expect(dialog).toContainText('종료 적용 완료');
    await responsive(page, dialog, 'applied');
    const world = await stack.db.world.findUniqueOrThrow({ where: { id: target.id } });
    expect(world.status).toBe('ENDED');
    expect(world.endedAt).not.toBeNull();
    expect(world.clockTick).toBe(stored.clockTick);
    expect(world.clockRevision).toBe(stored.clockRevision + 1);
    expect(world.actionSequence).toBe(stored.actionSequence + 1);
    expect(endWorldInvariant(world)).toBe(endWorldInvariant(stored));
    expect(await stack.db.worldResult.count({ where: { worldId: target.id } })).toBe(0);
    expect(await endFootprint(stack, target.id)).toBe(before);
    expect(await endFootprint(stack, other.id, true)).toBe(peer);
    expect(
      await stack.db.inputEvent.count({ where: { worldId: target.id, userId: admin.id, kind: 'admin.world.end' } }),
    ).toBe(1);
    for (const action of ['world.end.requested', 'world.end.applied'])
      expect(await stack.db.auditLog.count({ where: { worldId: target.id, action } })).toBe(1);
    const summary = await page.request.get(
      stack.origin + '/trpc/world.summary?input=' + encodeURIComponent(JSON.stringify({ worldId: target.id })),
      { timeout: 10_000 },
    );
    expect(summary.status()).toBe(200);
    const publicData = (await summary.json()).result.data;
    expect(publicData.status).toBe('ENDED');
    expect(publicData.result).toBeNull();
    await dialog.getByRole('button', { name: '닫고 새로 조회', exact: true }).click();
    await expect(page.getByLabel('종료할 월드', { exact: true })).toBeFocused();
  }));

test('END02 AC-M3-04 정확 이름·사유·긴 이름과 지원 상태·구형식 거부', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { admin, target } = await prepared(page, stack),
      longName = ' 긴 이름 é '.repeat(40);
    // 이름은 운영 설정 변경 고정물이다. 게임 자원·시계·병력은 조작하지 않는다.
    await stack.db.world.update({ where: { id: target.id }, data: { name: longName } });
    let writes = 0;
    page.on('request', (request) => {
      if (sanctionCalls(request, 'admin.world.requestEnd')) writes++;
    });
    const dialog = await endControls(page, stack, target.id);
    for (const wrong of [longName.trim(), longName.toUpperCase(), longName.normalize('NFD')]) {
      await confirmEnd(dialog, wrong);
      await expect(endSubmit(dialog)).toBeDisabled();
    }
    await confirmEnd(dialog, longName, ' ');
    await expect(endSubmit(dialog)).toBeDisabled();
    await confirmEnd(dialog, longName, '사유\n중간');
    await expect(endSubmit(dialog)).toBeDisabled();
    await confirmEnd(dialog, longName, 'a'.repeat(200));
    await expect(endSubmit(dialog)).toBeEnabled();
    await responsive(page, dialog, 'long-name');
    expect(await dialog.getByLabel('현재 월드 이름 그대로 입력', { exact: true }).getAttribute('maxlength')).toBeNull();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    expect(writes).toBe(0);
    const preopen = await clockWorld(stack, releases, false),
      running = await clockWorld(stack, releases, false);
    await endClock(page, stack, running, admin.id, 'start');
    const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'end-ui-legacy' });
    const legacy = await saveInitialWorld(stack.db, initial, {
      name: '구형식 종료 화면',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 'legacy',
    });
    await controlClock(stack.db, legacy.worldId, 'start');
    await controlClock(stack.db, legacy.worldId, 'pause');
    for (const id of [preopen.id, running.id, legacy.worldId]) {
      await page.getByRole('button', { name: '월드 조회', exact: true }).click();
      await page.getByLabel('종료할 월드', { exact: true }).selectOption(id);
      await expect(page.getByRole('button', { name: '월드 종료 확인', exact: true })).toBeDisabled();
    }
    expect(writes).toBe(0);
    await page.getByLabel('종료할 월드', { exact: true }).selectOption(target.id);
    await page.getByRole('button', { name: '월드 종료 확인', exact: true }).click();
    await confirmEnd(dialog, longName);
    await pending(dialog);
    await applyEnd(target);
    await endQuery(dialog).click();
    await expect(dialog).toContainText('종료 적용 완료');
    await dialog.getByRole('button', { name: '닫고 새로 조회', exact: true }).click();
    await page.getByRole('button', { name: '월드 조회', exact: true }).click();
    await page.getByLabel('종료할 월드', { exact: true }).selectOption(target.id);
    await expect(page.getByRole('button', { name: '월드 종료 확인', exact: true })).toBeDisabled();
  }));

test('END03 AC-M3-04 신선 조회 변경은 확인을 풀고 실제 전송 경쟁은 CONFLICT·게임 불변', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { target, stored } = await prepared(page, stack);
    const dialog = await endControls(page, stack, target.id);
    await confirmEnd(dialog, stored.name);
    await stack.db.world.update({ where: { id: target.id }, data: { name: stored.name + '새 이름' } });
    await endSubmit(dialog).click();
    await expect(dialog.getByRole('alert')).toContainText('상태가 달라졌습니다');
    await expect(dialog.getByLabel('현재 월드 이름 그대로 입력', { exact: true })).toHaveValue('');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(0);
    await confirmEnd(dialog, stored.name + '새 이름');
    await controlClock(target.hold.db, target.id, 'resume');
    await controlClock(target.hold.db, target.id, 'pause');
    await endSubmit(dialog).click();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByLabel('현재 월드 이름 그대로 입력', { exact: true })).toHaveValue('');
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(0);
    await confirmEnd(dialog, stored.name + '새 이름');
    const before = await endFootprint(stack, target.id);
    await actualRoute(page, 'admin.world.requestEnd', async (route) => {
      await controlClock(target.hold.db, target.id, 'resume');
      const response = await route.fetch({ timeout: 10_000 });
      expect(response.status()).toBe(409);
      await response.body();
      await route.fulfill({ response });
    });
    await endSubmit(dialog).click();
    await expect(dialog.getByRole('alert')).toContainText('접수하지 못했습니다');
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(0);
    expect(await endFootprint(stack, target.id)).toBe(before);
  }));

test('END04 AC-M3-04 실제 접수 응답 유실·실제404 뒤 POST0과 같은 UUID 수동 조회', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { target, other, stored } = await prepared(page, stack);
    // 전송 전에 끊긴 별도 실제 요청은 같은 원래 UUID 조회에서404다. 본문·상태를 만들지 않는다.
    const absentPage = await page.context().newPage();
    releases.push(() => absentPage.close());
    const absentName = (await stack.db.world.findUniqueOrThrow({ where: { id: other.id } })).name,
      absent = await endControls(absentPage, stack, other.id);
    let absentWrites = 0;
    absentPage.on('request', (request) => {
      if (sanctionCalls(request, 'admin.world.requestEnd')) absentWrites++;
    });
    await actualRoute(absentPage, 'admin.world.requestEnd', (route) => route.abort('failed'));
    await confirmEnd(absent, absentName);
    await endSubmit(absent).click();
    await expect(absent).toContainText('접수 여부 미확정');
    const missing = actualResponse(absentPage, 'admin.world.endRequest');
    await endQuery(absent).click();
    expect((await missing).status()).toBe(404);
    await expect(absent.getByRole('alert')).toContainText('미접수를 뜻하지 않습니다');
    await expect(absent.getByRole('button', { name: '같은 종료 요청 수동 접수', exact: true })).toHaveCount(0);
    expect(absentWrites).toBe(1);
    expect(await stack.db.inputEvent.count({ where: { worldId: other.id, kind: 'admin.world.end' } })).toBe(0);
    await absentPage.close();
    const dialog = await endControls(page, stack, target.id);
    let writes = 0;
    page.on('request', (request) => {
      if (sanctionCalls(request, 'admin.world.requestEnd')) writes++;
    });
    await actualRoute(page, 'admin.world.requestEnd', async (route) => {
      const response = await route.fetch({ timeout: 10_000 });
      expect(response.status()).toBe(200);
      await response.body();
      await route.abort('failed');
    });
    await confirmEnd(dialog, stored.name);
    await endSubmit(dialog).click();
    await expect(dialog).toContainText('접수 여부 미확정');
    expect(writes).toBe(1);
    await expect(dialog.getByRole('button', { name: '같은 종료 요청 수동 접수', exact: true })).toHaveCount(0);
    await endQuery(dialog).click();
    await expect(dialog).toContainText('접수됨 · 엔진 처리 대기');
    await applyEnd(target);
    await endQuery(dialog).click();
    await expect(dialog).toContainText('종료 적용 완료');
    expect(writes).toBe(1);
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(1);
    expect(await stack.db.auditLog.count({ where: { worldId: target.id, action: 'world.end.requested' } })).toBe(1);
  }));

test('END05 AC-M3-04 실제200 응답 보류·30초 기한·늦은 응답 뒤 미확정 수동 복구', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { target, stored } = await prepared(page, stack),
      dialog = await endControls(page, stack, target.id),
      held = gate(),
      fetched = gate();
    let writes = 0;
    page.on('request', (request) => {
      if (sanctionCalls(request, 'admin.world.requestEnd')) writes++;
    });
    await actualRoute(page, 'admin.world.requestEnd', async (route) => {
      const response = await route.fetch({ timeout: 10_000 });
      expect(response.status()).toBe(200);
      await response.body();
      fetched.release();
      await held.promise;
      await lateReply(route, response);
    });
    await confirmEnd(dialog, stored.name);
    const start = Date.now();
    await endSubmit(dialog).click();
    await bounded(fetched.promise);
    await expect(dialog.getByRole('alert')).toContainText('기한을 넘겼습니다', { timeout: 35_000 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(29_000);
    await expect(endQuery(dialog)).toBeEnabled();
    held.release();
    while (routes.size) await Promise.allSettled([...routes]);
    await expect(dialog).toContainText('접수 여부 미확정');
    expect(writes).toBe(1);
    await applyEnd(target);
    await endQuery(dialog).click();
    await expect(dialog).toContainText('종료 적용 완료');
  }));

test('END06 AC-M3-04 마지막 me 뒤 실제 B 쿠키 교체는 기대 A 요청401·입력0', ({ page, browser, legalStack: stack }) =>
  track(bodies, async () => {
    const { admin, target, stored } = await prepared(page, stack),
      context = await browser.newContext();
    releases.push(() => context.close());
    const other = await sanctionAccount(stack, await context.newPage(), true),
      dialog = await endControls(page, stack, target.id);
    let checks = 0;
    await page.route('**/trpc/**', (route) =>
      track(routes, async () => {
        if (!calls(route, 'auth.me') || ++checks !== 4) {
          await route.continue();
          return;
        }
        const response = await route.fetch({ timeout: 10_000 });
        expect(response.status()).toBe(200);
        await response.body();
        expect(
          (
            await page.request.post(stack.origin + '/trpc/auth.login', {
              headers: { Origin: stack.origin },
              data: { email: other.email, password: TEST_PASSWORD },
              timeout: 10_000,
            })
          ).status(),
        ).toBe(200);
        await route.fulfill({ response });
      }),
    );
    await confirmEnd(dialog, stored.name, '마지막 신원 이전 사유');
    const response = actualResponse(page, 'admin.world.requestEnd');
    await endSubmit(dialog).click();
    expect((await response).status()).toBe(401);
    await privateAbsent(page, '마지막 신원 이전 사유');
    expect(checks).toBeGreaterThanOrEqual(4);
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(0);
    expect(await stack.db.auditLog.count({ where: { worldId: target.id, action: 'world.end.requested' } })).toBe(0);
    expect(
      (
        await page.request.post(stack.origin + '/trpc/auth.login', {
          headers: { Origin: stack.origin },
          data: { email: admin.email, password: TEST_PASSWORD },
          timeout: 10_000,
        })
      ).status(),
    ).toBe(200);
    const aba = await endControls(page, stack, target.id);
    await actualRoute(page, 'admin.world.list', async (route) => {
      expect(calls(route, 'auth.me')).toBe(true);
      expect(calls(route, 'admin.whoami')).toBe(true);
      expect(
        (
          await page.request.post(stack.origin + '/trpc/auth.login', {
            headers: { Origin: stack.origin },
            data: { email: other.email, password: TEST_PASSWORD },
            timeout: 10_000,
          })
        ).status(),
      ).toBe(200);
      const cookie = (await page.context().cookies(stack.origin))
        .map((item) => item.name + '=' + item.value)
        .join('; ');
      // 실제 같은 batch 전체를 B로 처리한 뒤 A로 돌아온다. me/body는 합성하지 않는다.
      const actual = await route.fetch({ headers: { ...route.request().headers(), cookie }, timeout: 10_000 });
      expect(actual.status()).toBe(200);
      await actual.body();
      expect(
        (
          await page.request.post(stack.origin + '/trpc/auth.login', {
            headers: { Origin: stack.origin },
            data: { email: admin.email, password: TEST_PASSWORD },
            timeout: 10_000,
          })
        ).status(),
      ).toBe(200);
      await route.fulfill({ response: actual });
    });
    await confirmEnd(aba, stored.name, 'ABA 이전 종료 사유');
    await endSubmit(aba).click();
    await privateAbsent(page, 'ABA 이전 종료 사유');
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(0);
  }));

test('END07 AC-M3-04 접수 뒤 실제 역할 회수는 엔진 기각·현재 조회403·DOM 소거', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { admin, target, stored } = await prepared(page, stack),
      dialog = await endControls(page, stack, target.id);
    await confirmEnd(dialog, stored.name);
    await changeAdminRole(stack.db, { email: admin.email, role: 'USER', reason: '종료 접수 전 실제 권한 회수 시험' });
    await endSubmit(dialog).click();
    await expect(page.getByRole('region', { name: '월드 종료 조치', exact: true })).toHaveCount(0);
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(0);
    await changeAdminRole(stack.db, { email: admin.email, role: 'ADMIN', reason: '종료 적용 전 권한 회수 시험 준비' });
    await endControls(page, stack, target.id);
    await confirmEnd(dialog, stored.name);
    await pending(dialog);
    const input = await ownInput(stack, target.id);
    await changeAdminRole(stack.db, { email: admin.email, role: 'USER', reason: '종료 접수 후 실제 권한 회수 시험' });
    await applyEnd(target);
    expect((await stack.db.inputEvent.findUniqueOrThrow({ where: { id: input.id } })).status).toBe('REJECTED');
    const response = actualResponse(page, 'admin.world.endRequest');
    await endQuery(dialog).click();
    expect((await response).status()).toBe(403);
    await expect(page.getByRole('region', { name: '월드 종료 조치', exact: true })).toHaveCount(0);
    expect((await stack.db.world.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('PAUSED');
  }));

test('END08 AC-M3-04 실제 상태 경쟁 REJECTED와 로그아웃 뒤 요청 적용·재로그인 조회', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { admin, target, other, stored } = await prepared(page, stack),
      dialog = await endControls(page, stack, target.id);
    await confirmEnd(dialog, stored.name);
    await pending(dialog);
    await controlClock(target.hold.db, target.id, 'resume');
    await applyEnd(target);
    await endQuery(dialog).click();
    await expect(dialog).toContainText('월드 상태가 바뀌어 종료하지 않았습니다');
    await dialog.getByRole('button', { name: '닫고 새로 조회', exact: true }).click();
    const second = await endControls(page, stack, other.id),
      name = (await stack.db.world.findUniqueOrThrow({ where: { id: other.id } })).name;
    await confirmEnd(second, name);
    await pending(second);
    expect(
      (
        await page.request.post(stack.origin + '/trpc/auth.logout', {
          headers: { Origin: stack.origin },
          timeout: 10_000,
        })
      ).status(),
    ).toBe(200);
    await applyEnd(other);
    expect(
      (
        await page.request.post(stack.origin + '/trpc/auth.login', {
          headers: { Origin: stack.origin },
          data: { email: admin.email, password: TEST_PASSWORD },
          timeout: 10_000,
        })
      ).status(),
    ).toBe(200);
    await endQuery(second).click();
    await expect(second).toContainText('종료 적용 완료');
  }));

test('END09 AC-M3-04 실제429·Retry-After 뒤 같은 UUID·본문의 수동 접수만 허용', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { admin, target, other, stored } = await prepared(page, stack),
      dialog = await endControls(page, stack, target.id),
      input = {
        expectedUserId: admin.id,
        worldId: other.id,
        action: 'resume',
        reason: '실제 요청 한도 준비',
        idempotencyKey: randomUUID(),
      };
    const untilMinute = 60_000 - (Date.now() % 60_000);
    if (untilMinute < 10_000) await new Promise((resolve) => setTimeout(resolve, untilMinute + 100));
    let limited = false;
    for (let index = 0; index < 121; index++) {
      const response = await page.request.post(stack.origin + '/trpc/admin.world.requestClock', {
        headers: { Origin: stack.origin },
        data: input,
        timeout: 10_000,
      });
      await response.body();
      if (response.status() === 429) {
        limited = true;
        break;
      }
      expect(response.status()).toBe(200);
    }
    expect(limited).toBe(true);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (sanctionCalls(request, 'admin.world.requestEnd'))
        requests.push(
          createHash('sha256')
            .update(request.postData() ?? '')
            .digest('hex'),
        );
    });
    await confirmEnd(dialog, stored.name);
    const actual = actualResponse(page, 'admin.world.requestEnd');
    await endSubmit(dialog).click();
    const response = await actual;
    expect(response.status()).toBe(429);
    const seconds = Number(response.headers()['retry-after']);
    expect(seconds > 0 && seconds <= 60).toBe(true);
    const retry = dialog.getByRole('button', { name: '같은 종료 요청 수동 접수', exact: true });
    await expect(retry).toBeDisabled();
    expect(requests).toHaveLength(1);
    await expect(retry).toBeEnabled({ timeout: 65_000 });
    expect(requests).toHaveLength(1);
    await retry.click();
    await expect(dialog).toContainText('접수됨 · 엔진 처리 대기');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(await stack.db.inputEvent.count({ where: { worldId: target.id, kind: 'admin.world.end' } })).toBe(1);
  }));

test('END10 AC-M3-04 guard·늦은 응답·UUID 보존·상호잠금·history·beforeUnload', ({ page, legalStack: stack }) =>
  track(bodies, async () => {
    const { target, stored } = await prepared(page, stack),
      dialog = await endControls(page, stack, target.id);
    // 실제 SPA history의 이전 항목을 마련한다. 종료 후에는 이 이동도 다시 허용돼야 한다.
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await page.getByRole('link', { name: '감사 기록', exact: true }).click();
    await page.getByRole('link', { name: '월드 목록', exact: true }).click();
    await page.getByRole('button', { name: '월드 조회', exact: true }).click();
    await page.getByLabel('종료할 월드', { exact: true }).selectOption(target.id);
    await page.getByRole('button', { name: '월드 종료 확인', exact: true }).click();
    expect(
      await page
        .getByRole('region', { name: '월드 시계 조치', exact: true, includeHidden: true })
        .evaluate((node) => node.closest('[inert]') !== null),
    ).toBe(true);
    await confirmEnd(dialog, stored.name, '창 전환 전 종료 사유');
    await pending(dialog);
    await page.evaluate(() => history.back());
    await expect(dialog.getByRole('alert')).toContainText('종료 요청 결과를 먼저 확인하세요');
    expect(new URL(page.url()).pathname).toBe('/admin/worlds');
    const input = await ownInput(stack, target.id),
      held = gate(),
      fetched = gate();
    await actualRoute(page, 'admin.world.endRequest', async (route) => {
      const response = await route.fetch({ timeout: 10_000 });
      expect(response.status()).toBe(200);
      await response.body();
      fetched.release();
      await held.promise;
      await lateReply(route, response);
    });
    await endQuery(dialog).click();
    await bounded(fetched.promise);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    held.release();
    while (routes.size) await Promise.allSettled([...routes]);
    expect(
      await page
        .locator('body')
        .textContent()
        .then((value) => value?.includes('창 전환 전 종료 사유')),
    ).toBe(false);
    await page.getByRole('button', { name: '종료 계정과 권한 다시 확인', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(input.idempotencyKey);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    let warned = false;
    page.once('dialog', (prompt) => {
      void track(routes, async () => {
        warned = prompt.type() === 'beforeunload';
        await prompt.dismiss();
      });
    });
    try {
      await page.reload({ timeout: 5_000 });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error;
    }
    expect(warned).toBe(true);
    if (!(await dialog.isVisible()))
      await page.getByRole('button', { name: '종료 계정과 권한 다시 확인', exact: true }).click();
    await expect(dialog).toBeVisible();
    await applyEnd(target);
    await endQuery(dialog).click();
    await expect(dialog).toContainText('종료 적용 완료');
    await dialog.getByRole('button', { name: '닫고 새로 조회', exact: true }).click();
    await page.getByRole('link', { name: '감사 기록', exact: true }).click();
    await expect(page.getByRole('heading', { name: '감사 기록', exact: true })).toBeVisible();
  }));
