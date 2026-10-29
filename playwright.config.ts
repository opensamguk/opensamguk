import { defineConfig, devices } from '@playwright/test';

// CI에서는 test.only가 있으면 실패하고 이미 떠 있는 서버 대신 이 checkout의 서버를 띄운다 (GitHub #26, #27).
const isCI = Boolean(process.env.CI);

// 먼저 `pnpm db:up`으로 DB를 띄운다. 로컬에서는 dev 서버가 이미 떠 있으면 그대로 쓴다.
export default defineConfig({
  testDir: 'e2e',
  testIgnore: [
    '**/public-assets.spec.ts',
    '**/account-access.spec.ts',
    '**/legal-consent.spec.ts',
    '**/admin-sanction.spec.ts',
    '**/int18-city-resources.spec.ts',
    '**/admin-clock.spec.ts',
  ],
  forbidOnly: isCI,
  use: { baseURL: 'http://127.0.0.1:5173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
