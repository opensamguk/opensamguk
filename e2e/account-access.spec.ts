import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createAccount, TEST_PASSWORD, withE2eDb, e2eDatabaseUrl } from './account';
import { accountMailLink } from './mailbox';
import { holdLease } from './game';
import { cleanupHeldWorld } from './heldWorldCleanup';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';

const emails = new Set<string>();
const executions = new Set<Promise<unknown>>();
function track<T>(action: () => Promise<T>): Promise<T> {
  const execution = Promise.resolve().then(action);
  executions.add(execution);
  void execution.finally(() => executions.delete(execution)).catch(() => undefined);
  return execution;
}
async function settled() {
  while (executions.size > 0) await Promise.allSettled([...executions]);
}
function scenario(name: string, run: (args: { page: Page; context: BrowserContext }, info: TestInfo) => Promise<void>) {
  test(name, async ({ page, context }, info) => track(() => run({ page, context }, info)));
}
test.beforeEach(settled);
test.afterEach(async ({ page }) => {
  // 시간 초과된 locator도 정착시킨 뒤 DB를 정리한다. 페이지 종료는 서버의 자기 월드 정리보다 먼저다.
  await page.close();
  await settled();
  try {
    await withE2eDb(async (db) => {
      if (await db.general.count({ where: { user: { email: { in: [...emails] } } } }))
        throw new Error('월드가 남은 시험 계정을 보존합니다.');
      await db.user.deleteMany({ where: { email: { in: [...emails] } } });
    });
  } finally {
    emails.clear();
  }
});
function email() {
  const value = `required-${randomUUID()}@example.test`;
  emails.add(value);
  return value;
}
async function required(page: Page, verified = false) {
  const response = await page.request.get('/trpc/account.get?batch=1&input=%7B%7D');
  expect(response.status()).toBe(200);
  expect((await response.json())[0].result.data).toMatchObject({
    emailVerificationRequired: true,
    emailVerified: verified,
  });
}
async function signup(page: Page, address: string, next?: string) {
  await page.goto('/signup' + (next ? '?next=' + encodeURIComponent(next) : ''));
  await page.getByLabel('이메일', { exact: true }).fill(address);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  const after = Date.now();
  await page.getByRole('button', { name: '가입하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
  await required(page);
  return after;
}
async function openMail(page: Page, link: string) {
  try {
    await page.goto(link);
  } catch {
    throw new Error('시험 인증 화면을 열지 못했습니다.');
  }
  await expect(page.getByRole('status')).toHaveText('이메일 인증을 마쳤습니다.');
  expect(new URL(page.url()).hash === '').toBe(true);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
}
async function mobile(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const small = await page.locator('main a,main button,main input').evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.width < 44 || rect.height < 44);
      })
      .map((element) => element.tagName),
  );
  expect(small).toEqual([]);
}

scenario('T3-03 필수 서버의 루트·게임·생성·알림 직접 접근과 새로고침을 막고 복구·로비는 연다', async ({ page }) => {
  await createAccount(page, email());
  await required(page);
  const id = randomUUID();
  for (const path of ['/', `/w/${id}?city=40`, `/w/${id}/create`, `/w/${id}/turns`, '/settings/notifications']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('next')).toBe(path);
    await page.reload();
    await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('next')).toBe(path);
  }
  for (const [path, heading] of [
    ['/lobby', '로비'],
    ['/account', '내 계정'],
    ['/forgot-password', '비밀번호 재설정'],
    ['/reset-password', '새 비밀번호'],
  ]) {
    await page.goto(path!);
    await expect(page.getByRole('heading', { name: heading!, exact: true })).toBeVisible();
  }
});

