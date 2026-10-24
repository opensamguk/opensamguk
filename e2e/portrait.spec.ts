import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page, type Route } from '@playwright/test';

// T1-17 · AC-M1-20: base URL 환경변수만 바꿔 띄운 두 화면의 초상 주소가 다르고, 못 불러온 초상은 기본 이미지로 바뀐다.
// 화면 하나에 base URL 하나가 박히므로 값을 달리한 Vite 서버 두 개를 직접 띄운다. 부품 모음(/dev/ui)은 로그인이 필요 없다.
// 이미지 요청은 page.route로 가로채 시험용 그림을 돌려준다. 실제 초상 파일과 외부 네트워크에 기대지 않는다.

const DEFAULT_BASE =
  'https://cdn.jsdelivr.net/gh/opensamguk/opensamguk-images@48163bd1ce8d54c54c94fb5484b05f9db9e50c62';
const ALT_BASE = 'http://images-b.opensamguk.test/set-b';

interface Server {
  name: string;
  port: number;
  env: string; // VITE_IMAGE_BASE_URL. 빈 값이면 기본값을 쓴다.
  base: string; // 화면이 써야 하는 base
  color: string;
  process?: ChildProcess;
}

const SERVERS: Server[] = [
  { name: 'A', port: 5181, env: '', base: DEFAULT_BASE, color: '#2f5f9e' },
  { name: 'B', port: 5182, env: ALT_BASE, base: ALT_BASE, color: '#8a5a2b' },
];

async function waitForServer(url: string, child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite 서버가 끝났습니다 (코드 ${child.exitCode})`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Vite 서버가 60초 안에 뜨지 않았습니다: ${url}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  for (const server of SERVERS) {
    server.process = spawn(
      'pnpm',
      ['--filter', '@opensamguk/web', 'exec', 'vite', '--port', String(server.port), '--strictPort'],
      { env: { ...process.env, VITE_IMAGE_BASE_URL: server.env }, detached: true, stdio: 'ignore' },
    );
  }
  for (const server of SERVERS) await waitForServer(`http://127.0.0.1:${server.port}/dev/ui`, server.process!);
});

test.afterAll(() => {
  for (const server of SERVERS) {
    if (server.process?.pid) process.kill(-server.process.pid, 'SIGTERM');
  }
});

// 어느 서버의 그림인지 보이도록 서버 이름과 경로를 그린 SVG를 돌려준다.
function serveFixture(page: Page, server: Server, missing: string[] = []) {
  return page.route(`${server.base}/portraits/**`, (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (missing.some((suffix) => path.endsWith(suffix))) return route.fulfill({ status: 404, body: 'not found' });
    const label = path.split('/').slice(-2).join('/');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 148 210"><rect width="148" height="210" fill="${server.color}"/><text x="74" y="96" font-size="48" fill="#fff" text-anchor="middle" font-family="sans-serif">${server.name}</text><text x="74" y="140" font-size="12" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });
}

const portraitSection = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Portrait' }) });

async function srcOf(page: Page, name: string, variant: string): Promise<string | null> {
  return page.locator(`[data-variant="${variant}"]`).getByRole('img', { name }).first().getAttribute('src');
}

async function expectLoaded(page: Page, name: string, variant: string) {
  const img = page.locator(`[data-variant="${variant}"][data-state="image"]`).getByRole('img', { name }).first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
}

test('base URL을 바꿔 띄운 두 화면은 초상 주소가 다르다', async ({ page }, testInfo) => {
  const seen: Record<string, string | null> = {};
  for (const server of SERVERS) {
    await serveFixture(page, server);
    await page.goto(`http://127.0.0.1:${server.port}/dev/ui`);
    await expect(page.getByTestId('image-base-url')).toHaveText(server.base);
    await portraitSection(page).scrollIntoViewIfNeeded(); // 초상은 loading="lazy"라 화면에 들어와야 받는다

    for (const variant of ['portrait', 'icon', 'thumb'] as const) {
      const ext = variant === 'portrait' ? 'png' : 'webp';
      expect(await srcOf(page, '정원', variant)).toBe(`${server.base}/portraits/${variant}/10002.${ext}`);
      await expectLoaded(page, '정원', variant);
    }
    // 초상 ID가 없거나 범위 밖이면 base와 상관없이 기본 이미지
    for (const name of ['유비', '관우', '장비']) {
      const frame = page.locator('[data-state]').filter({ has: page.getByRole('img', { name }) });
      await expect(frame).toHaveAttribute('data-state', 'fallback');
      expect(await frame.getByRole('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    }

    seen[server.name] = await srcOf(page, '정원', 'portrait');
    await portraitSection(page).screenshot({ path: testInfo.outputPath(`portrait-base-${server.name}.png`) });
    await page.unrouteAll();
  }
  expect(seen.A).not.toBe(seen.B);
});

test('못 불러온 초상은 기본 이미지로 바뀐다', async ({ page }, testInfo) => {
  const [server] = SERVERS;
  await serveFixture(page, server!, ['/icon/11000.webp']);
  await page.goto(`http://127.0.0.1:${server!.port}/dev/ui`);
  await portraitSection(page).scrollIntoViewIfNeeded();

  const frame = page.locator('[data-variant="icon"]').filter({ has: page.getByRole('img', { name: '공도' }) });
  await expect(frame).toHaveAttribute('data-state', 'fallback');
  await expect(frame).toHaveText('공');
  expect(await frame.getByRole('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  // 같은 화면의 다른 초상은 그대로 나온다
  await expectLoaded(page, '정원', 'icon');
  await portraitSection(page).screenshot({ path: testInfo.outputPath('portrait-missing-fallback.png') });
});
