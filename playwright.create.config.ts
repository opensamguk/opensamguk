import { defineConfig, devices } from '@playwright/test';

// 실제 PG·HTTP·공개 dist 준비와 별도 실행 승인이 필요한 생성 전용 사례다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'admin-create.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
