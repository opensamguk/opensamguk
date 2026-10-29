import { randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test, expect, type LegalStack } from './legalFixture';
import { TEST_PASSWORD } from './account';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import type { LegalPolicy } from '../apps/server/src/legal/policy';
import { formalConsent } from './legalFormal';

const executions = new Set<Promise<unknown>>();
function track<T>(action: () => Promise<T>) {
  const pending = Promise.resolve().then(action);
  executions.add(pending);
  void pending.finally(() => executions.delete(pending)).catch(() => undefined);
  return pending;
}
async function settled() {
  while (executions.size) await Promise.allSettled([...executions]);
}

test('T3-03 AC-M3-02 이메일과 동의가 모두 필요하면 실제 계정 가드는 이메일을 먼저 요구한다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    await stack.restart(policy('email-first'), true);
    const user = await account(stack, page, false);
    const destination = '/w/' + randomUUID() + '?city=40';
    let writes = 0;
    page.on('request', (request) => {
      if (calls(request, 'legal.agree')) writes++;
    });
    await page.goto(stack.origin + destination);
    await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('next')).toBe(destination);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(await stack.db.consentRecord.count({ where: { userId: user.id } })).toBe(0);
    expect(writes).toBe(0);
  }));
test.beforeEach(settled);
test.afterEach(async ({ page }) => {
  const errors: unknown[] = [];
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await settled();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, '동의 시험 페이지 종료 또는 본문 정착 실패');
});
const policy = (tag: string): LegalPolicy => ({
  terms: {
    version: 'test-terms-' + tag,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    bodyText: '시험 이용약관 ' + tag + '\n<script>window.legalExecuted=true</script>',
  },
  privacy: {
    version: 'test-privacy-' + tag,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    bodyText: '시험 개인정보처리방침 ' + tag + '\n이메일과 동의 기록의 시험 본문입니다.',
  },
});
const calls = (request: Request, name: string) =>
  new URL(request.url()).pathname.split('/').at(-1)?.split(',').includes(name) ?? false;
async function credentials(page: Page, email: string) {
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
}
async function checkBoth(page: Page) {
  await page.getByRole('checkbox', { name: /^이용약관 / }).check();
  await page.getByRole('checkbox', { name: /^개인정보처리방침 / }).check();
}
async function mobile(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const small = await page.locator('main a,main button,main input,main summary').evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
      })
      .map((element) => element.tagName),
  );
  expect(small).toEqual([]);
}
let password: Promise<string> | undefined;
async function account(stack: LegalStack, page: Page, verified = true) {
  password ??= hashPassword(TEST_PASSWORD);
  const session = newSession(Date.now());
  const user = await stack.db.user.create({
    data: {
      email: `legal-${randomUUID()}@example.test`,
      passwordHash: await password,
      emailVerifiedAt: verified ? new Date() : null,
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
    select: { id: true, email: true },
  });
  await page
    .context()
    .addCookies([{ name: 'sid', value: session.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  return user;
}

test('T3-03 AC-M3-02 실제 운영 준비 상태는 화면 가입과 직접 입력을 막고 계정을 만들지 않는다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    const service = await stack.productionPending();
    const errors: unknown[] = [];
    try {
      const before = await stack.db.user.count();
      let signupRequests = 0;
      page.on('request', (request) => {
        if (calls(request, 'auth.signup')) signupRequests++;
      });
      await page.goto(stack.origin + '/signup');
      await credentials(page, `pending-${randomUUID()}@example.test`);
      await expect(page.getByText('승인된 본문을 준비하고 있습니다. 가입은 준비 뒤 열립니다.')).toBeVisible();
      await expect(page.getByRole('button', { name: '가입하기', exact: true })).toBeDisabled();
      await page.locator('form').evaluate((element) => (element as HTMLFormElement).requestSubmit());
      expect(signupRequests).toBe(0);
      const current = await page.request.get(service.origin + '/trpc/legal.current?batch=1&input=%7B%7D');
      expect((await current.json())[0].result.data).toMatchObject({ status: 'pending', signupRequiresPolicy: true });
      const direct = await page.request.post(service.origin + '/trpc/auth.signup', {
        headers: { Origin: 'https://legal-pending.example.test' },
        data: { email: `pending-direct-${randomUUID()}@example.test`, password: TEST_PASSWORD },
      });
      expect(direct.status()).toBe(503);
      expect(await stack.db.user.count()).toBe(before);
      expect(stack.messages.length).toBe(0);
    } catch (error) {
      errors.push(error);
    }
    try {
      await service.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, '운영 승인 대기 시험 또는 자기 API 종료 실패');
  }));

test('T3-03 AC-M3-02 두 체크와 공개 본문·375px·이메일 우선·실제 가입 동의 기록', ({ page, legalStack: stack }, info) =>
  track(async () => {
    await stack.restart(policy('signup'), true);
    const email = `signup-${randomUUID()}@example.test`;
    await page.goto(stack.origin + '/signup?next=%2Faccount');
    await credentials(page, email);
    const button = page.getByRole('button', { name: '가입하기', exact: true });
    await expect(button).toBeDisabled();
    await page.getByRole('checkbox', { name: /^이용약관 / }).check();
    await expect(button).toBeDisabled();
    await page.getByRole('checkbox', { name: /^개인정보처리방침 / }).check();
    await expect(button).toBeEnabled();
    for (const width of [375, 1280]) {
      await mobile(page, width);
      await page.screenshot({ path: info.outputPath(`signup-consent-${width}.png`), fullPage: true });
    }
    await button.click();
    await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
    const user = await stack.db.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, consents: { select: { docType: true, version: true } } },
    });
    expect(user.consents).toEqual(
      expect.arrayContaining([
        { docType: 'TERMS', version: 'test-terms-signup' },
        { docType: 'PRIVACY', version: 'test-privacy-signup' },
      ]),
    );
    expect(user.consents.length).toBe(2);
    const mail = stack.messages.find((message) => message.to === email);
    const link = mail?.text.match(/https?:\/\/[^\s]+/)?.[0];
    if (!link) throw new Error('자기 시험 인증 메일이 없습니다.');
    await page.goto(link);
    await expect(page.getByRole('status')).toHaveText('이메일 인증을 마쳤습니다.');
    await page.goto(stack.origin + '/account');
    await expect(page.getByText(/이용약관 test-terms-signup/)).toBeVisible();
    await page.goto(stack.origin + '/legal/terms');
    await expect(page.getByRole('heading', { name: '이용약관', exact: true })).toBeVisible();
    await expect(page.getByText('<script>window.legalExecuted=true</script>', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => Object.hasOwn(window, 'legalExecuted'))).toBe(false);
    for (const width of [375, 1280]) await mobile(page, width);
  }));

