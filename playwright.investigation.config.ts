import { defineConfig, devices } from '@playwright/test';

// 실제 PG·API·공개 dist의 조사 인수는 공개 빌드를 만든 뒤 별도로 실행한다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'admin-investigation.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
