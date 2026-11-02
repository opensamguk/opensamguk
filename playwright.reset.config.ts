import { defineConfig, devices } from '@playwright/test';

// 자기 실제 PostgreSQL·API·엔진·공개 dist에서 초기화 전용10건을 실행한다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'admin-reset.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
