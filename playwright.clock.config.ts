import { defineConfig, devices } from '@playwright/test';

// 실제 공개 dist·전용 PostgreSQL·API·엔진을 쓰는 관리자 시계 화면 검사다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'admin-clock.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
