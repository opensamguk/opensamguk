import { defineConfig, devices } from '@playwright/test';

// 공개 빌드를 자기 API·전용 PG에 연결하는 fixture가 서비스를 직접 기동한다.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'legal-consent.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