test('T3-03 AC-M3-02 체크 뒤 새 판을 발행하면 가입 전 재확인으로 입력을 보존하고 요청을 보내지 않는다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    await stack.restart(policy('before'));
    const email = `changed-${randomUUID()}@example.test`;
    let requests = 0;
    page.on('request', (request) => {
      if (calls(request, 'auth.signup')) requests++;
    });
    await page.goto(stack.origin + '/signup');
    await credentials(page, email);
    await checkBoth(page);
    await expect(page.getByRole('button', { name: '가입하기', exact: true })).toBeEnabled();
    await stack.restart(policy('after'));
    await page.locator('form').evaluate((element) => (element as HTMLFormElement).requestSubmit());
    await expect(page.getByRole('alert')).toHaveText('현재 문서가 바뀌었습니다. 새 본문을 확인하고 다시 동의하세요.');
    expect(requests).toBe(0);
    await expect(page.getByRole('checkbox', { name: /^이용약관 / })).not.toBeChecked();
    await expect(page.getByLabel('이메일', { exact: true })).toHaveValue(email);
    await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue(TEST_PASSWORD);
    await checkBoth(page);
    await page.getByRole('button', { name: '가입하기', exact: true }).click();
    await expect(page).toHaveURL(stack.origin + '/lobby');
    const saved = await stack.db.consentRecord.findMany({
      where: { user: { email } },
      select: { docType: true, version: true },
    });
    expect(saved).toHaveLength(2);
    expect(saved.every((record) => record.version.endsWith('-after'))).toBe(true);
    expect(requests).toBe(1);
  }));

