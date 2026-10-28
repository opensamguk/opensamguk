import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// 기본 개발 호환 검사와 별도로 인증 필수인 실제 서버를 기동한다. CI shard1에서 반드시 실행한다.
export default defineConfig({
  ...base,
  testMatch: 'account-access.spec.ts',
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  use: { ...base.use, actionTimeout: 10_000, navigationTimeout: 15_000 },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { EMAIL_VERIFICATION_REQUIRED: '1' },
  },
});
