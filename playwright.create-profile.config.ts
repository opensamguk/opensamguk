import { defineConfig, devices } from '@playwright/test';

// 공개 dist·자기 실제 PG·API는 legalStack이 준비한다. 실행은 소스 독립 리뷰 뒤 별도 승인한다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'admin-create-profile.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