test('T3-03 AC-M3-02 일부 동의 뒤 실제 전송 실패는 남은 문서만 수동 재시도하고 중복 기록을 만들지 않는다', ({
  page,
  legalStack: stack,
}, info) =>
  track(async () => {
    await stack.restart(policy('partial'));
    const user = await account(stack, page);
    await page.goto(stack.origin + '/legal/agree?next=%2Faccount');
    await checkBoth(page);
    let blocked = false;
    await page.route('**/trpc/legal.agree*', async (route) => {
      if (route.request().method() === 'POST' && route.request().postData()?.includes('PRIVACY')) {
        blocked = true;
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: '동의하고 계속하기' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      '완료한 동의는 기록에 남습니다. 현재 계정과 남은 문서를 확인한 뒤 다시 동의하세요.',
    );
    expect(blocked).toBe(true);
    expect(await stack.db.consentRecord.count({ where: { userId: user.id, docType: 'TERMS' } })).toBe(1);
    expect(await stack.db.consentRecord.count({ where: { userId: user.id, docType: 'PRIVACY' } })).toBe(0);
    await expect(page.getByRole('checkbox', { name: /^이용약관 / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '동의하고 계속하기' })).toBeDisabled();
    await page.unroute('**/trpc/legal.agree*');
    await page.getByRole('checkbox', { name: /^개인정보처리방침 / }).check();
    await mobile(page, 375);
    await page.screenshot({ path: info.outputPath('remaining-consent-375.png'), fullPage: true });
    await page.getByRole('button', { name: '동의하고 계속하기' }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(page).toHaveURL(stack.origin + '/account');
    expect(await stack.db.consentRecord.count({ where: { userId: user.id } })).toBe(2);
  }));

test('T3-03 AC-M3-02 마지막 실제 신원 응답 뒤 계정을 바꾸면 새 계정 동의는 0건이다', ({ page, legalStack: stack }) =>
  track(async () => {
    await stack.restart(policy('identity'));
    const first = await account(stack, page);
    await page.goto(stack.origin + '/legal/agree');
    await checkBoth(page);
    const second = await stack.db.user.create({
      data: {
        email: `other-${randomUUID()}@example.test`,
        passwordHash: await (password ??= hashPassword(TEST_PASSWORD)),
        emailVerifiedAt: new Date(),
      },
      select: { id: true, email: true },
    });
    let release!: () => void, arrived!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve)),
      observed = new Promise<void>((resolve) => (arrived = resolve));
    const jobs = new Set<Promise<void>>();
    const errors: unknown[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    await page.route('**/trpc/auth.me*', (route) => {
      const job = (async () => {
        if (held) {
          await route.continue();
          return;
        }
        held = true;
        const response = await route.fetch();
        arrived();
        await released;
        await route.fulfill({ response });
      })();
      jobs.add(job);
      void job.then(
        () => jobs.delete(job),
        (error) => {
          jobs.delete(job);
          errors.push(error);
        },
      );
      return job;
    });
    const denied = page.waitForResponse(
      (response) => response.request().method() === 'POST' && calls(response.request(), 'legal.agree'),
      { timeout: 10_000 },
    );
    void denied.catch(() => undefined);
    try {
      await page.getByRole('button', { name: '동의하고 계속하기' }).click();
      await Promise.race([
        observed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('자기 실제 me 응답을 관측하지 못했습니다.')), 10_000);
        }),
      ]);
      const login = await page.context().request.post(stack.origin + '/trpc/auth.login', {
        headers: { Origin: stack.origin },
        data: { email: second.email, password: TEST_PASSWORD },
      });
      expect(login.status()).toBe(200);
      release();
      expect((await denied).status()).toBe(401);
      await expect(page.getByRole('checkbox', { name: /^이용약관 / })).not.toBeChecked();
      await expect
        .poll(() => stack.db.consentRecord.count({ where: { userId: { in: [first.id, second.id] } } }))
        .toBe(0);
      await expect(page.getByRole('button', { name: '동의하고 계속하기' })).toBeDisabled();
      expect(await stack.db.consentRecord.count({ where: { userId: first.id } })).toBe(0);
      expect(await stack.db.consentRecord.count({ where: { userId: second.id } })).toBe(0);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
      release();
      while (jobs.size) {
        await Promise.allSettled([...jobs]);
      }
      const result = await Promise.allSettled([denied]);
      if (result[0]!.status === 'rejected') errors.push(result[0]!.reason);
      await page.unroute('**/trpc/auth.me*');
    }
    if (errors.length) throw new AggregateError(errors, '실제 계정 교체 시험 또는 요청 정착 실패');
  }));

test('T3-03 AC-M3-02 본문 부재·실제 조회 실패는 가입 요청0이며 조회 복구는 입력을 보존한다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    const metadata = {
      terms: { version: 'test-metadata-terms', effectiveAt: '2026-01-01T00:00:00.000Z' },
      privacy: { version: 'test-metadata-privacy', effectiveAt: '2026-01-01T00:00:00.000Z' },
    };
    await stack.restart(metadata);
    let requests = 0;
    page.on('request', (request) => {
      if (calls(request, 'auth.signup')) requests++;
    });
    await page.goto(stack.origin + '/signup');
    const email = `read-error-${randomUUID()}@example.test`;
    await credentials(page, email);
    await expect(page.getByRole('button', { name: '가입하기', exact: true })).toBeDisabled();
    await page.locator('form').evaluate((element) => (element as HTMLFormElement).requestSubmit());
    expect(requests).toBe(0);
    await stack.restart(policy('read-error'));
    await page.route('**/trpc/legal.current*', (route) => route.abort('failed'));
    await page.reload();
    await credentials(page, email);
    await expect(page.getByText('현재 문서를 읽지 못했습니다.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '가입하기', exact: true })).toBeDisabled();
    expect(requests).toBe(0);
    await page.unroute('**/trpc/legal.current*');
    await page.getByRole('button', { name: '문서 다시 조회' }).click();
    await expect(page.getByRole('checkbox', { name: /^이용약관 / })).toBeVisible();
    await expect(page.getByLabel('이메일', { exact: true })).toHaveValue(email);
    await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue(TEST_PASSWORD);
    expect(requests).toBe(0);
  }));

test('T3-03 AC-M3-02 정식191 두 월드·사람30칸·실제403 뒤 재동의와 같은 월드 초안 복구', ({
  page,
  legalStack: stack,
}, info) =>
  track(async () => {
    test.setTimeout(150_000);
    await formalConsent(page, stack, info, { policy, account, checkBoth, mobile });
  }));
