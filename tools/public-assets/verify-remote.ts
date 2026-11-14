import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PUBLIC_IMAGES } from '../../packages/shared/src/publicImages';
import manifest from '../../manifest/public-assets.json' with { type: 'json' };
import { resolveImageBaseUrl } from '../../apps/web/src/portrait/imageBase';
import toolImages from '../../packages/shared/src/toolImageCatalog.json' with { type: 'json' };

/** 원격 CDN 바이트를 확인하며 게임 빌드는 네트워크 없이 검사한다. */
export async function verifyRemoteImages() {
  const base = resolveImageBaseUrl(undefined);
  const textures = manifest.textures.map(({ source, sha256 }) => ({ source, sha256, url: base + '/public/' + source }));
  const sprites = manifest.sprites.map(({ source, sha256 }) => ({ source, sha256, url: base + '/public/' + source }));
  const remaining = [...PUBLIC_IMAGES, ...toolImages, ...textures, ...sprites];
  let checked = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let image = remaining.shift(); image; image = remaining.shift()) {
        const response = await fetch(image.url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (
          !response.ok ||
          new URL(response.url).origin !== new URL(image.url).origin ||
          !response.headers.get('content-type')?.startsWith('image/') ||
          (/^map3d\/(textures|sprites)\//.test(image.source) &&
            response.headers.get('content-type') !== 'image/webp') ||
          response.headers.get('access-control-allow-origin') !== '*' ||
          createHash('sha256').update(bytes).digest('hex') !== image.sha256
        )
          throw new Error(`원격 이미지 바이트·형식·CORS가 다릅니다: ${image.source}`);
        checked++;
      }
    }),
  );
  return { checked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await verifyRemoteImages());
}
