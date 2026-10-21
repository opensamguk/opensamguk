import { expect, test } from '@playwright/test';

test('baseURL의 서버가 기대한 표식을 돌려준다', async ({ request }) => {
  const response = await request.get('/from-test');
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe(process.env.FIXTURE_EXPECT_TOKEN);
});
