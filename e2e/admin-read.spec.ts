import { randomBytes } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test as base, expect, apiMutate, type T210World } from './t210-fixture';
import { adminRole } from './adminSetup';
import { TEST_PASSWORD } from './account';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease, releaseHold } from './game';

const test = base.extend<Record<never, never>, { adminEmailPolicy: void }>({
  adminEmailPolicy: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const saved = process.env.EMAIL_VERIFICATION_REQUIRED;
      process.env.EMAIL_VERIFICATION_REQUIRED = '1';
      try {
        await use();
      } finally {
        if (saved === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
        else process.env.EMAIL_VERIFICATION_REQUIRED = saved;
      }
    },
    { scope: 'worker', auto: true },
  ],
});

const executions = new Set<Promise<unknown>>();
function track<T>(work: () => Promise<T>) {
  const pending = Promise.resolve().then(work);
  executions.add(pending);
  void pending.finally(() => executions.delete(pending)).catch(() => undefined);
  return pending;
}
async function settled() {
  while (executions.size) await Promise.allSettled([...executions]);
}
function observe<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('실제 요청 관측 기한을 넘겼습니다.')), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  executions.add(result);
  void result.finally(() => executions.delete(result)).catch(() => undefined);
  return result;
}
test.beforeEach(settled);
test.afterEach(settled);
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
  if (errors.length) throw new AggregateError(errors, '관리자 조회 시험과 자기 자원 정리 실패');
}
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
function calls(request: Request, procedure: string) {
  return new URL(request.url()).pathname.split('/').at(-1)?.split(',').includes(procedure) ?? false;
}

async function fixture(world: T210World) {
  const admin = await world.user('ruler'),
    actor = await world.user('member'),
    peer = await world.user('ronin');
  await adminRole(world, admin, 'grant');
  await world.hold.db.user.update({ where: { id: actor.userId }, data: { emailVerifiedAt: new Date() } });
  return { admin, actor, peer, db: world.hold.db };
}

