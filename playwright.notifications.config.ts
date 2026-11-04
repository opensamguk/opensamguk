import { defineConfig, devices } from '@playwright/test';
import { API_PORT, WEB_ORIGIN, WEB_PORT } from './tools/notifications-browser/fixture';

// 이 전용 구성의 서버는 실제 Discord 대신 자기 HTTP 수신기만 쓴다.
process.env.E2E_FAKE_WEBHOOK = '1';

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'notifications.spec.ts',
  forbidOnly: true,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/notifications',
  reporter: [['line'], ['./tools/notifications-browser/reporter.ts']],
  use: { baseURL: WEB_ORIGIN, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx tools/notifications-browser/server.ts',
      url: `http://127.0.0.1:${API_PORT}/notification-fixture-ready`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @opensamguk/web exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      env: { SERVER_PORT: String(API_PORT) },
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
