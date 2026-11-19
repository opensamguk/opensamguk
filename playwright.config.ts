import { defineConfig, devices } from '@playwright/test';

// CI에서는 test.only가 있으면 실패하고 이미 떠 있는 서버 대신 이 checkout의 서버를 띄운다 (GitHub #26, #27).
const isCI = Boolean(process.env.CI);

// 먼저 `pnpm db:up`으로 DB를 띄운다. 로컬에서는 dev 서버가 이미 떠 있으면 그대로 쓴다.
export default defineConfig({
  testDir: 'e2e',
  testIgnore: [
    ...(isCI ? ['**/mobile-controls.spec.ts'] : []),
    '**/notifications.spec.ts',
    '**/public-assets.spec.ts',
    '**/account-access.spec.ts',
    '**/legal-consent.spec.ts',
    '**/account-withdrawal.spec.ts',
    '**/admin-sanction.spec.ts',
    '**/int18-city-resources.spec.ts',
    '**/san10-map.spec.ts',
    '**/admin-investigation.spec.ts',
    '**/admin-clock.spec.ts',
    '**/admin-end.spec.ts',
    '**/admin-create.spec.ts',
    '**/admin-create-profile.spec.ts',
    '**/admin-create-resources.spec.ts',
    '**/admin-reset.spec.ts',
    '**/t4-24-equipment.spec.ts',
    '**/t4-93-logistics.spec.ts',
    '**/t4-94-governance.spec.ts',
    '**/t4-95-lineage.spec.ts',
    '**/t4-96-heritage.spec.ts',
    '**/intel.spec.ts',
    '**/relations.spec.ts',
    '**/npc-entry-acceptance.spec.ts',
    '**/t2-07-nonaggression-expiry.spec.ts',
  ],
  forbidOnly: isCI,
  // CI 기계는 늘 켠 규칙의 엔진, Vite, 서버, DB를 함께 돌려 응답이 5초를 넘는 때가 있다(PR #674, 최대 5.4초).
  // 화면 확인의 기본 기다림을 CI에서만 10초로 둔다. 시험마다 늘려 둔 기다림은 그대로다.
  expect: { timeout: isCI ? 10_000 : 5_000 },
  use: { baseURL: 'http://127.0.0.1:5173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !isCI,
    timeout: 60_000,
    // CI에서는 감독과 엔진 자식의 출력을 기록에 남긴다. 엔진이 반복 종료되면 heartbeat에는 일반 문구만 남아 원인을 볼 수 없다.
    stdout: isCI ? 'pipe' : 'ignore',
  },
});
