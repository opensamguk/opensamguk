import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'san10-map.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