scenario('T3-03 실제 가입·메일 인증·토큰 소거·위조 next와 375px 키보드 계속하기', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const address = email();
  const after = await signup(page, address, 'https://example.invalid');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/lobby');
  await mobile(page);
  await page.screenshot({ path: info.outputPath('required-verification-375.png'), fullPage: true });
  await openMail(page, await accountMailLink(address, '오픈삼국 이메일 인증', after));
  await required(page, true);
  const next = page.getByRole('link', { name: '계속하기', exact: true });
  await expect(next).toHaveAttribute('href', '/lobby');
  await next.focus();
  await expect(next).toBeFocused();
  await mobile(page);
  await page.screenshot({ path: info.outputPath('required-verified-375.png'), fullPage: true });
  for (const unsafe of ['/x/..//example.invalid', '/x/%2e%2e//example.invalid', '/x/.%2e//example.invalid']) {
    await page.goto('/verify-email?next=' + encodeURIComponent(unsafe));
    await expect(page.getByRole('link', { name: '계속하기', exact: true })).toHaveAttribute('href', '/lobby');
    expect(new URL(page.url()).origin).toBe(new URL(test.info().project.use.baseURL!).origin);
  }
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/lobby');
});

scenario('T3-03 인증 조회 연결 실패 뒤 이미 성공한 가입을 다시 제출하지 않는다', async ({ page }) => {
  const address = email();
  const destination = `/w/${randomUUID()}?city=40`;
  let signups = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.includes('auth.signup')) signups++;
  });
  await page.route('**/trpc/account.get*', (route) => route.abort('failed'));
  await page.goto('/signup?next=' + encodeURIComponent(destination));
  await page.getByLabel('이메일', { exact: true }).fill(address);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  const after = Date.now();
  await page.getByRole('button', { name: '가입하기', exact: true }).click();
  await expect(page.getByRole('alert').getByText('서버에 연결할 수 없습니다', { exact: true })).toBeVisible();
  expect(signups).toBe(1);
  expect(await withE2eDb((db) => db.user.count({ where: { email: address } }))).toBe(1);
  await page.unroute('**/trpc/account.get*');
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe(destination);
  await required(page);
  expect(signups).toBe(1);
  await openMail(page, await accountMailLink(address, '오픈삼국 이메일 인증', after));
  await page.goto('/lobby');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.goto('/login?next=' + encodeURIComponent('/settings/notifications'));
  await page.route('**/trpc/account.get*', (route) => route.abort('failed'));
  await page.getByLabel('이메일', { exact: true }).fill(address);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('alert').getByText('서버에 연결할 수 없습니다', { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe('/settings/notifications');
  await page.unroute('**/trpc/account.get*');
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page).toHaveURL('/settings/notifications');
  expect(signups).toBe(1);
});

scenario('T3-03 세션 조회 사이 만료와 다른 탭 로그아웃을 캐시로 통과시키지 않는다', async ({ page, context }) => {
  const address = email();
  await createAccount(page, address);
  await required(page);
  await page.route('**/trpc/account.get*', async (route) => {
    await withE2eDb((db) => db.session.deleteMany({ where: { user: { email: address } } }));
    await route.continue();
  });
  await page.goto('/settings/notifications');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fnotifications$/);
  await page.unroute('**/trpc/account.get*');
  const destination = `/w/${randomUUID()}?city=40`;
  await page.goto('/verify-email?next=' + encodeURIComponent(destination));
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe(destination);
  await page.getByLabel('이메일', { exact: true }).fill(address);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe(destination);
  await createAccount(page, email());
  await required(page);
  await page.goto('/account');
  const other = await context.newPage();
  try {
    await other.goto('/lobby');
    await other.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.goto('/settings/notifications');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fnotifications$/);
  } finally {
    await other.close();
  }
});

