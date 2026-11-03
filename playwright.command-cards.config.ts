import { defineConfig, devices } from '@playwright/test';

// 각 파일이 자기 고정물의 DB·API·웹을 쓴다. 기존 개발 서버를 띄우거나 재사용하지 않는다.
// 도시 자원 판의 훈련·사기 union 갈래 회귀(int18-city-resources)는 고정물 계약(공개 빌드·10분 예산)이 달라
// 기존 전용 설정 playwright.city-resources.config.ts로 따로 실행한다 (T4-92).
export default defineConfig({
  testDir: 'e2e',
  testMatch: [
    'command-cards.spec.ts',
    'mobile-controls.spec.ts',
    'int19-retinue-orders.spec.ts',
    't4-97-game-ui.spec.ts',
    't4-93-logistics.spec.ts',
    't4-94-governance.spec.ts',
  ],
  testIgnore: [],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1', actionTimeout: 10_000, navigationTimeout: 15_000, trace: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
