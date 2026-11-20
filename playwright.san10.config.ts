import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'san10-map.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  // 491명 NPC 한 달 정산, 수출, 재생이 늘 켠 규칙에서 무거워졌다(로컬 실측 월 62초, 수출 19초, 재생 17초).
  timeout: 180_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