scenario(
  'T3-03 정식191년491명 실제 인증·생성·30칸 저장과 403 뒤 같은 월드 초안 복구',
  async ({ page, context }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 900 });
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'public-required-ui-191',
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
    const { worldId } = await withE2eDb((db) =>
      saveInitialWorld(db, initial, { name: '공개 인증 화면 정식191', turnTermMinutes: 60, endYear: 201 }),
    );
    let hold: Awaited<ReturnType<typeof holdLease>> | undefined;
    let failure: unknown;
    try {
      hold = await holdLease(worldId);
      await controlClock(hold.db, worldId, 'start');
      const address = email();
      const destination = `/w/${worldId}/create`;
      const after = await signup(page, address, destination);
      expect(new URL(page.url()).searchParams.get('next')).toBe(destination);
      const confirmation = await context.newPage();
      try {
        await openMail(confirmation, await accountMailLink(address, '오픈삼국 이메일 인증', after));
      } finally {
        await confirmation.close();
      }
      await page.reload();
      await expect(page.getByRole('link', { name: '계속하기', exact: true })).toHaveAttribute('href', destination);
      await page.getByRole('link', { name: '계속하기', exact: true }).click();
      await expect(page.getByRole('spinbutton')).toHaveCount(5);
      await page.getByLabel('이름', { exact: true }).fill('인증화면장수');
      await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
      await expect
        .poll(() => hold!.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
        .toBe(1);
      expect(hold.lost).toBeUndefined();
      await new TurnLoop(hold.db, hold.lease).advanceTo(0);
      await expect(page.getByRole('heading', { name: '군략도', exact: true })).toBeVisible();
      const main = `/w/${worldId}?city=40`;
      await page.goto(main);
      await expect(page.getByRole('link', { name: '내 계정', exact: true })).toBeVisible();
      const editor = page.getByTestId('turn-editor');
      await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
      async function draft(slot: number) {
        await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
        await editor.locator(`tr[data-slot="${slot}"]`).click();
        await editor.getByLabel('명령 찾기').fill('농지 개간');
        await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
        await editor.getByRole('button', { name: `${slot}번 칸에 넣기`, exact: true }).click();
        await expect(editor.locator(`tr[data-slot="${slot}"]`)).toContainText('농지 개간');
      }
      await draft(1);
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
      const actor = await hold.db.general.findUniqueOrThrow({
        where: {
          worldId_userId: { worldId, userId: (await hold.db.user.findUniqueOrThrow({ where: { email: address } })).id },
        },
      });
      expect(await hold.db.generalTurn.count({ where: { worldId, generalId: actor.id } })).toBe(30);
      expect(await hold.db.generalTurn.count({ where: { worldId } })).toBe((491 + 1) * 30);
      expect(await hold.db.general.count({ where: { worldId, userId: null } })).toBe(491);
      await draft(2);
      const before = await hold.db.generalTurn.findMany({
        where: { worldId },
        orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
      });
      await hold.db.user.update({ where: { email: address }, data: { emailVerifiedAt: null } });
      const denied = page.waitForResponse(
        (response) => response.request().method() === 'POST' && new URL(response.url()).pathname.includes('turns.set'),
      );
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      expect((await denied).status()).toBe(403);
      await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('next')).toBe(main);
      expect(
        await hold.db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
      ).toEqual(before);
      const resent = Date.now();
      await page.getByRole('button', { name: '인증 메일 다시 보내기', exact: true }).click();
      const recheck = await context.newPage();
      try {
        await openMail(recheck, await accountMailLink(address, '오픈삼국 이메일 인증', resent));
      } finally {
        await recheck.close();
      }
      await page.reload();
      await page.getByRole('link', { name: '계속하기', exact: true }).click();
      await expect(page).toHaveURL(main);
      await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
      await expect(editor.locator('tr[data-slot="2"]')).toContainText('농지 개간');
      await page.screenshot({ path: info.outputPath('required-formal-draft-375.png'), fullPage: true });
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
      const slots = await hold.db.generalTurn.findMany({
        where: { worldId, generalId: actor.id },
        orderBy: { slot: 'asc' },
      });
      expect(slots).toHaveLength(30);
      expect(slots.slice(0, 2).map((slot) => slot.commandKey)).toEqual(['farm', 'farm']);
    } catch (error) {
      failure = error;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await page.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (hold) {
      try {
        await cleanupHeldWorld(hold, e2eDatabaseUrl());
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else cleanupErrors.push(new Error('실행권을 확보하지 못한 시험 월드를 보존합니다.'));
    if (failure || cleanupErrors.length)
      throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], '인증 인수 본문·정리 실패');
  },
);
