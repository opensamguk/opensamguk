import { defineConfig, devices } from '@playwright/test';

// 먼저 `pnpm db:up`으로 DB를 띄운다. dev 서버가 이미 떠 있으면 그대로 쓴다.
export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:5173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
