import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPublicAssets, inspectAssetText } from './check';
import { APPROVED_MAP_IMAGES } from '../../packages/shared/src/publicMapImages';

const original = new URL('./fixtures/fallback.svg', import.meta.url);
const fallback = 'apps/web/src/portrait/fallback.svg';
const emitted = 'assets/fallback-abcdefgh.svg';
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
let root: string;
let dist: string;
let svg: Buffer;
let manifest: {
  decision: string;
  portraitPolicy: string;
  remoteImageBases: string[];
  externalAssetOrigins: string[];
  portraitVariants: string[];
  bundledImages: { source: string; sha256: string }[];
  mapImages?: { source: string; sha256: string }[];
};

async function put(path: string, value: string | Uint8Array) {
  await mkdir(resolve(root, path, '..'), { recursive: true });
  await writeFile(resolve(root, path), value);
}
async function seal() {
  await put('manifest/public-assets.json', JSON.stringify(manifest));
  const files: Record<string, string> = {};
  const images: { file: string; source: string; sha256: string }[] = [];
  async function walk(prefix = '') {
    for (const entry of await readdir(resolve(dist, prefix), { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (name !== 'public-build.json') {
        files[name] = sha(await readFile(resolve(dist, name)));
        if (/\.(?:svg|png|webp)$/i.test(name)) {
          const source =
            [...manifest.bundledImages, ...(manifest.mapImages ?? [])].find((image) => image.sha256 === files[name])
              ?.source ?? fallback;
          images.push({ file: name, source, sha256: files[name]! });
        }
      }
    }
  }
  await walk();
  await put(
    'apps/web/dist/public-build.json',
    JSON.stringify({ schema: 1, mode: 'public', imageBaseUrl: '', images, files }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opensamguk-public-assets-'));
  dist = join(root, 'apps/web/dist');
  svg = await readFile(original);
  manifest = {
    decision: 'D-031',
    portraitPolicy: 'fallback-only',
    remoteImageBases: [],
    externalAssetOrigins: [],
    portraitVariants: ['portrait', 'icon', 'thumb'],
    bundledImages: [{ source: fallback, sha256: sha(svg) }],
  };
  await put(fallback, svg);
  await put('docs/product/decisions.md', '## D-031. 기본 SVG를 공개한다\n');
  await put('deploy/security.caddy', `Content-Security-Policy "img-src 'self'; font-src 'self'"\n`);
  await put(`apps/web/dist/${emitted}`, svg);
  await put(
    'apps/web/dist/index.html',
    '<script type="module" src="/assets/main.js"></script><link rel="stylesheet" href="/assets/main.css">',
  );
  await put(
    'apps/web/dist/assets/main.js',
    `const namespace = 'http://www.w3.org/2000/svg'; const fallback = '/${emitted}';`,
  );
  await put('apps/web/dist/assets/main.css', 'body { color: black }');
  await seal();
});

afterEach(async () => {
  const target = resolve(root),
    temporary = resolve(tmpdir());
  if (!target.startsWith(`${temporary}${sep}`) || !basename(target).startsWith('opensamguk-public-assets-'))
    throw new Error('시험 임시 경로를 확인하세요.');
  await rm(target, { recursive: true, force: true });
});

describe('공개 배포 파일 검사', () => {
  async function addMapImages() {
    manifest.mapImages = [];
    for (const source of APPROVED_MAP_IMAGES) {
      const bytes = Buffer.from(`unit fixture: ${source}`);
      const name = basename(source);
      const dot = name.lastIndexOf('.');
      await put(source, bytes);
      await put(`apps/web/dist/assets/${name.slice(0, dot)}-abcdefgh${name.slice(dot)}`, bytes);
      manifest.mapImages.push({ source, sha256: sha(bytes) });
    }
    await seal();
  }
  it('AC-INT-20 원본 해시가 맞는 도트 바탕과 출처를 남긴 생성 그림만 추가로 통과시킨다', async () => {
    await addMapImages();
    await expect(checkPublicAssets({ root })).resolves.toEqual({
      files: 4 + APPROVED_MAP_IMAGES.length,
      images: 1 + APPROVED_MAP_IMAGES.length,
      decision: 'D-031',
    });
  });
  it('AC-INT-10 지도 이미지의 원본·배출 바이트가 달라지면 거부한다', async () => {
    await addMapImages();
    const name = basename(APPROVED_MAP_IMAGES[0]);
    await put(`apps/web/dist/assets/${name.replace(/\.png$/, '')}-abcdefgh.png`, 'changed-image');
    await seal();
    await expect(checkPublicAssets({ root })).rejects.toThrow('image-hash');
  });
  it('AC-INT-10 지도 목록에 원작 초상이나 임의 경로를 추가하면 거부한다', async () => {
    await addMapImages();
    manifest.mapImages![0]!.source = 'private/portraits-supplement/11001.jpg';
    await seal();
    await expect(checkPublicAssets({ root })).rejects.toThrow('decision-policy');
  });
  it('승인 SVG와 같은 origin 자원만 있는 실제 파일 표본을 통과시킨다', async () => {
    await expect(checkPublicAssets({ root })).resolves.toEqual({ files: 4, images: 1, decision: 'D-031' });
  });
  it.each([
    ['decision', 'D-004'],
    ['portraitPolicy', 'remote'],
    ['remoteImageBases', ['https://unapproved.example']],
    ['externalAssetOrigins', ['https://unapproved.example']],
    ['portraitVariants', ['portrait']],
  ])('승인 계약을 바꾼 %s를 거부한다', async (key, value) => {
    await put('manifest/public-assets.json', JSON.stringify({ ...manifest, [key as string]: value }));
    await expect(checkPublicAssets({ root })).rejects.toThrow('decision-policy');
  });
  it('결정 기록이 없으면 거부한다', async () => {
    await put('docs/product/decisions.md', '## D-028. 다른 결정\n');
    await expect(checkPublicAssets({ root })).rejects.toThrow('missing-decision');
  });
  it('공개 메타데이터 없는 일반 빌드를 거부한다', async () => {
    await rm(join(dist, 'public-build.json'));
    await expect(checkPublicAssets({ root })).rejects.toThrow();
  });
  it.each([
    { mode: 'production' },
    { imageBaseUrl: 'https://unapproved.example' },
    { files: { '../outside.js': '0'.repeat(64) } },
  ])('틀린 public 빌드 기록을 거부한다: %j', async (patch) => {
    const meta: unknown = JSON.parse(await readFile(join(dist, 'public-build.json'), 'utf8'));
    await put('apps/web/dist/public-build.json', JSON.stringify({ ...(meta as object), ...patch }));
    await expect(checkPublicAssets({ root })).rejects.toThrow('metadata');
  });
  it('파일 집합에 빠진 script를 거부한다', async () => {
    await put('apps/web/dist/assets/late.js', 'console.log("late")');
    await expect(checkPublicAssets({ root })).rejects.toThrow('file-set');
  });
  it('빌드 뒤의 조각난 JS 변조도 해시로 거부한다', async () => {
    await put('apps/web/dist/assets/main.js', 'const p="ht";const q="tps:";const hidden=p+q+"//hidden.example/a.png";');
    await expect(checkPublicAssets({ root })).rejects.toThrow('file-hash');
  });
  it('같은 파일 이름의 다른 SVG를 거부한다', async () => {
    await put(`apps/web/dist/${emitted}`, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
    await seal();
    await expect(checkPublicAssets({ root })).rejects.toThrow('image-hash');
  });
  it('원본 SVG와 승인 digest가 달라도 거부한다', async () => {
    await put(fallback, '<svg/>');
    await expect(checkPublicAssets({ root })).rejects.toThrow('source-hash');
  });
  it('추가 로컬 그림을 거부한다', async () => {
    await put('apps/web/dist/assets/unapproved.png', 'not-an-approved-image');
    await seal();
    await expect(checkPublicAssets({ root })).rejects.toThrow('image-set');
  });
  it('불투명한 확장자의 배포 파일도 거부한다', async () => {
    await put('apps/web/dist/assets/picture.dat', 'unapproved');
    await seal();
    await expect(checkPublicAssets({ root })).rejects.toThrow('unsupported-asset');
  });
  it('배출 파일이 없는 URL을 거부한다', async () => {
    await put('apps/web/dist/assets/main.js', 'const image="/assets/missing.svg"');
    await seal();
    await expect(checkPublicAssets({ root })).rejects.toThrow('missing-asset');
  });
  it('이미지 CSP의 외부 주소와 data를 거부한다', async () => {
    await put('deploy/security.caddy', `Content-Security-Policy "img-src 'self' https://cdn.jsdelivr.net data:;"`);
    await expect(checkPublicAssets({ root })).rejects.toThrow('image-csp');
  });
});

describe('T2-15 AC-INT-20 외부 이미지 배포', () => {
  const revision = 'a'.repeat(40);
  const base = `https://raw.githubusercontent.com/opensamguk/opensamguk-images/${revision}`;
  const svgBase = `https://rawcdn.githack.com/opensamguk/opensamguk-images/${revision}`;
  let catalog: { source: string; url: string; sha256: string }[];
  beforeEach(async () => {
    catalog = [{ source: fallback, url: `${svgBase}/public/portrait/fallback.svg`, sha256: sha(svg) }];
    await rm(resolve(dist, emitted));
    await put('apps/web/dist/assets/main.js', `const fallback=${JSON.stringify(catalog[0]!.url)};`);
    await seal();
    const metadata = JSON.parse(await readFile(join(dist, 'public-build.json'), 'utf8')) as object;
    await put('apps/web/dist/public-build.json', JSON.stringify({ ...metadata, schema: 2, remoteImages: catalog }));
    await put('packages/shared/src/publicImageCatalog.json', JSON.stringify(catalog));
    await put(
      'manifest/public-assets.json',
      JSON.stringify({
        ...manifest,
        delivery: 'external',
        imageRevision: revision,
        imageBaseUrl: base,
        svgImageBaseUrl: svgBase,
      }),
    );
    await put('docs/product/decisions.md', '## D-031. 기본 SVG\n## D-060 이미지 분리\n');
    await put(
      'deploy/security.caddy',
      `Content-Security-Policy "img-src 'self' https://raw.githubusercontent.com https://rawcdn.githack.com;"`,
    );
  });
  it('이미지 없는 dist와 정확한 고정 커밋의 목록을 통과시킨다', async () => {
    await expect(checkPublicAssets({ root })).resolves.toMatchObject({ images: 0, remoteImages: 1 });
    const urls = new Set(catalog.map((image) => image.url));
    for (const [text, file] of [
      [`<img src="${catalog[0]!.url}">`, 'index.html'],
      [`x{mask:url('${catalog[0]!.url}')}`, 'main.css'],
    ])
      expect(inspectAssetText(text!, file!, new Set(), urls)).toEqual([]);
  });
  it.each(['main', 'a'.repeat(39)])('움직이는 참조나 짧은 SHA를 거부한다: %s', async (imageRevision) => {
    await put(
      'manifest/public-assets.json',
      JSON.stringify({
        ...manifest,
        delivery: 'external',
        imageRevision,
        imageBaseUrl: base,
        svgImageBaseUrl: svgBase,
      }),
    );
    await expect(checkPublicAssets({ root })).rejects.toThrow('image-revision');
  });
  it('목록 밖의 경로·원작 초상·다른 호스트와 승인 URL 뒤 경로를 거부한다', () => {
    const urls = new Set(catalog.map((image) => image.url));
    for (const url of [
      catalog[0]!.url + '/other.png',
      catalog[0]!.url.replace('/public/portrait/fallback.svg', '/portraits/icon/10001.webp'),
      catalog[0]!.url.replace('rawcdn.githack.com', 'other.example'),
    ])
      expect(inspectAssetText(`const x=${JSON.stringify(url)}`, 'main.js', new Set(), urls).length).toBeGreaterThan(0);
  });
  describe('D-087 공개 빌드 초상', () => {
    const portraitBase = `https://raw.githubusercontent.com/opensamguk/opensamguk-images/${'c'.repeat(40)}`;
    const portraitCode = (base: string) =>
      `const base=${JSON.stringify(base)};const url=(v,i)=>\`\${base}/portraits/\${v}/\${i}.webp\`;`;
    async function remote(patch: { manifest?: object; meta?: object; code?: string } = {}) {
      await put(
        'apps/web/dist/assets/main.js',
        `const fallback=${JSON.stringify(catalog[0]!.url)};${patch.code ?? portraitCode(portraitBase)}`,
      );
      await seal();
      const metadata = JSON.parse(await readFile(join(dist, 'public-build.json'), 'utf8')) as object;
      await put(
        'apps/web/dist/public-build.json',
        JSON.stringify({
          ...metadata,
          schema: 2,
          remoteImages: catalog,
          imageBaseUrl: portraitBase,
          ...patch.meta,
        }),
      );
      await put(
        'manifest/public-assets.json',
        JSON.stringify({
          ...manifest,
          decision: 'D-087',
          portraitPolicy: 'remote',
          remoteImageBases: [portraitBase],
          delivery: 'external',
          imageRevision: revision,
          imageBaseUrl: base,
          svgImageBaseUrl: svgBase,
          ...patch.manifest,
        }),
      );
      await put('docs/product/decisions.md', '## D-031. 기본 SVG\n## D-060 이미지 분리\n## D-087 공개 초상\n');
    }
    it('승인 base와 경로 틀만 있는 빌드를 통과시킨다', async () => {
      await remote();
      await expect(checkPublicAssets({ root })).resolves.toMatchObject({
        images: 0,
        portraitBases: 1,
        decision: 'D-087',
      });
    });
    it('빌드에 쓴 base가 승인 목록에 없으면 거부한다', async () => {
      await remote({ meta: { imageBaseUrl: 'https://raw.githubusercontent.com/other/other/main' } });
      await expect(checkPublicAssets({ root })).rejects.toThrow('metadata');
    });
    it.each([
      [`https://raw.githubusercontent.com/opensamguk/opensamguk-images/main`, 'portrait-base'],
      [`http://raw.githubusercontent.com/opensamguk/opensamguk-images/${'c'.repeat(40)}`, 'portrait-base'],
      [`${portraitBase}/`, 'portrait-base'],
      ['https://img.example.test/set', 'portrait-csp'],
    ])('고정·https·CSP 규칙에 어긋난 base를 거부한다: %s', async (bad, rule) => {
      await remote({ manifest: { remoteImageBases: [bad] }, meta: { imageBaseUrl: bad }, code: portraitCode(bad) });
      await expect(checkPublicAssets({ root })).rejects.toThrow(rule);
    });
    it('완성된 초상 주소 문자열과 목록 밖 base는 계속 거부한다', async () => {
      await remote({ code: `const a=${JSON.stringify(`${portraitBase}/portraits/icon/10001.webp`)};` });
      await expect(checkPublicAssets({ root })).rejects.toThrow('portrait-path');
      await remote({ code: portraitCode('https://raw.githubusercontent.com/opensamguk/opensamguk-images/main') });
      await expect(checkPublicAssets({ root })).rejects.toThrow('external-url');
    });
    it('D-087 결정 기록이 없으면 거부한다', async () => {
      await remote();
      await put('docs/product/decisions.md', '## D-031. 기본 SVG\n## D-060 이미지 분리\n');
      await expect(checkPublicAssets({ root })).rejects.toThrow('missing-decision');
    });
    it('이미지를 묶는 옛 배포 방식에는 원격 초상을 허용하지 않는다', async () => {
      await remote();
      await put(
        'manifest/public-assets.json',
        JSON.stringify({ ...manifest, decision: 'D-087', portraitPolicy: 'remote', remoteImageBases: [portraitBase] }),
      );
      await expect(checkPublicAssets({ root })).rejects.toThrow('decision-policy');
    });
  });
  it('승인 해시를 바꾼 목록과 추가 로컬 이미지를 거부한다', async () => {
    await put(
      'packages/shared/src/publicImageCatalog.json',
      JSON.stringify([{ ...catalog[0], sha256: 'b'.repeat(64) }]),
    );
    await put('apps/web/dist/assets/smuggled.png', 'image');
    await expect(checkPublicAssets({ root })).rejects.toThrow('image-catalog');
  });
});

describe('배포 문서의 자원 참조', () => {
  const files = new Set(['assets/fallback-abcdefgh.svg']);
  it.each([
    ['외부 그림', 'const a="https://outside.example/a.png"'],
    ['JS escape', String.raw`const a="https:\x2f\x2foutside.example/a.png"`],
    ['상수 연결', 'const a="ht"+"tps://outside.example/a.png"'],
    ['프로토콜 상대', 'const a="//outside.example/a.png"'],
    ['인라인 그림', 'const a="data:image/svg+xml;base64,AAAA"'],
    ['초상 변형', 'const a="/portraits/icon/10001.webp"'],
    ['원작 저장소', 'const a="https://cdn.jsdelivr.net/gh/peppone-choi/opensamguk-images@48163bd"'],
    ['문서 주소의 이미지', 'const a="https://react.dev/errors/a.png"'],
    ['문서 주소를 src로 사용', 'const a={src:"https://react.dev/errors/123"}'],
  ])('%s를 거부한다', (_name, input) => {
    expect(inspectAssetText(input, 'assets/main.js', files).length).toBeGreaterThan(0);
  });
  it('XML 식별자·오류 문서·입력 예시를 자원 승인과 구분한다', () => {
    expect(
      inspectAssetText(
        'const a="http://www.w3.org/2000/svg";const b="https://react.dev/errors/123";const c={placeholder:"https://discord.com/api/webhooks/…"};',
        'main.js',
        files,
      ),
    ).toEqual([]);
  });
  it.each([
    ['url(https://outside.example/a.png)', 'main.css'],
    [String.raw`x{background:url(https:\2f\2f outside.example/a.png)}`, 'main.css'],
    ['@import"//outside.example/font.css";', 'main.css'],
    ['<img src="//outside.example/a.png">', 'index.html'],
    ['<link rel="preload" as="image" href="https://outside.example/a.png">', 'index.html'],
    ['<img src="https:&#x2f;&#x2f;outside.example/a.png">', 'index.html'],
    ['<style>x{background:url(https://outside.example/a.png)}</style>', 'index.html'],
    ['<div style="background:url(https://outside.example/a.png)"></div>', 'index.html'],
    ['<img src="data:image/png;base64,AAAA">', 'index.html'],
  ])('CSS·HTML 자원 경로를 거부한다: %s', (input, file) => {
    expect(inspectAssetText(input, file, files).length).toBeGreaterThan(0);
  });
});

describe('실제 라이브러리의 비자원 식별자', () => {
  const identifiers = [
    'https://json-schema.org/draft/2020-12/schema',
    'http://json-schema.org/draft-07/schema#',
    'http://json-schema.org/draft-04/schema#',
    'http://localhost',
    'https://github.com/trpc/trpc/issues/new',
  ];
  it.each(identifiers)('식별자·안내 문구만 있는 %s는 통과한다', (url) => {
    expect(inspectAssetText('const identifier=' + JSON.stringify(url), 'main.js', new Set())).toEqual([]);
  });
  it.each(identifiers)('같은 문자열을 자원 src에 쓰면 거부한다: %s', (url) => {
    expect(
      inspectAssetText('const image={src:' + JSON.stringify(url) + '}', 'main.js', new Set()).length,
    ).toBeGreaterThan(0);
  });
  it('호스트 없는 슬래시 두 개는 네트워크 URL이 아니다', () => {
    expect(inspectAssetText('const separator="//"', 'main.js', new Set())).toEqual([]);
  });
});

describe('자원 문맥의 우회 주소', () => {
  it.each([
    ['<img src=//outside.example/a.png>', 'index.html'],
    ['<script src="data:text/javascript,alert(1)"></script>', 'index.html'],
    ['x{src:url(data:font/woff2;base64,AAAA)}', 'main.css'],
    ['x{background:url(unlisted.png)}', 'assets/main.css'],
    ['const image={src:"blob:null/unapproved"}', 'main.js'],
    ['<svg><image href="https://outside.example/picture" /></svg>', 'index.html'],
    ['<svg><use xlink:href="//outside.example/sprite#icon" /></svg>', 'index.html'],
    ['<input type=image src="https://outside.example/picture">', 'index.html'],
    ['<base href="/assets/">', 'index.html'],
    ['<meta content="0;url=/login" http-equiv="refresh">', 'index.html'],
    ['<custom-element picture="//outside.example/picture">', 'index.html'],
    ['x{background:image-set("https://outside.example/picture" 1x)}', 'main.css'],
    ['x{background:image-set("//outside.example/picture" 1x)}', 'main.css'],
    [String.raw`x{background:image-set("\68 ttps:\2f\2f outside.example/picture" 1x)}`, 'main.css'],
    ['element.src="http://localhost"', 'main.js'],
    ['element["href"]="https://react.dev/errors/123"', 'main.js'],
    ['element.src="http://www.w3.org/2000/svg"', 'main.js'],
  ])('승인 파일 밖의 자원을 거부한다: %s', (input, file) => {
    expect(inspectAssetText(input, file, new Set()).length).toBeGreaterThan(0);
  });
  it('SVG 이름공간 선언과 같은 origin 참조는 통과한다', () => {
    expect(
      inspectAssetText(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="/assets/fallback-abcdefgh.svg"/></svg>',
        'index.html',
        new Set(['assets/fallback-abcdefgh.svg']),
      ),
    ).toEqual([]);
  });
});
