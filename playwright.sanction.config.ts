import { defineConfig, devices } from '@playwright/test';

// 기존 전용 PG·실제 API·공개 dist fixture를 재사용한다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'admin-sanction.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
