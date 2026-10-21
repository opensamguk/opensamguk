import { expect, test, type Page } from '@playwright/test';
import { newEmail, createAccount, TEST_PASSWORD } from './account';

// T1-14 · AC-M1-05: 화면으로 가입·로그인·로그아웃, 오류 문구, 로그인 가드.
// 주소는 문자열(baseURL 기준 전체 주소)로 비교한다. /\/w\/1$/ 같은 정규식은 /login?next=/w/1에도 맞는다.
// 가입 한도(같은 IP 1시간 10번) 안에서 화면 가입은 첫 시험과 중복 이메일 시험만 실제로 보낸다. 나머지 계정은 createAccount로 만든다.
async function fill(page: Page, email: string, password: string) {
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
}

test('가입 → 메인 → 로그아웃 → 로그인 → 메인', async ({ page }) => {
  const email = newEmail();
  await page.goto('/w/1');
  await expect(page).toHaveURL(/\/login\?next=/);

  await page.getByRole('link', { name: '가입하기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '가입' })).toBeVisible();
  await fill(page, email, TEST_PASSWORD);
  await page.getByRole('button', { name: '가입하기' }).click();
  await expect(page).toHaveURL('/w/1');
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL('/login');
  await page.goto('/w/1');
  await expect(page).toHaveURL(/\/login\?next=/);

  await fill(page, email, TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/w/1');
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
});

test('틀린 비밀번호는 안내한다', async ({ page }) => {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login');
  await fill(page, email, 'wrong-password-01');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('alert')).toHaveText('이메일 또는 비밀번호가 맞지 않습니다');
  await expect(page).toHaveURL('/login');
});

test('이미 가입된 이메일은 안내한다', async ({ page }) => {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/signup');
  await fill(page, email, TEST_PASSWORD);
  await page.getByRole('button', { name: '가입하기' }).click();
  await expect(page.getByRole('alert')).toHaveText('이미 가입된 이메일입니다');
});

test('입력 형식이 틀리면 보내기 전에 안내한다', async ({ page }) => {
  await page.goto('/signup');
  await fill(page, 'not-an-email', 'short');
  await page.getByRole('button', { name: '가입하기' }).click();
  await expect(page.getByText('이메일 형식이 맞지 않습니다')).toBeVisible();
  await expect(page.getByText('비밀번호는 10~128자입니다')).toBeVisible();
  await expect(page.getByLabel('이메일')).toHaveAttribute('aria-invalid', 'true');
});

test('로그아웃 상태에서 게임 주소 → 로그인 → 원래 주소로 복귀', async ({ page }) => {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/w/1/records?tab=world');
  await expect(page).toHaveURL(/\/login\?next=/);
  await fill(page, email, TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/w/1/records?tab=world');
  await expect(page.getByRole('heading', { level: 1, name: '기록 · 월드 정세' })).toBeVisible();
});

test('다른 사이트 주소는 next로 받지 않는다', async ({ page }) => {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login?next=//evil.example/');
  await fill(page, email, TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '참가할 월드' })).toBeVisible();
  expect(new URL(page.url()).host).toBe('127.0.0.1:5173');
});

test('Tab과 Enter만으로 로그인한다', async ({ page }) => {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login?next=/w/1');
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('이메일')).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('비밀번호', { exact: true })).toBeFocused();
  await page.keyboard.type(TEST_PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/w/1');
});

test('비밀번호 보이기 토글', async ({ page }) => {
  await page.goto('/login');
  const password = page.getByLabel('비밀번호', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await page.getByRole('button', { name: '보이기' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.goto('/signup');
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
});

// T1-14 Codex 리뷰 1: 가드가 캐시만 믿으면 다른 탭에서 로그아웃한 뒤에도 게임 화면으로 이동한다.
test('다른 탭에서 로그아웃하면 이 탭의 다음 이동도 로그인으로 간다', async ({ page, context }) => {
  await createAccount(page);
  await page.goto('/w/1');
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();

  const other = await context.newPage();
  await other.goto('/w/1');
  await other.getByRole('button', { name: '로그아웃' }).click();
  await expect(other).toHaveURL('/login');

  await page.getByRole('link', { name: '지도' }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/w/1/map');
});

test('세션이 서버에서 없어지면 다음 이동은 로그인으로 간다', async ({ page }) => {
  await createAccount(page);
  await page.goto('/w/1');
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  await page.context().clearCookies();
  await page.getByRole('link', { name: '예턴' }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
});

// T1-14 Codex 리뷰 2: 다시 시도는 실패 당시 값이 아니라 지금 화면의 값을 보낸다.
test('네트워크 실패 뒤 입력을 고치고 다시 시도하면 고친 값으로 로그인한다', async ({ page }) => {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login?next=/w/1');

  await page.route('**/trpc/auth.login*', (route) => route.abort(), { times: 1 });
  await fill(page, 'wrong-account@example.test', TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible();

  await page.getByLabel('이메일').fill(email);
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect(page).toHaveURL('/w/1');
});
