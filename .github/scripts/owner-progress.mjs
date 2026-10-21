import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const out = process.env.OWNER_SNAPSHOT_DIR;
if (!out) throw new Error('OWNER_SNAPSHOT_DIR missing');
await mkdir(out, { recursive: true });
const lines = (await readFile(process.env.OWNER_WORLD_RESULT, 'utf8')).trim().split('\n');
const world = JSON.parse(lines.at(-1));
if (!world.worldId) throw new Error('real world creation receipt missing');
const browser = await chromium.launch();
const manifest = {
  sourceSha: 'eedd81504156474a2997a5f1abba191f433e4bf5',
  qaCommit: process.env.GITHUB_SHA,
  runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  at: new Date().toISOString(),
  realPostgresql: true,
  mockedRequests: false,
  worldCreated: true,
  worldId: world.worldId,
  screenshots: [],
  limitations:
    'Login/signup are functional. Main panels, world-selection UI, map and turn editor are placeholders in this source; these images are not six-screen gameplay acceptance.',
  pageErrors: [],
};
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'ko-KR' });
  page.on('pageerror', (e) => manifest.pageErrors.push(e.message));
  await page.goto('http://127.0.0.1:5173/login');
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('서버 정상 · DB 정상');
  await page.evaluate('document.fonts.ready');
  await page.screenshot({ path: `${out}/01-login-real-server.png`, fullPage: true });
  manifest.screenshots.push({
    file: '01-login-real-server.png',
    action: 'Opened login and observed real server/DB health',
    status: 'FUNCTIONAL',
  });
  await page.goto('http://127.0.0.1:5173/signup');
  await page.getByLabel('이메일', { exact: true }).fill(`snapshot-${randomBytes(6).toString('hex')}@example.test`);
  await page.getByLabel('비밀번호', { exact: true }).fill(randomBytes(24).toString('hex'));
  await page.getByRole('button', { name: '가입하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '참가할 월드', exact: true })).toBeVisible();
  manifest.signupViaRealUi = 'PASS';
  const response = await page.request.get('http://127.0.0.1:5173/trpc/world.list');
  if (!response.ok()) throw new Error(`real world.list HTTP ${response.status()}`);
  const worldList = await response.json();
  if (!JSON.stringify(worldList).includes(world.worldId)) throw new Error('created world missing from real world.list');
  manifest.realWorldList = 'PASS';
  await page.goto(`http://127.0.0.1:5173/w/${world.worldId}`);
  await expect(page.getByRole('heading', { name: '메인', exact: true })).toBeVisible();
  for (const panel of ['내 장수', '현재 도시', '소속 국가', '예턴 앞 5칸', '최근 기록']) {
    await expect(
      page.getByRole('region', { name: panel, exact: true }).getByText('T1-16에서 연결합니다', { exact: true }),
    ).toBeVisible();
  }
  await page.evaluate('document.fonts.ready');
  await page.screenshot({ path: `${out}/02-main-unconnected-panels.png`, fullPage: true });
  manifest.screenshots.push({
    file: '02-main-unconnected-panels.png',
    action: 'Real signup then authenticated main route of the created world',
    status: 'UNCONNECTED_UI_PLACEHOLDERS',
  });
  await page.getByRole('link', { name: '지도', exact: true }).click();
  await expect(page.getByRole('heading', { name: '지도', exact: true })).toBeVisible();
  await page.screenshot({ path: `${out}/03-map-not-implemented.png`, fullPage: true });
  manifest.screenshots.push({
    file: '03-map-not-implemented.png',
    action: 'Clicked actual map navigation; observed unfinished T1-16 placeholder',
    status: 'NOT_IMPLEMENTED_UI',
  });
  if (manifest.pageErrors.length) throw new Error('browser page errors recorded');
} finally {
  await browser.close();
  manifest.browserClosed = true;
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
}
