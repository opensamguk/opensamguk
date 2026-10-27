import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAccount, TEST_PASSWORD, withE2eDb } from './account';
import { accountMailLink } from './mailbox';

async function openMail(page: Page, link: string) {
  try {
    await page.goto(link);
  } catch {
    throw new Error('시험 메일의 계정 화면을 열지 못했습니다.');
  }
  await expect.poll(() => new URL(page.url()).hash === '').toBe(true);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
}
async function mobileLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const controls = await page.locator('main input, main button, main a').evaluateAll((elements) =>
    elements
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element: element.tagName, width: rect.width, height: rect.height };
      }),
  );
  expect(controls.filter((control) => control.width < 44 || control.height < 44)).toEqual([]);
}

test('실제 가입 화면에서 받은 메일로 이메일을 한 번 인증한다 (375px)', async ({ page }, testInfo) => {
  const email = `signup-${randomUUID()}@example.test`;
  try {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto('/signup');
    await mobileLayout(page);
    await page.screenshot({ path: testInfo.outputPath('signup-form-375.png'), fullPage: true });
    await page.getByLabel('이메일', { exact: true }).fill(email);
    await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
    const after = Date.now();
    await page.getByRole('button', { name: '가입하기', exact: true }).click();
    await expect(page).toHaveURL('/lobby');
    expect(
      await withE2eDb(async (db) => (await db.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt === null),
    ).toBe(true);
    const link = await accountMailLink(email, '오픈삼국 이메일 인증', after);
    await openMail(page, link);
    await expect(page.getByRole('status')).toHaveText('이메일 인증을 마쳤습니다.');
    await mobileLayout(page);
    expect(
      await withE2eDb(async (db) => (await db.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt !== null),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('signup-verified-375.png'), fullPage: true });
    await openMail(page, link);
    await expect(page.getByRole('alert')).toHaveText('링크가 만료됐거나 이미 쓰였습니다. 새 링크를 요청하세요.');
  } finally {
    await withE2eDb((db) => db.user.deleteMany({ where: { email } }));
  }
});

for (const width of [375, 1280]) {
  test(`계정에서 인증 메일 수신·한 번 인증·재사용 거부 (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const email = await createAccount(page);
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: '내 계정' })).toBeVisible();
    await mobileLayout(page);
    if (width === 375) await page.screenshot({ path: testInfo.outputPath('account-375.png'), fullPage: true });
    const after = Date.now();
    await page.getByRole('button', { name: '인증 메일 다시 보내기', exact: true }).click();
    const link = await accountMailLink(email, '오픈삼국 이메일 인증', after);
    await expect(page.getByRole('button', { name: /인증 메일 다시 보내기 \(/ })).toBeDisabled();
    await page.reload();
    const limitedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.includes('account.resendVerification'),
    );
    await page.getByRole('button', { name: '인증 메일 다시 보내기', exact: true }).click();
    const limited = await limitedResponse;
    expect(limited.status()).toBe(429);
    const retryAfter = Number(await limited.headerValue('retry-after'));
    expect(Number.isInteger(retryAfter) && retryAfter > 0).toBe(true);
    await expect(page.getByRole('alert')).toHaveText(`${retryAfter}초 뒤에 다시 요청하세요.`);
    await expect(page.getByRole('button', { name: /인증 메일 다시 보내기 \(/ })).toBeDisabled();
    let requests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.includes('account.verifyEmail')) requests++;
    });
    await openMail(page, link);
    await expect(page.getByRole('status')).toHaveText('이메일 인증을 마쳤습니다.');
    expect(requests).toBe(1);
    await mobileLayout(page);
    if (width === 375) await page.screenshot({ path: testInfo.outputPath('verified-375.png'), fullPage: true });
    expect(
      await withE2eDb(
        async (db) =>
          (await db.user.findUniqueOrThrow({ where: { email }, select: { emailVerifiedAt: true } })).emailVerifiedAt !==
          null,
      ),
    ).toBe(true);
    await openMail(page, link);
    await expect(page.getByRole('alert')).toHaveText('링크가 만료됐거나 이미 쓰였습니다. 새 링크를 요청하세요.');
    await page.getByRole('link', { name: '인증 메일 다시 받기' }).click();
    await expect(page.getByRole('status')).toHaveText('이메일 인증을 마쳤습니다.');
  });

  test(`재설정 요청·새 비밀번호·이전 비밀번호/링크 거부 (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const email = await createAccount(page);
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByRole('link', { name: '비밀번호를 잊었습니다' }).click();
    await mobileLayout(page);
    await page.getByRole('textbox', { name: '이메일', exact: true }).fill(email);
    const after = Date.now();
    await page.getByRole('button', { name: '재설정 메일 받기' }).click();
    await expect(page.getByRole('status')).toHaveText('등록된 주소라면 재설정 메일을 보냈습니다. 메일함을 확인하세요.');
    const link = await accountMailLink(email, '오픈삼국 비밀번호 재설정', after);
    await openMail(page, link);
    await mobileLayout(page);
    if (width === 375) await page.screenshot({ path: testInfo.outputPath('reset-password-375.png'), fullPage: true });
    const password = 'changed-e2e-password-20261028';
    await page.getByLabel('새 비밀번호', { exact: true }).fill(password);
    await page.getByLabel('새 비밀번호 확인', { exact: true }).fill('different-password');
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await expect(page.getByRole('alert')).toHaveText('두 비밀번호가 다릅니다.');
    await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(password);
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await expect(page.getByRole('status')).toHaveText('비밀번호를 바꿨습니다. 새 비밀번호로 로그인하세요.');
    await openMail(page, link);
    await page.getByLabel('새 비밀번호', { exact: true }).fill(password);
    await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(password);
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await expect(page.getByRole('alert')).toHaveText('링크가 만료됐거나 이미 쓰였습니다. 새 링크를 요청하세요.');
    await page.getByRole('link', { name: '로그인', exact: true }).click();
    await page.getByRole('textbox', { name: '이메일', exact: true }).fill(email);
    await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('이메일 또는 비밀번호가 맞지 않습니다');
    await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    await openMail(page, link);
    await page.getByLabel('새 비밀번호', { exact: true }).fill(password);
    await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(password);
    await page.getByRole('button', { name: '비밀번호 바꾸기' }).click();
    await expect(page.getByRole('alert')).toHaveText('링크가 만료됐거나 이미 쓰였습니다. 새 링크를 요청하세요.');
  });
}

test('토큰 없는 계정 경로는 로그인으로, 잘못된 링크는 재요청 경로로 보낸다', async ({ page }) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
  await page.goto('/verify-email');
  await expect(page).toHaveURL(/\/login\?next=%2Fverify-email$/);
  await page.goto('/reset-password#token=invalid');
  await expect(page.getByRole('alert')).toHaveText('재설정 링크를 확인하거나 새로 요청하세요.');
  expect(new URL(page.url()).hash === '').toBe(true);
  await page.getByRole('link', { name: '새 재설정 메일 받기' }).click();
  await expect(page.getByRole('heading', { name: '비밀번호 재설정' })).toBeVisible();
});

test('로그인 실패 한도의 실제 남은 시간을 안내한다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login');
  await mobileLayout(page);
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill('wrong-password-20261028');
  async function submit() {
    const response = page.waitForResponse(
      (value) => value.request().method() === 'POST' && new URL(value.url()).pathname.includes('auth.login'),
    );
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    return response;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await submit()).status()).toBe(401);
    await expect(page.getByRole('alert')).toHaveText('이메일 또는 비밀번호가 맞지 않습니다');
  }
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  const limited = await submit();
  expect(limited.status()).toBe(429);
  const retryAfter = Number(await limited.headerValue('retry-after'));
  expect(Number.isInteger(retryAfter) && retryAfter > 0).toBe(true);
  await expect(page.getByRole('alert')).toHaveText(`${retryAfter}초 뒤에 다시 요청하세요.`);
  await expect(page).toHaveURL('/login');
});
