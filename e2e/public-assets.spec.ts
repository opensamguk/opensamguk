import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Response } from '@playwright/test';

// T3-13 · AC-M3-06 · D-031: 이미 만든 공개 dist(`pnpm build:public`)를 vite preview로 띄워 첫 화면과 로그인 화면의
// 네트워크 요청을 대조한다. 이 시험은 빌드하지 않는다. dist의 파일 바이트가 public-build.json과 같아야 시작한다.
// 기본 실행 설정(playwright.config.ts)의 webServer와 baseURL에 기대지 않는다. 공개 자산 전용 설정으로 따로 실행한다.
// /trpc·/sse는 화면이 열리기 전에 가로채 503으로 막는다. 실제 API·DB에 닿지 않으며 이 시험을 게임 API 검증으로 세지 않는다.
// 초상 표시는 공개 모드 화면 단위 시험(apps/web/src/portrait/public.test.tsx)이 맡는다. 여기서 이미지 요청이 없다는 것만으로
// Portrait가 기본 이미지를 그린다고 보지 않는다. 배출된 기본 SVG는 시험 안에서 직접 불러 응답 바이트만 확인한다.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const webDir = join(repoRoot, 'apps', 'web');
const distDir = resolve(process.env.PUBLIC_ASSETS_DIST || join(webDir, 'dist'));
const META_FILE = 'public-build.json';
const FALLBACK_SOURCE = 'apps/web/src/portrait/fallback.svg';
// M1 dev 서버·API와 초상 시험(portrait.spec.ts)이 쓰는 port. 겹치면 시작하지 않는다.
const RESERVED_PORTS = new Set([5173, 3001, 5181, 5182]);
const ASSET_TYPES = new Set(['document', 'script', 'stylesheet', 'font', 'image']);

interface PublicBuildMeta {
  schema: number;
  mode: string;
  imageBaseUrl: string;
  images: { file: string; source: string | null; sha256: string }[];
  files: Record<string, string>;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function previewPort(): number {
  const raw = process.env.PUBLIC_ASSETS_PREVIEW_PORT ?? '4197';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`PUBLIC_ASSETS_PREVIEW_PORT가 올바른 port가 아닙니다: ${raw}`);
  }
  if (RESERVED_PORTS.has(port)) throw new Error(`port ${port}는 다른 시험이 씁니다. 다른 값을 주세요.`);
  return port;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

// dist가 메타데이터를 만든 바로 그 빌드인지 바이트로 확인한다.
function readVerifiedMeta(): PublicBuildMeta {
  const meta = JSON.parse(readFileSync(join(distDir, META_FILE), 'utf8')) as PublicBuildMeta;
  expect(meta.schema).toBe(1);
  expect(meta.mode).toBe('public');
  expect(meta.imageBaseUrl).toBe('');
  const onDisk = listFiles(distDir)
    .map((path) => relative(distDir, path).split(sep).join('/'))
    .filter((file) => file !== META_FILE)
    .sort();
  expect(onDisk).toEqual(Object.keys(meta.files).sort());
  for (const file of onDisk) expect(sha256(readFileSync(join(distDir, file))), file).toBe(meta.files[file]);
  return meta;
}

