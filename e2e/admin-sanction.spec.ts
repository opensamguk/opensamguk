import type { Locator, Page } from '@playwright/test';
import { test, expect } from './legalFixture';
import { TEST_PASSWORD } from './account';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { newSession } from '../apps/server/src/auth/session';
import { sanctionAccount, sanctionCalls, readSanctionTarget, formalSanctionWorlds } from './adminSanctionSetup';

const running = new Set<Promise<unknown>>();
const observations = new Set<Promise<unknown>>();
function observe<T>(pending: Promise<T>) {
  observations.add(pending);
  void pending.catch(() => undefined);
  return pending;
}
function track<T>(body: () => Promise<T>) {
  const work = Promise.resolve().then(body);
  running.add(work);
  void work.finally(() => running.delete(work)).catch(() => undefined);
  return work;
}
test.afterEach(async ({ page }) => {
  const errors: unknown[] = [];
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  while (running.size) await Promise.allSettled([...running]);
  for (const result of await Promise.allSettled([...observations]))
    if (result.status === 'rejected') errors.push(result.reason);
  observations.clear();
  if (errors.length) throw new AggregateError(errors, '제재 화면 시험 종료 실패');
});
async function cleanup(body: () => Promise<void>, actions: Array<() => Promise<unknown>>) {
  const errors: unknown[] = [];
  try {
    await body();
  } catch (error) {
    errors.push(error);
  }
  for (const action of actions)
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, '제재 화면 시험 또는 자기 자원 정리 실패');
}
async function settleRoutes(page: Page, jobs: Set<Promise<void>>, routeErrors: unknown[]) {
  const errors: unknown[] = [];
  try {
    await page.unrouteAll({ behavior: 'wait' });
  } catch (error) {
    errors.push(error);
  }
  while (jobs.size) await Promise.allSettled([...jobs]);
  errors.push(...routeErrors);
  if (errors.length) throw new AggregateError(errors, '실제 제재 응답과 경계 정리 실패');
}
async function confirm(actions: Locator, reason: string) {
  await actions.getByLabel('사유 (1~200자)', { exact: true }).fill(reason);
  await actions.getByRole('checkbox', { name: '대상·범위·사유와 조치를 확인했습니다.', exact: true }).check();
}
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

test('T3-06 AC-M3-04 새 제재의 관리자·본인 거부와 만료·월드·사유 입력 검증은 쓰기를 보내지 않는다', ({
  page,
  browser,
  legalStack: stack,
}) =>
  track(async () => {
    await stack.restart(null, true);
    const admin = await sanctionAccount(stack, page, true);
    const context = await browser.newContext(),
      otherPage = await context.newPage();
    const target = await sanctionAccount(stack, otherPage);
    let writes = 0;
    page.on('request', (request) => {
      if (sanctionCalls(request, 'admin.sanction.create')) writes++;
    });
    await cleanup(async () => {
      let actions = await readSanctionTarget(page, stack, admin.id);
      await confirm(actions, '관리자 거부 확인');
      await expect(actions.getByRole('button', { name: '제재 등록 확정', exact: true })).toBeDisabled();
      actions = await readSanctionTarget(page, stack, target.id);
      await actions.getByRole('checkbox', { name: '무기한', exact: true }).uncheck();
      await actions.getByLabel('만료 시각 (한국)', { exact: true }).fill('2020-01-01T00:00');
      await confirm(actions, '과거 만료 거부');
      await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
      await expect(actions.getByRole('alert')).toHaveText('만료 시각은 현재보다 뒤여야 합니다.');
      await actions.getByRole('checkbox', { name: '무기한', exact: true }).check();
      await actions.getByLabel('범위', { exact: true }).selectOption('WORLD');
      await actions.getByLabel('월드 UUID', { exact: true }).fill('missing');
      await confirm(actions, '잘못된 월드 거부');
      await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
      await expect(actions.getByRole('alert')).toHaveText('월드 UUID를 확인하세요.');
      await confirm(actions, '   ');
      await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
      await expect(actions.getByRole('alert')).toContainText('대상·범위와 사유를 확인');
      expect(writes).toBe(0);
      expect(await stack.db.adminSanctionRequest.count({ where: { actorUserId: admin.id } })).toBe(0);
    }, [() => context.close()]);
  }));

