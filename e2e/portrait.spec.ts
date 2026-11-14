import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Response, type Route } from '@playwright/test';
import { PUBLIC_IMAGES, publicImageUrl } from '../packages/shared/src/publicImages';

// T1-17 · AC-M1-20: base URL 환경변수만 바꿔 띄운 두 화면의 초상 주소가 다르고, 못 불러온 초상은 기본 이미지로 바뀐다.
// 화면 하나에 base URL 하나가 박히므로 값을 달리한 Vite 서버 두 개를 직접 띄운다. 부품 모음(/dev/ui)은 로그인이 필요 없다.
// 초상 요청은 page.route로 가로채 시험용 그림을 돌려준다. 실제 초상 파일과 외부 네트워크에 기대지 않는다.
// 기본 이미지는 공통 승인 목록의 고정 커밋 주소(T2-15)라 가로채지 않는다. 브라우저가 실제로 읽어 그린 바이트가 목록의 sha256과 같아야 한다.

const FALLBACK_SOURCE = 'apps/web/src/portrait/fallback.svg';
const FALLBACK_URL = publicImageUrl(FALLBACK_SOURCE);
const FALLBACK_SHA256 = PUBLIC_IMAGES.find((image) => image.source === FALLBACK_SOURCE)!.sha256;

const DEFAULT_BASE =
  'https://raw.githubusercontent.com/opensamguk/opensamguk-images/947cee861126310596c4342b5e785332d9644264';
const ALT_BASE = 'http://images-b.opensamguk.test/set-b';
const webDir = fileURLToPath(new URL('../apps/web/', import.meta.url));
const vitePackage = createRequire(join(webDir, 'package.json')).resolve('vite/package.json');
const viteBin = join(
  dirname(vitePackage),
  (JSON.parse(readFileSync(vitePackage, 'utf8')) as { bin: { vite: string } }).bin.vite,
);

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
    server.process = spawn(process.execPath, [viteBin, '--port', String(server.port), '--strictPort'], {
      cwd: webDir,
      env: { ...process.env, VITE_IMAGE_BASE_URL: server.env },
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  for (const server of SERVERS) await waitForServer(`http://127.0.0.1:${server.port}/dev/ui`, server.process!);
});

test.afterAll(async () => {
  await Promise.all(
    SERVERS.map(async (server) => {
      const child = server.process;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Vite ${server.name} 서버가 종료되지 않았습니다.`)), 10_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        if (!child.kill()) {
          clearTimeout(timer);
          reject(new Error(`Vite ${server.name} 종료 신호를 보내지 못했습니다.`));
        }
      });
    }),
  );
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

// 화면을 열기 전에 건다. 브라우저가 받은 기본 이미지 응답의 상태와 바이트 해시를 모은다.
function watchFallback(page: Page): Promise<{ status: number; sha256: string }>[] {
  const seen: Promise<{ status: number; sha256: string }>[] = [];
  page.on('response', (response: Response) => {
    if (response.url() !== FALLBACK_URL) return;
    seen.push(
      response.body().then((body) => ({
        status: response.status(),
        sha256: createHash('sha256').update(body).digest('hex'),
      })),
    );
  });
  return seen;
}

// 기본 이미지 칸은 승인 목록의 그 주소를 쓰고, 그 그림을 실제로 다 불러와 그렸다.
async function expectFallbackShown(frame: Locator) {
  await expect(frame).toHaveAttribute('data-state', 'fallback');
  const img = frame.getByRole('img');
  await expect(img).toHaveAttribute('src', FALLBACK_URL);
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0 && el.currentSrc), {
      timeout: 15_000,
    })
    .toBe(FALLBACK_URL);
}

async function expectFallbackBytes(seen: Promise<{ status: number; sha256: string }>[]) {
  expect(seen.length).toBeGreaterThan(0);
  for (const response of await Promise.all(seen)) expect(response).toEqual({ status: 200, sha256: FALLBACK_SHA256 });
}

test('base URL을 바꿔 띄운 두 화면은 초상 주소가 다르다', async ({ page }, testInfo) => {
  const seen: Record<string, string | null> = {};
  const fallbackResponses = watchFallback(page);
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
      await expectFallbackShown(page.locator('[data-state]').filter({ has: page.getByRole('img', { name }) }));
    }

    seen[server.name] = await srcOf(page, '정원', 'portrait');
    await portraitSection(page).screenshot({ path: testInfo.outputPath(`portrait-base-${server.name}.png`) });
    await page.unrouteAll();
  }
  expect(seen.A).not.toBe(seen.B);
  await expectFallbackBytes(fallbackResponses);
});

test('못 불러온 초상은 기본 이미지로 바뀐다', async ({ page }, testInfo) => {
  const [server] = SERVERS;
  await serveFixture(page, server!, ['/icon/11000.webp']);
  const fallbackResponses = watchFallback(page);
  await page.goto(`http://127.0.0.1:${server!.port}/dev/ui`);
  await portraitSection(page).scrollIntoViewIfNeeded();

  const frame = page.locator('[data-variant="icon"]').filter({ has: page.getByRole('img', { name: '공도' }) });
  await expectFallbackShown(frame);
  await expect(frame).toHaveText('공');
  // 같은 화면의 다른 초상은 그대로 나온다
  await expectLoaded(page, '정원', 'icon');
  await expectFallbackBytes(fallbackResponses);
  await portraitSection(page).screenshot({ path: testInfo.outputPath('portrait-missing-fallback.png') });
});