// pnpm을 거치지 않고 Vite CLI를 이 Node로 직접 띄운다. 그래야 끝낼 때 이 PID 하나만 정확히 끈다.
function viteBin(): string {
  const pkgPath = createRequire(join(webDir, 'package.json')).resolve('vite/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: { vite: string } };
  return join(dirname(pkgPath), pkg.bin.vite);
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

let meta: PublicBuildMeta;
let origin = '';
let preview: ChildProcess | undefined;
let previewLog = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(90_000);
  meta = readVerifiedMeta();
  const port = previewPort();
  origin = `http://127.0.0.1:${port}`;
  // 이미 떠 있는 서버를 다시 쓰지 않는다.
  if (await answers(origin)) throw new Error(`${origin}에 이미 서버가 있습니다. 다른 port를 주세요.`);

  // port가 이미 쓰이면 다른 port로 옮기지 않고 끝나도록 --strictPort를 준다.
  const args = ['preview', '--mode', 'public', '--outDir', distDir, '--host', '127.0.0.1', '--port', String(port)];
  preview = spawn(process.execPath, [viteBin(), ...args, '--strictPort'], {
    cwd: webDir,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (chunk: Buffer) => {
    previewLog = (previewLog + chunk.toString()).slice(-4000);
  };
  preview.stdout?.on('data', keep);
  preview.stderr?.on('data', keep);

  const deadline = Date.now() + 60_000;
  while (!(await answers(`${origin}/`))) {
    const code = preview.exitCode;
    if (code !== null) throw new Error(`vite preview가 끝났습니다 (코드 ${code})\n${previewLog}`);
    if (Date.now() > deadline) throw new Error(`vite preview가 60초 안에 뜨지 않았습니다\n${previewLog}`);
    await new Promise((done) => setTimeout(done, 300));
  }
  // 띄운 서버가 이 dist를 내보내는지 index.html 바이트로 확인한다.
  const index = Buffer.from(await (await fetch(`${origin}/`)).arrayBuffer());
  expect(sha256(index)).toBe(meta.files['index.html']);
});

type Stopped = { ok: true; how: string } | { ok: false; why: string };

// 이 시험이 띄운 child PID 하나만 끈다. exit를 실제로 받아야 성공이고, 신호를 못 보냈거나 오류가 났거나
// 10초 안에 끝나지 않으면 정리 실패로 시험을 실패시킨다. 약속은 늘 resolve로 끝나 처리 안 된 거부를 남기지 않는다.
test.afterAll(async () => {
  const child = preview;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const stopped = await new Promise<Stopped>((done) => {
    const finish = (result: Stopped) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      done(result);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ ok: true, how: `code ${code}, signal ${signal}` });
    const onError = (error: Error) => finish({ ok: false, why: `오류 ${error.message}` });
    const timer = setTimeout(() => finish({ ok: false, why: '10초 안에 끝나지 않음' }), 10_000);
    child.once('exit', onExit);
    child.once('error', onError);
    if (!child.kill()) finish({ ok: false, why: '종료 신호를 보내지 못함' });
  });
  if (!stopped.ok) throw new Error(`vite preview(PID ${pid}) 정리 실패: ${stopped.why}\n${previewLog}`);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`vite preview(PID ${pid})의 exit를 받았지만 종료 상태가 비어 있습니다`);
  }
  console.log(`vite preview(PID ${pid}) 종료 확인: ${stopped.how}`);
});

interface Seen {
  external: string[];
  api: string[];
  assets: { path: string; type: string; status: number; sha256: string }[];
  pending: Promise<void>[];
}

// 화면을 열기 전에 길을 막는다. 나중에 등록한 route가 먼저 돈다.
async function watch(page: Page): Promise<Seen> {
  const seen: Seen = { external: [], api: [], assets: [], pending: [] };
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      seen.external.push(url.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  for (const pattern of ['**/trpc/**', '**/sse/**']) {
    await page.route(pattern, (route) => {
      seen.api.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'blocked by public-assets e2e' });
    });
  }
  page.on('response', (response: Response) => {
    const request = response.request();
    const url = new URL(request.url());
    if (url.origin !== origin || !ASSET_TYPES.has(request.resourceType())) return;
    if (url.pathname.startsWith('/trpc') || url.pathname.startsWith('/sse')) return;
    seen.pending.push(
      response.body().then((body) => {
        seen.assets.push({
          path: url.pathname,
          type: request.resourceType(),
          status: response.status(),
          sha256: sha256(body),
        });
      }),
    );
  });
  return seen;
}

// 문서 요청은 SPA라 어느 주소든 index.html이다. 나머지는 dist 파일 이름 그대로다.
const distKey = (path: string, type: string) => (type === 'document' ? 'index.html' : decodeURI(path.slice(1)));