for (const change of ['account', 'role'] as const)
  test(`T3-06 AC-M3-04 마지막 실제 me 뒤 ${change} 변경은 제재0·receipt0·초안 소거`, ({
    page,
    browser,
    legalStack: stack,
  }) =>
    track(async () => {
      await stack.restart(null, true);
      const admin = await sanctionAccount(stack, page, true);
      const context = await browser.newContext(),
        otherPage = await context.newPage();
      const other = await sanctionAccount(stack, otherPage, true);
      const victimContext = await browser.newContext(),
        victimPage = await victimContext.newPage();
      const victim = await sanctionAccount(stack, victimPage);
      const jobs = new Set<Promise<void>>(),
        errors: unknown[] = [];
      await cleanup(async () => {
        const actions = await readSanctionTarget(page, stack, victim.id);
        let once = true;
        await page.route('**/trpc/**', (route) => {
          if (!once || !sanctionCalls(route.request(), 'auth.me')) return route.continue();
          once = false;
          const work = (async () => {
            const actual = await route.fetch({ timeout: 10_000 });
            expect(actual.status()).toBe(200);
            if (change === 'account') {
              const login = await page.request.post(stack.origin + '/trpc/auth.login', {
                headers: { Origin: stack.origin },
                data: { email: other.email, password: TEST_PASSWORD },
              });
              expect(login.status()).toBe(200);
            } else
              await changeAdminRole(stack.db, {
                email: admin.email,
                role: 'USER',
                reason: '마지막 me 뒤 현재 권한 회수',
              });
            await route.fulfill({ response: actual });
          })();
          jobs.add(work);
          void work.catch((error) => errors.push(error));
          void work.finally(() => jobs.delete(work)).catch(() => undefined);
          return work;
        });
        await confirm(actions, '유출하지 않을 이전 초안');
        const denied = observe(
          page.waitForResponse((response) => sanctionCalls(response.request(), 'admin.sanction.create'), {
            timeout: 10_000,
          }),
        );
        await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
        expect((await denied).status()).toBe(change === 'account' ? 401 : 403);
        if (change === 'role') await expect(page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
        else {
          await expect(page.getByRole('heading', { name: '사용자 찾기', exact: true })).toBeVisible();
          await expect(page.getByLabel('상세 조회할 사용자 UUID', { exact: true })).toHaveValue('');
        }
        await expect(page.locator('main')).not.toContainText(victim.email);
        await expect(page.locator('main')).not.toContainText('유출하지 않을 이전 초안');
        expect(await stack.db.sanction.count({ where: { userId: victim.id } })).toBe(0);
        expect(
          await stack.db.adminSanctionRequest.count({ where: { actorUserId: { in: [admin.id, other.id] } } }),
        ).toBe(0);
        expect(await stack.db.auditLog.count({ where: { action: 'sanction.create', targetId: victim.id } })).toBe(0);
      }, [
        async () => {
          await settleRoutes(page, jobs, errors);
        },
        () => context.close(),
        () => victimContext.close(),
      ]);
    }));

for (const event of ['blur', 'offline'] as const)
  test(`T3-06 AC-M3-04 실제 제재 확정 뒤 늦은 응답과 ${event}에도 같은 요청을 보존한다`, ({
    page,
    browser,
    legalStack: stack,
  }) =>
    track(async () => {
      await stack.restart(null, true);
      const admin = await sanctionAccount(stack, page, true);
      const context = await browser.newContext(),
        targetPage = await context.newPage();
      const target = await sanctionAccount(stack, targetPage);
      let release = () => {},
        ready = () => {},
        rejectReady: (error: unknown) => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observed = observe(
        new Promise<void>((resolve, reject) => {
          ready = resolve;
          rejectReady = reject;
        }),
      );
      // 본문 실패에도 정리에서 gate를 풀어 실제 요청을 정착한다.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const jobs = new Set<Promise<void>>(),
        errors: unknown[] = [],
        inputs: unknown[] = [];
      let first = true;
      await cleanup(async () => {
        const actions = await readSanctionTarget(page, stack, target.id);
        await page.route('**/trpc/**', (route) => {
          if (!sanctionCalls(route.request(), 'admin.sanction.create')) return route.continue();
          inputs.push(route.request().postDataJSON());
          if (!first) return route.continue();
          first = false;
          const work = (async () => {
            const response = await route.fetch({ timeout: 10_000 });
            expect(response.status()).toBe(200);
            ready();
            await gate;
            await route.fulfill({ response });
          })();
          jobs.add(work);
          void work.catch((error) => {
            errors.push(error);
            rejectReady(error);
          });
          void work.finally(() => jobs.delete(work)).catch(() => undefined);
          return work;
        });
        await confirm(actions, '늦은 실제 응답');
        timer = setTimeout(() => rejectReady(new Error('실제 제재 응답 관측 기한을 넘겼습니다.')), 10_000);
        await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
        await observed;
        clearTimeout(timer);
        await page.evaluate((value) => window.dispatchEvent(new Event(value)), event);
        release();
        await expect(actions.getByRole('alert')).toContainText('처리 결과를 다시 확인');
        await expect(page.getByRole('region', { name: '사용자 상세', exact: true })).not.toContainText(target.email);
        await expect(actions.getByRole('button', { name: '같은 요청 다시 확인', exact: true })).toBeEnabled();
        expect(inputs).toHaveLength(1);
        await actions.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).click();
        await expect(actions.getByRole('status')).toHaveText('제재를 등록했습니다.');
        expect(inputs).toHaveLength(2);
        expect(inputs[0]).toEqual(inputs[1]);
        expect(await stack.db.sanction.count({ where: { userId: target.id } })).toBe(1);
        expect(await stack.db.adminSanctionRequest.count({ where: { actorUserId: admin.id } })).toBe(1);
        expect(
          await stack.db.auditLog.count({
            where: { actorUserId: admin.id, action: 'sanction.create', targetId: target.id },
          }),
        ).toBe(1);
      }, [
        async () => {
          clearTimeout(timer);
          rejectReady(new Error('실제 응답을 관측하기 전에 시험을 종료했습니다.'));
          release();
          await settleRoutes(page, jobs, errors);
        },
        () => context.close(),
      ]);
    }));

