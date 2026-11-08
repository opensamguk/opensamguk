import { defineConfig, devices } from '@playwright/test';

// T4-90: 관리자 월드 생성 양식의 판 고르기. 공개 dist·자기 실제 PG·API는 legalStack이 준비한다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'admin-create-resources.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
