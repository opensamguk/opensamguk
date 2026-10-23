import { expect, test } from '@playwright/test';
import { createAccount } from './account';
import { createGeneralByApi, e2eWorld, stubPortraits } from './game';

// T2-17 · AC-M2-11 도움말 도달 경로: 가이드 9개와 생성 명령 목록을 웹 화면 안에서 연다.
// 도움말 화면은 서버 API를 쓰지 않으므로 운영 빌드(vite preview)만 띄워도 돌 수 있다. 그때는 HELP_PREVIEW=1로
// 로그인과 월드가 필요한 게임 메뉴 시험을 건너뛴다.
const preview = Boolean(process.env.HELP_PREVIEW);

const GUIDES = [
  ['index', '시작하기'],
  ['general-and-city', '장수와 도시, 내정'],
  ['time-and-turns', '시간과 턴'],
  ['war-and-orders', '전쟁과 예턴 조합'],
  ['map-and-supply', '지도와 보급'],
  ['economy-and-diplomacy', '국가 재정과 외교'],
  ['nation-and-features', '국가 운영과 주요 기능'],
  ['glossary', '용어 사전'],
  ['commands-and-timing', '명령과 실행 시기'],
] as const;

test('로그인하지 않아도 가이드 9개가 목록에서 차례로 열린다', async ({ page }) => {
  await page.goto('/help');
  const nav = page.getByRole('navigation', { name: '가이드 목록' });
  for (const [doc, title] of GUIDES) {
    await nav.getByRole('link', { name: title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/help/${doc}$`));
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  }
});

test('문서 안 링크와 절 링크가 같은 화면 안에서 열린다', async ({ page }) => {
  await page.goto('/help/general-and-city');
  await page.getByTestId('help-article').getByRole('link', { name: '시간과 턴', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: '시간과 턴' })).toBeVisible();

  await page.goto('/help/time-and-turns');
  await page.getByTestId('help-article').getByRole('link', { name: '명령과 실행 시기' }).first().click();
  await expect(page).toHaveURL(/\/help\/commands-and-timing#/);
  await expect(page.locator('[id="3-실패-이유와-대처"]')).toBeInViewport();
});

test('생성 명령 목록과 그 분류 절 링크가 열린다', async ({ page }) => {
  await page.goto('/help/commands-and-timing');
  await page.getByTestId('help-article').getByRole('link', { name: '내정', exact: true }).first().click();
  await expect(page).toHaveURL(/\/help\/command-catalog\.generated#/);
  const article = page.getByTestId('help-article');
  // T2-16(Codex)의 생성 문서가 들어오기 전에는 준비 중 안내가 보인다. 들어오면 그 분류 절이 보여야 한다.
  const pending = article.getByText('명령 목록은 준비 중입니다');
  if (await pending.isVisible()) return;
  await expect(page.locator('[id="내정"]')).toBeInViewport();
});

test('게임 메뉴의 도움말이 시작하기를 연다', async ({ page }) => {
  test.skip(preview, '운영 빌드만 띄운 시험에는 로그인과 월드가 없다');
  await stubPortraits(page);
  await createAccount(page);
  const world = await e2eWorld(page);
  await createGeneralByApi(page, world);
  await page.goto(`/w/${world}`);
  await page.getByRole('navigation', { name: '게임 메뉴' }).getByRole('link', { name: '도움말' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '시작하기' })).toBeVisible();
});