test('T3-06 AC-M3-04 정식191 장수 검색·감사·자동 조회 금지·오류 소거·키보드·세 폭', ({ world }) =>
  track(async () => {
    test.setTimeout(120_000);
    const { admin, actor, db } = await fixture(world),
      page = admin.page;
    const tag = randomBytes(5).toString('hex'),
      prefix = `read-${tag}-`;
    const { passwordHash, email } = await db.user.findUniqueOrThrow({ where: { id: actor.userId } });
    await db.user.createMany({
      data: Array.from({ length: 60 }, (_, index) => ({ email: `${prefix}${index}@example.test`, passwordHash })),
    });
    const special = `${prefix}%_\\@example.test`;
    await db.user.create({ data: { email: special, passwordHash } });
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: `admin-read-${tag}`,
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
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '관리자 조회 정식191',
      turnTermMinutes: 60,
      endYear: 201,
    });
    const hold = await holdLease(worldId);
    let trigger = false;
    const requests: Request[] = [];
    page.on('request', (request) => {
      if (calls(request, 'admin.user.search')) requests.push(request);
    });
    await cleanup(async () => {
      await controlClock(hold.db, worldId, 'start');
      await apiMutate(world, actor, 'general.create', {
        worldId,
        name: '조회장수',
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      });
      await new TurnLoop(hold.db, hold.lease).advanceTo(0);
      expect(await db.general.count({ where: { worldId } })).toBe(492);
      expect(await db.generalTurn.count({ where: { worldId } })).toBe(492 * 30);
      const formal = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      expect(formal.ruleFeatures).toEqual(initial.ruleFeatures);
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: '운영 조회', exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('admin-home.png'), fullPage: true });
      await page.getByRole('link', { name: '사용자 찾기', exact: true }).click();
      await expect(page.getByRole('heading', { name: '사용자 찾기', exact: true })).toBeVisible();
      const input = page.getByLabel('이메일 앞부분 또는 사용자 UUID', { exact: true });
      await input.fill(email);
      await frames(page);
      expect(requests).toHaveLength(0);
      const before = await db.auditLog.count({ where: { actorUserId: admin.userId, action: 'user.search' } });
      await input.press('Enter');
      await expect(page.getByRole('status')).toHaveText('1명');
      await expect(page.getByRole('table', { name: '사용자 검색 결과' })).toContainText(email);
      expect(requests).toHaveLength(1);
      expect(calls(requests[0]!, 'auth.me')).toBe(true);
      expect(await db.auditLog.count({ where: { actorUserId: admin.userId, action: 'user.search' } })).toBe(before + 1);
      expect(new URL(page.url()).search).toBe('');
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      const checked = observe(page.waitForResponse((response) => calls(response.request(), 'admin.whoami')));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await checked;
      await frames(page);
      expect(requests).toHaveLength(1);
      await expect(page.getByRole('table')).toHaveCount(0);
      await input.fill(prefix);
      await page.getByRole('button', { name: '찾기', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('50명');
      expect(await page.getByRole('table').locator('tbody tr').count()).toBe(50);
      await input.fill(special);
      await input.press('Enter');
      await expect(page.getByRole('status')).toHaveText('1명');
      await expect(page.getByRole('table')).toContainText(special);
      await input.fill(actor.userId);
      await input.press('Enter');
      await expect(page.getByRole('status')).toHaveText('1명');
      await expect(page.getByRole('table')).toContainText(email);
      await page.getByLabel('검색 방식').selectOption('general');
      await page.getByLabel('월드 UUID', { exact: true }).fill(worldId);
      await page.getByLabel('장수 이름 앞부분').fill('조회장수%_');
      await page.getByRole('button', { name: '찾기', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('0명');
      await page.getByLabel('장수 이름 앞부분').fill('조회장수');
      await page.getByRole('button', { name: '찾기', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('1명');
      await expect(page.getByRole('table')).toContainText(email);
      for (const width of [768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(
          await page.locator('main button,main input,main select,main a').evaluateAll((elements) =>
            elements
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && (rect.width < 44 || rect.height < 44);
              })
              .map((element) => element.tagName),
          ),
        ).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`admin-users-${width}.png`), fullPage: true });
      }
      await page.getByLabel('장수 이름 앞부분').fill('없는장수');
      await page.getByRole('button', { name: '찾기', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('0명');
      await page.getByLabel('장수 이름 앞부분').fill('조회장수');
      await page.getByRole('button', { name: '찾기', exact: true }).click();
      await expect(page.getByRole('table')).toContainText(email);
      await db.$executeRawUnsafe(
        `CREATE FUNCTION admin_ui_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned admin UI fixture'; END $$`,
      );
      await db.$executeRawUnsafe(
        'CREATE TRIGGER admin_ui_audit_fail BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION admin_ui_audit_fail()',
      );
      trigger = true;
      await page.getByRole('button', { name: '찾기', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('조회하지 못했습니다.');
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText(email);
      await expect(page.locator('main')).not.toContainText('owned admin UI fixture');
    }, [
      async () => {
        if (trigger) await db.$executeRawUnsafe('DROP TRIGGER admin_ui_audit_fail ON "AuditLog"');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS admin_ui_audit_fail()');
      },
      () => releaseHold(hold),
    ]);
  }));

test('T3-06 AC-M3-04 실제 인증 필수 서버의 미인증 ADMIN은 인증 화면으로 이동한다', ({ world }) =>
  track(async () => {
    const { admin, db } = await fixture(world);
    await db.user.update({ where: { id: admin.userId }, data: { emailVerifiedAt: null } });
    const state = await admin.page.request.get(world.stack.webOrigin + '/trpc/account.get');
    expect(state.status()).toBe(200);
    expect((await state.json()).result.data).toMatchObject({ emailVerificationRequired: true, emailVerified: false });
    await admin.page.goto('/admin/audit');
    await expect(admin.page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
    await expect(admin.page.getByRole('heading', { name: '관리자 콘솔', exact: true })).toHaveCount(0);
    expect(new URL(admin.page.url()).searchParams.get('next')).toBe('/admin/audit');
  }));

test('T3-06 AC-M3-04 감사 다섯 필터·한국 시각·123행 세 페이지·마지막 cursor·텍스트 렌더링', ({ world }) =>
  track(async () => {
    test.setTimeout(120_000);
    const { admin, actor, db } = await fixture(world),
      page = admin.page;
    const action = 'screen.test.' + randomBytes(5).toString('hex'),
      at = new Date('2026-10-28T01:00:00.000Z');
    const reason = '<script>window.adminAuditInjected=true</script>';
    await db.auditLog.createMany({
      data: Array.from({ length: 123 }, (_, index) => ({
        actorKind: 'ADMIN' as const,
        actorUserId: admin.userId,
        action,
        targetType: 'User',
        targetId: actor.userId,
        worldId: world.id,
        at,
        reason,
        payload: { index, text: '<img src=x onerror=alert(1)>' },
      })),
    });
    const expected = (
      await db.auditLog.findMany({ where: { action }, orderBy: { id: 'desc' }, select: { id: true } })
    ).map((item) => item.id.toString());
    await page.goto('/admin/audit');
    await page.getByLabel('시작 시각 (한국)', { exact: true }).fill('2026-10-28T09:59');
    await page.getByLabel('끝 시각 (한국)', { exact: true }).fill('2026-10-28T10:01');
    await page.getByLabel('행위 종류 앞부분').fill(action);
    await page.getByLabel('행위자 UUID', { exact: true }).fill(admin.userId);
    await page.getByLabel('대상', { exact: true }).fill(actor.userId);
    await page.getByLabel('월드 UUID', { exact: true }).fill(world.id);
    await page.getByRole('button', { name: '조회', exact: true }).click();
    const actual: string[] = [];
    for (const size of [50, 50, 23]) {
      await expect(page.getByRole('status')).toHaveText(`${size}건`);
      const table = page.getByRole('table', { name: '감사 조회 결과' });
      const rows = table.locator('tbody tr');
      await expect(rows).toHaveCount(size);
      actual.push(
        ...(await rows
          .locator('td:first-child')
          .evaluateAll((cells) => cells.map((cell) => cell.childNodes[0]!.textContent!))),
      );
      await expect(table).toContainText(reason);
      expect(await table.locator('script,img').count()).toBe(0);
      expect(await page.evaluate(() => 'adminAuditInjected' in window)).toBe(false);
      await expect(table.locator('time').first()).toHaveAttribute('title', at.toISOString());
      if (actual.length === 50)
        await page.screenshot({ path: test.info().outputPath('admin-audit.png'), fullPage: true });
      if (size === 50) await page.getByRole('button', { name: '다음50건', exact: true }).click();
    }
    expect(actual).toEqual(expected);
    await expect(page.getByRole('button', { name: '다음50건', exact: true })).toHaveCount(0);
    await expect(page.getByText('마지막 페이지입니다.', { exact: true })).toBeVisible();
    await page.getByLabel('행위 종류 앞부분').fill('nonexistent');
    await expect(page.getByRole('table')).toHaveCount(0);
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('0건');
  }));

test('T3-06 AC-M3-04 익명·일반 계정 가드와 실제 계정 전환·권한 회수·지연 성공 응답 소거', ({ world }) =>
  track(async () => {
    test.setTimeout(120_000);
    const { admin, actor, db } = await fixture(world),
      page = admin.page;
    const { email } = await db.user.findUniqueOrThrow({ where: { id: actor.userId } });
    await actor.page.goto('/admin/users');
    await expect(actor.page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
    await expect(actor.page.getByRole('heading', { name: '관리자 콘솔', exact: true })).toHaveCount(0);
    await page.goto('/admin/users');
    const input = page.getByLabel('이메일 앞부분 또는 사용자 UUID', { exact: true });
    await input.fill(actor.userId);
    await input.press('Enter');
    await expect(page.getByRole('table')).toContainText(email);
    await adminRole(world, admin, 'revoke');
    await page.getByRole('button', { name: '찾기', exact: true }).click();
    await expect(page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(email);
    await adminRole(world, admin, 'grant');
    await page.goto('/admin/users');
    await input.fill(actor.userId);
    let release = () => {},
      observed = () => {},
      rejectReady: (error: unknown) => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = observe(
        new Promise<void>((resolve, reject) => {
          observed = resolve;
          rejectReady = reject;
        }),
      );
    const routes = new Set<Promise<unknown>>();
    const routeErrors: unknown[] = [];
    await page.route('**/trpc/**', (route) => {
      if (!calls(route.request(), 'admin.user.search')) return route.continue();
      const pending = (async () => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        observed();
        await held;
        try {
          await route.fulfill({ response });
        } catch (error) {
          if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(route.request().failure()?.errorText ?? '')) throw error;
        }
      })();
      routes.add(pending);
      void pending.catch((error) => {
        routeErrors.push(error);
        rejectReady(error);
      });
      void pending.finally(() => routes.delete(pending)).catch(() => undefined);
      return pending;
    });
    const other = await admin.context.newPage();
    await cleanup(async () => {
      await page.getByRole('button', { name: '찾기', exact: true }).click();
      await ready;
      const response = await other.request.post(world.stack.webOrigin + '/trpc/auth.login', {
        headers: { origin: world.stack.webOrigin },
        data: { email, password: TEST_PASSWORD },
      });
      expect(response.status()).toBe(200);
      const checked = observe(page.waitForResponse((value) => calls(value.request(), 'admin.whoami')));
      const aborted = observe(page.waitForEvent('requestfailed', (request) => calls(request, 'admin.user.search')));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await checked;
      await aborted;
      await expect(page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
      release();
      await Promise.allSettled([...routes]);
      expect(routeErrors).toEqual([]);
      await frames(page);
      await expect(page.locator('body')).not.toContainText(email);
      await admin.context.clearCookies();
      await page.goto('/admin/audit');
      await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/audit');
    }, [
      async () => {
        release();
        await Promise.allSettled([...routes]);
        await page.unrouteAll({ behavior: 'wait' });
        if (routeErrors.length) throw new AggregateError(routeErrors, '지연한 실제 응답 정착 실패');
      },
      () => other.close(),
    ]);
  }));
