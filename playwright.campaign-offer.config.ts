import { defineConfig, devices } from '@playwright/test';

// 실제 다섯 사례만 공개 dist와 자기 PG/API 수명으로 실행한다. 기본 e2e와 중복하지 않는다.
process.env.CAMPAIGN_OFFER_CI_STACK = '1';
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'campaign-offer-fresh-read.actual.ts',
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: { trace: 'off', video: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