test('T3-06 AC-M3-04 계정 전체 제재·실제 세션 종료·로그인 거부·해제·한국 시각과 네 폭', ({
  page,
  browser,
  legalStack: stack,
}, info) =>
  track(async () => {
    await stack.restart(null, true);
    const admin = await sanctionAccount(stack, page, true);
    const context = await browser.newContext();
    const victimPage = await context.newPage();
    const victim = await sanctionAccount(stack, victimPage);
    const extra = newSession(Date.now());
    await stack.db.session.create({ data: { id: extra.id, userId: victim.id, expiresAt: extra.expiresAt } });
    await cleanup(async () => {
      const actions = await readSanctionTarget(page, stack, victim.id);
      const reason = '<script>window.sanctionInjected=true</script>\n실제 확인 사유';
      await actions.getByRole('checkbox', { name: '무기한', exact: true }).uncheck();
      const future = new Date(Date.now() + 24 * 3600_000 + 9 * 3600_000).toISOString().slice(0, 16);
      await actions.getByLabel('만료 시각 (한국)', { exact: true }).fill(future);
      await confirm(actions, reason);
      for (const width of [375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(
          await page.locator('main button,main input,main select,main textarea,main a').evaluateAll((elements) =>
            elements
              .filter((element) => {
                const r = element.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
              })
              .map((element) => element.tagName),
          ),
        ).toEqual([]);
        await page.screenshot({ path: info.outputPath(`sanction-create-${width}.png`), fullPage: true });
      }
      await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
      await expect(actions.getByRole('status')).toHaveText('제재를 등록했습니다.');
      const row = await stack.db.sanction.findFirstOrThrow({ where: { userId: victim.id } });
      expect(row.createdBy).toBe(admin.id);
      expect(row.worldId).toBeNull();
      expect(row.expiresAt?.toISOString()).toBe(new Date(future + ':00+09:00').toISOString());
      expect(row.reason).toBe(reason);
      expect(await stack.db.session.count({ where: { userId: victim.id } })).toBe(0);
      expect(await stack.db.adminSanctionRequest.count({ where: { actorUserId: admin.id, sanctionId: row.id } })).toBe(
        1,
      );
      expect(
        await stack.db.auditLog.count({
          where: { actorUserId: admin.id, action: 'sanction.create', targetId: victim.id },
        }),
      ).toBe(1);
      const login = () =>
        victimPage.request.post(stack.origin + '/trpc/auth.login', {
          headers: { Origin: stack.origin },
          data: { email: victim.email, password: TEST_PASSWORD },
        });
      expect((await login()).status()).toBe(401);
      const detail = page.getByRole('region', { name: '사용자 상세', exact: true });
      await expect(detail.getByText(reason, { exact: true })).toBeVisible();
      expect(await detail.locator('script').count()).toBe(0);
      expect(await page.evaluate(() => Object.hasOwn(window, 'sanctionInjected'))).toBe(false);
      await actions.getByLabel('조치', { exact: true }).selectOption(row.id);
      await confirm(actions, '해제 확인');
      await actions.getByRole('button', { name: '제재 해제 확정', exact: true }).click();
      await expect(actions.getByRole('status')).toHaveText('제재를 해제했습니다.');
      expect((await login()).status()).toBe(200);
      expect((await stack.db.sanction.findUniqueOrThrow({ where: { id: row.id } })).liftedBy).toBe(admin.id);
      expect(
        await stack.db.auditLog.count({
          where: { actorUserId: admin.id, action: 'sanction.lift', targetId: victim.id },
        }),
      ).toBe(1);
      await expect(detail.getByText(/해제됨/)).toBeVisible();
      expect(new URL(page.url()).search).toBe('');
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      await page.screenshot({ path: info.outputPath('sanction-lifted.png'), fullPage: true });
    }, [() => context.close()]);
  }));

test('T3-06 AC-M3-04 실제 확정 응답 유실 뒤 같은 키 수동 확인은 제재·감사·receipt를 하나만 남긴다', ({
  page,
  browser,
  legalStack: stack,
}) =>
  track(async () => {
    await stack.restart(null, true);
    const admin = await sanctionAccount(stack, page, true);
    const context = await browser.newContext(),
      targetPage = await context.newPage();
    const target = await sanctionAccount(stack, targetPage);
    const inputs: unknown[] = [],
      jobs = new Set<Promise<void>>(),
      errors: unknown[] = [];
    let first = true;
    await page.route('**/trpc/**', (route) => {
      if (!sanctionCalls(route.request(), 'admin.sanction.create')) return route.continue();
      inputs.push(route.request().postDataJSON());
      const work = (async () => {
        if (first) {
          first = false;
          const actual = await route.fetch({ timeout: 10_000 });
          expect(actual.status()).toBe(200);
          await route.abort('failed');
        } else await route.continue();
      })();
      jobs.add(work);
      void work.catch((error) => errors.push(error));
      void work.finally(() => jobs.delete(work)).catch(() => undefined);
      return work;
    });
    await cleanup(async () => {
      const actions = await readSanctionTarget(page, stack, target.id);
      await confirm(actions, '응답 유실 확인');
      await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
      await expect(actions.getByRole('alert')).toContainText('처리 결과를 확인하지 못했습니다.');
      expect(await stack.db.sanction.count({ where: { userId: target.id } })).toBe(1);
      await expect(page.getByRole('button', { name: '상세 조회', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '찾기', exact: true })).toBeDisabled();
      await frames(page);
      expect(inputs).toHaveLength(1);
      const ledger = await stack.db.adminSanctionRequest.findFirstOrThrow({ where: { actorUserId: admin.id } });
      const untilMinute = 60_000 - (Date.now() % 60_000);
      if (untilMinute < 5_000) await new Promise((resolve) => setTimeout(resolve, untilMinute + 100));
      let retryAfter = 0;
      // 실제 성공 요청만 반복해 서버 한도를 채운다. 한도나 시각을 주입하지 않는다.
      for (let attempt = 0; attempt < 241; attempt++) {
        const repeated = await page.request.post(stack.origin + '/trpc/admin.sanction.create', {
          headers: { Origin: stack.origin },
          data: {
            userId: target.id,
            worldId: null,
            reason: '응답 유실 확인',
            expiresAt: null,
            expectedUserId: admin.id,
            idempotencyKey: ledger.idempotencyKey,
          },
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
      const retry = actions.getByRole('button', { name: '같은 요청 다시 확인', exact: true });
      await retry.click();
      await expect(actions.getByRole('alert')).toContainText('요청이 많습니다.');
      await expect(retry).toBeDisabled();
      await expect(actions.getByText(/^다시 확인까지 \d+초$/)).toBeVisible();
      expect(inputs).toHaveLength(2);
      await expect(retry).toBeEnabled({ timeout: 65_000 });
      await retry.click();
      await expect(actions.getByRole('status')).toHaveText('제재를 등록했습니다.');
      expect(inputs).toHaveLength(3);
      expect(inputs[0]).toEqual(inputs[1]);
      expect(inputs[0]).toEqual(inputs[2]);
      expect(await stack.db.sanction.count({ where: { userId: target.id } })).toBe(1);
      expect(
        await stack.db.auditLog.count({
          where: { actorUserId: admin.id, action: 'sanction.create', targetId: target.id },
        }),
      ).toBe(1);
      expect(await stack.db.adminSanctionRequest.count({ where: { actorUserId: admin.id } })).toBe(1);
      await expect(page.getByRole('button', { name: '상세 조회', exact: true })).toBeEnabled();
    }, [
      async () => {
        await settleRoutes(page, jobs, errors);
      },
      () => context.close(),
    ]);
  }));

test('T3-06 AC-M3-04 정식 두191년 월드의 한 월드 제재·다른 월드 저장·30칸 보존·해제', ({
  page,
  browser,
  legalStack: stack,
}) =>
  track(async () => {
    await stack.restart(null, true);
    await sanctionAccount(stack, page, true);
    const context = await browser.newContext(),
      victimPage = await context.newPage();
    const victim = await sanctionAccount(stack, victimPage);
    let formal: Awaited<ReturnType<typeof formalSanctionWorlds>> | undefined;
    await cleanup(async () => {
      formal = await formalSanctionWorlds(stack, victimPage, victim.id);
      const [first, second] = formal.worlds;
      const ids = [first!.id, second!.id];
      const snapshot = () =>
        stack.db.generalTurn.findMany({
          where: { worldId: { in: ids } },
          orderBy: [{ worldId: 'asc' }, { generalId: 'asc' }, { slot: 'asc' }],
        });
      const before = await snapshot();
      const actions = await readSanctionTarget(page, stack, victim.id);
      await actions.getByLabel('범위', { exact: true }).selectOption('WORLD');
      await actions.getByLabel('월드 UUID', { exact: true }).fill(first!.id);
      await confirm(actions, '첫 월드의 변경 중지');
      await actions.getByRole('button', { name: '제재 등록 확정', exact: true }).click();
      await expect(actions.getByRole('status')).toHaveText('제재를 등록했습니다.');
      expect(await snapshot()).toEqual(before);
      expect(await stack.db.session.count({ where: { userId: victim.id } })).toBe(1);
      for (const [world, status] of [
        [first!, 403],
        [second!, 200],
      ] as const) {
        await victimPage.goto(stack.origin + `/w/${world.id}`);
        const editor = victimPage.getByTestId('turn-editor');
        await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
        await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
        await editor.locator('tr[data-slot="1"]').click();
        await editor.getByLabel('명령 찾기').fill('농지 개간');
        await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
        await editor.getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
        const response = observe(
          victimPage.waitForResponse((value) => sanctionCalls(value.request(), 'turns.set'), {
            timeout: 10_000,
          }),
        );
        await editor.getByRole('button', { name: '저장', exact: true }).click();
        expect((await response).status()).toBe(status);
        if (status === 200) await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
      }
      const after = await snapshot();
      expect(after.filter((row) => row.worldId === first!.id)).toEqual(
        before.filter((row) => row.worldId === first!.id),
      );
      const secondHuman = await stack.db.general.findUniqueOrThrow({
        where: { worldId_userId: { worldId: second!.id, userId: victim.id } },
      });
      expect(after.filter((row) => row.worldId === second!.id && row.generalId === secondHuman.id)).toHaveLength(30);
      expect(
        after.find((row) => row.worldId === second!.id && row.generalId === secondHuman.id && row.slot === 0)
          ?.commandKey,
      ).toBe('farm');
      const row = await stack.db.sanction.findFirstOrThrow({ where: { userId: victim.id, worldId: first!.id } });
      const refreshed = await readSanctionTarget(page, stack, victim.id);
      await refreshed.getByLabel('조치', { exact: true }).selectOption(row.id);
      await confirm(refreshed, '첫 월드 변경 다시 허용');
      await refreshed.getByRole('button', { name: '제재 해제 확정', exact: true }).click();
      await expect(refreshed.getByRole('status')).toHaveText('제재를 해제했습니다.');
      expect(await snapshot()).toEqual(after);
    }, [() => context.close(), async () => formal?.cleanup()]);
  }));
