import { expect, test } from '@playwright/test';
import { signUpByApi } from './account';

// T1-13: 주소마다 직접 접근·새로고침이 되고 위쪽 띠가 보인다. 게임 화면은 로그인이 필요하다 (T1-14).
// 없는 월드(1)라 데이터 칸은 안내를 보이지만 주소·머리글·메뉴는 그대로 열린다. 실제 데이터 화면은 main.spec.ts.
const GAME_PAGES: Array<[string, string]> = [
  ['/w/1', '메인'],
  ['/w/1?city=3', '메인'],
  ['/w/1/map', '지도'],
  ['/w/1/turns', '예턴 편집'],
  ['/w/1/city/1', '도시 정보'],
  ['/w/1/nation/2', '국가 정보'],
  ['/w/1/records', '기록 · 내 장수'],
  ['/w/1/records?tab=world', '기록 · 월드 정세'],
  ['/w/1/create', '장수 생성'],
];

test.describe('로그인한 상태', () => {
  test.beforeEach(async ({ page }) => {
    await signUpByApi(page);
  });

  for (const [path, heading] of GAME_PAGES) {
    test(`${path} 직접 접근과 새로고침`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole('navigation', { name: '게임 메뉴' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    });
  }

  test('메뉴로 이동하면 현재 메뉴가 표시된다', async ({ page }) => {
    await page.goto('/w/1');
    await page.getByRole('link', { name: '기록', exact: true }).click();
    await expect(page).toHaveURL(/\/w\/1\/records(\?tab=general)?$/);
    await expect(page.getByRole('link', { name: '기록', exact: true })).toHaveAttribute('aria-current', 'page');
  });
});

test('로그인 안 한 첫 주소는 로그인으로 보낸다', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/login');
});

test('없는 주소는 안내를 보여 준다', async ({ page }) => {
  await page.goto('/없는-주소');
  await expect(page.getByText('없는 주소입니다')).toBeVisible();
});

test('개발용 부품 모음이 열린다', async ({ page }) => {
  await page.goto('/dev/ui');
  await expect(page.getByRole('heading', { level: 1, name: 'UI 부품' })).toBeVisible();
});