function expectOnlyDistAssets(seen: Seen) {
  expect(seen.external, '같은 origin 밖으로 나간 요청').toEqual([]);
  for (const asset of seen.assets) {
    const key = distKey(asset.path, asset.type);
    expect(asset.path, '원작 초상 경로').not.toContain('/portraits/');
    expect(asset.status, asset.path).toBe(200);
    expect(meta.files[key], `${asset.path}가 dist 목록에 없음`).toBeDefined();
    expect(asset.sha256, `${asset.path} 바이트`).toBe(meta.files[key]);
    if (asset.type === 'image') expect(meta.images.map((image) => image.file)).toContain(key);
  }
}

test('dist는 기본 SVG·승인 지도 자산과 같은 origin 폰트만 묶는다', () => {
  const approved = JSON.parse(readFileSync(join(repoRoot, 'manifest/public-assets.json'), 'utf8')) as {
    mapImages: { source: string; sha256: string }[];
  };
  expect(meta.images).toHaveLength(1 + approved.mapImages.length);
  const fallback = meta.images.find((image) => image.source === FALLBACK_SOURCE);
  expect(fallback!.source).toBe(FALLBACK_SOURCE);
  expect(fallback!.sha256).toBe(sha256(readFileSync(join(repoRoot, FALLBACK_SOURCE))));
  expect(meta.files[fallback!.file]).toBe(fallback!.sha256);
  for (const image of approved.mapImages) {
    const emitted = meta.images.find((entry) => entry.source === image.source);
    expect(emitted?.sha256).toBe(image.sha256);
    expect(meta.files[emitted!.file]).toBe(sha256(readFileSync(join(repoRoot, image.source))));
  }
  // main.tsx가 읽는 Pretendard 글꼴은 빌드 파일로 함께 나간다.
  expect(Object.keys(meta.files).some((file) => file.endsWith('.woff2'))).toBe(true);
});

for (const path of ['/', '/login']) {
  test(`${path} 화면은 dist 안의 자산만 받고 원작 초상을 요청하지 않는다`, async ({ page }) => {
    const seen = await watch(page);
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    await expect(page.locator('#root > *').first()).toBeAttached();
    await Promise.all(seen.pending);

    expectOnlyDistAssets(seen);
    const types = new Set(seen.assets.map((asset) => asset.type));
    // 실제 받은 script의 해시를 위에서 대조한 뒤 초기 번들의 경계를 검사한다.
    const initialScripts = seen.assets
      .filter((asset) => asset.type === 'script')
      .map((asset) => readFileSync(join(distDir, distKey(asset.path, asset.type)), 'utf8'));
    expect(initialScripts.length).toBeGreaterThan(0);
    for (const script of initialScripts) {
      expect(script).not.toMatch(/관리자 콘솔|사용자 검색 결과|감사 조회 결과/);
      expect(script).not.toMatch(/\.admin\.(?:whoami|user|audit|sanction)|admin\.(?:whoami|user\.search|audit\.list)/);
    }
    expect(
      Object.keys(meta.files)
        .filter((file) => file.endsWith('.js'))
        .some((file) => readFileSync(join(distDir, file), 'utf8').includes('관리자 콘솔')),
    ).toBe(true);
    expect(types.has('script') && types.has('stylesheet')).toBe(true);
    const srcs = await page.locator('img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src') ?? ''));
    for (const src of srcs) expect(src).not.toMatch(/portraits|jsdelivr|^data:image/);
  });
}

test('배출된 기본 SVG를 브라우저가 같은 origin에서 읽는다', async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`${origin}/login`, { waitUntil: 'networkidle' });
  // 제품 화면을 더하지 않고 시험 안에서만 그림 하나를 읽는다. Portrait 렌더링의 증거로 쓰지 않는다.
  const width = await page.evaluate(
    async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img.naturalWidth;
    },
    `/${meta.images.find((image) => image.source === FALLBACK_SOURCE)!.file}`,
  );
  expect(width).toBeGreaterThan(0);
  await Promise.all(seen.pending);

  expectOnlyDistAssets(seen);
  expect(
    seen.assets.some(
      (asset) =>
        asset.type === 'image' &&
        asset.path === `/${meta.images.find((image) => image.source === FALLBACK_SOURCE)!.file}`,
    ),
  ).toBe(true);
});
