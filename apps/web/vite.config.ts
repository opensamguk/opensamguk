import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolveApiTarget } from './apiTarget';
import { devPortraits } from './devPortraits';
import { APPROVED_MAP_IMAGES } from '@opensamguk/shared';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// 공개 빌드 (D-031, T3-13). `vite build --mode public`일 때만 아래가 적용된다. 일반 dev/build는 그대로다.
const PUBLIC_MODE = 'public';
const PUBLIC_BUILD_META = 'public-build.json';
const FALLBACK_SOURCE = 'apps/web/src/portrait/fallback.svg';
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg|avif|ico|bmp)$/i;

// 공개 빌드는 초상 base URL을 쓰지 않는다. 셸 환경과 .env 파일에서 읽힌 값을 모두 보고, 공백만 있는 값도 거부한다.
// 기본값으로 되돌리거나 무시하고 통과시키지 않는다.
function assertNoPublicImageBase(env: Record<string, string>) {
  for (const value of [process.env.VITE_IMAGE_BASE_URL, env.VITE_IMAGE_BASE_URL]) {
    if (value !== undefined && value !== '') {
      throw new Error(
        '공개 빌드(D-031)는 초상 base URL을 쓰지 않습니다. 셸 환경과 .env 파일의 VITE_IMAGE_BASE_URL을 비우고 다시 빌드하세요.',
      );
    }
  }
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

// 빌드가 디스크에 쓴 파일 전부를 다시 읽어 sha256을 남긴다. 검사 도구(tools/public-assets)가 이 목록을
// 실제 dist의 파일 집합·바이트와 대조한다. 메타 파일 자신은 넣지 않는다. 이름이나 내용을 짐작하지 않고 바이트로만 정한다.
function publicBuildMeta(): Plugin {
  let outDir = '';
  return {
    name: 'opensamguk:public-build-meta',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle: {
      order: 'post',
      async handler() {
        const imageSources = new Map<string, string>();
        for (const source of [FALLBACK_SOURCE, ...APPROVED_MAP_IMAGES])
          imageSources.set(sha256(await readFile(join(repoRoot, source))), source);
        const files: Record<string, string> = {};
        const images: { file: string; source: string | null; sha256: string }[] = [];
        for (const path of (await listFiles(outDir)).sort()) {
          const file = relative(outDir, path).split(sep).join('/');
          if (file === PUBLIC_BUILD_META) continue;
          const digest = sha256(await readFile(path));
          files[file] = digest;
          // 바이트가 기본 SVG와 같을 때만 출처를 적는다. 모르는 그림은 null로 남겨 검사가 걸러 내게 한다.
          if (IMAGE_FILE.test(file)) {
            images.push({ file, source: imageSources.get(digest) ?? null, sha256: digest });
          }
        }
        const meta = { schema: 1, mode: PUBLIC_MODE, imageBaseUrl: '', images, files };
        await writeFile(join(outDir, PUBLIC_BUILD_META), `${JSON.stringify(meta, null, 2)}\n`);
      },
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const apiTarget = resolveApiTarget(process.env, env);
  const isPublic = mode === PUBLIC_MODE;
  if (isPublic && command === 'build') assertNoPublicImageBase(env);
  return {
    plugins: isPublic ? [react(), publicBuildMeta()] : [react(), devPortraits(repoRoot)],
    // 환경변수는 루트 .env 하나로 모은다. 화면에는 VITE_로 시작하는 공개값만 들어간다.
    envDir: repoRoot,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/trpc': apiTarget,
        // 월드 SSE (T2-09). 응답을 묶지 않고 그대로 흘려보낸다.
        '/sse': apiTarget,
      },
    },
    // 공개 빌드는 기본 SVG도 data: 주소로 넣지 않고 파일로 내보낸다. 일반 빌드의 인라인 한도는 그대로다.
    ...(isPublic ? { build: { assetsInlineLimit: 0 } } : {}),
    // 공개 dist 미리보기는 API로 요청을 넘기지 않는다. 비우지 않으면 server.proxy를 그대로 물려받는다.
    ...(isPublic ? { preview: { proxy: {} } } : {}),
  };
});
