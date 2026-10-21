// 루트 playwright.config.ts의 forbidOnly와 webServer.reuseExistingServer를 그대로 쓰고
// 시험 폴더와 서버 명령·주소만 격리된 것으로 바꾼다. tools/playwright-ci.test.ts가 실제 Playwright CLI로 실행한다.
import { defineConfig } from '@playwright/test';
import root from '../../playwright.config';

const port = Number(process.env.FIXTURE_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error('FIXTURE_PORT가 필요합니다.');
const url = `http://127.0.0.1:${port}`;

const rootServer = root.webServer;
if (!rootServer || Array.isArray(rootServer)) throw new Error('루트 설정의 webServer는 하나여야 합니다.');

export default defineConfig({
  ...root,
  testDir: 'specs',
  use: { ...root.use, baseURL: url },
  webServer: { ...rootServer, command: 'node server.mjs', url },
});
