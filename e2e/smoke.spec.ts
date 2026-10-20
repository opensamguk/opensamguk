import { expect, test } from '@playwright/test';

// AC-M1-02: 로컬 실행 뒤 로그인 화면이 열리고 서버·DB가 연결돼 있다.
test('로그인 화면이 열리고 서버와 DB가 정상이다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible();
  await expect(page.getByLabel('이메일')).toBeVisible();
  await expect(page.getByLabel('비밀번호')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('서버 정상 · DB 정상');
});
