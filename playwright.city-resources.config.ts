import { defineConfig, devices } from '@playwright/test';

// 실제 공개 dist와 자기 PostgreSQL·API는 legalStack이 준비한다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'int18-city-resources.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  // e2e/int18-city-resources.spec.ts의 CASE_BUDGET_MS와 같다.
  timeout: 900_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
