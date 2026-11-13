import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { APPROVED_MAP_IMAGES } from '../../packages/shared/src/publicMapImages';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const fallbackSource = 'apps/web/src/portrait/fallback.svg';
const metadataName = 'public-build.json';
const imageExtension = /\.(?:png|jpe?g|webp|gif|svg|avif|ico|bmp|apng|tiff?)$/i;
const assetExtension = /\.(?:png|jpe?g|webp|gif|svg|avif|ico|bmp|apng|tiff?|woff2?|ttf|otf|[cm]?js|css)(?:[?#].*)?$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((x) => typeof x === 'string');

interface ApprovedImage {
  source: string;
  sha256: string;
}
interface Manifest {
  decision: string;
  portraitPolicy: string;
  remoteImageBases: string[];
  externalAssetOrigins: string[];
  portraitVariants: string[];
  bundledImages: ApprovedImage[];
  mapImages?: ApprovedImage[];
}
interface Metadata {
  schema: number;
  mode: string;
  imageBaseUrl: string;
  images: { file: string; source: string; sha256: string }[];
  files: Record<string, string>;
}

export class PublicAssetsError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`공개 자산 검사 실패\n${failures.join('\n')}`);
    this.name = 'PublicAssetsError';
  }
}

// 초상 정책은 둘 중 하나다. D-031: 공개 빌드는 실루엣만 쓴다. D-087: 공개 빌드도 승인한 base의 초상을 쓴다.
// D-087이면 remoteImageBases가 그 base 목록이다. 개별 주소 규칙은 portraitBaseFailures가 본다.
function portraitPolicyValid(value: Record<string, unknown>): boolean {
  if (!stringArray(value.remoteImageBases)) return false;
  if (value.decision === 'D-031' && value.portraitPolicy === 'fallback-only')
    return value.remoteImageBases.length === 0;
  return (
    value.decision === 'D-087' &&
    value.portraitPolicy === 'remote' &&
    value.remoteImageBases.length > 0 &&
    new Set(value.remoteImageBases).size === value.remoteImageBases.length
  );
}

function manifestFrom(value: unknown): Manifest {
  if (
    !record(value) ||
    !portraitPolicyValid(value) ||
    !stringArray(value.externalAssetOrigins) ||
    value.externalAssetOrigins.length !== 0 ||
    !stringArray(value.portraitVariants) ||
    value.portraitVariants.join(',') !== 'portrait,icon,thumb' ||
    !Array.isArray(value.bundledImages) ||
    value.bundledImages.length !== 1 ||
    !record(value.bundledImages[0]) ||
    value.bundledImages[0].source !== fallbackSource ||
    typeof value.bundledImages[0].sha256 !== 'string' ||
    !digestPattern.test(value.bundledImages[0].sha256) ||
    (value.mapImages !== undefined &&
      (!Array.isArray(value.mapImages) ||
        value.mapImages.length !== APPROVED_MAP_IMAGES.length ||
        !value.mapImages.every(
          (entry, index) =>
            record(entry) &&
            entry.source === APPROVED_MAP_IMAGES[index] &&
            typeof entry.sha256 === 'string' &&
            digestPattern.test(entry.sha256),
        )))
  ) {
    throw new PublicAssetsError([
      'manifest/public-assets.json: decision-policy: D-031·D-087의 공개 이미지 승인 목록이 아닙니다.',
    ]);
  }
  return value as unknown as Manifest;
}

function safeRelative(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

// 실루엣만 쓰는 정책이면 imageBaseUrl은 빈 값, D-087이면 manifest의 remoteImageBases 중 하나다.
function metadataFrom(value: unknown, imageBases: readonly string[] = []): Metadata {
  const allowedBases = imageBases.length ? imageBases : [''];
  if (
    !record(value) ||
    value.schema !== 1 ||
    value.mode !== 'public' ||
    typeof value.imageBaseUrl !== 'string' ||
    !allowedBases.includes(value.imageBaseUrl) ||
    !Array.isArray(value.images) ||
    !value.images.every(
      (x) =>
        record(x) &&
        typeof x.file === 'string' &&
        safeRelative(x.file) &&
        (x.source === fallbackSource || APPROVED_MAP_IMAGES.some((source) => source === x.source)) &&
        typeof x.sha256 === 'string' &&
        digestPattern.test(x.sha256),
    ) ||
    !record(value.files) ||
    Object.keys(value.files).length === 0 ||
    !Object.entries(value.files).every(
      ([name, sha]) =>
        safeRelative(name) && name !== metadataName && typeof sha === 'string' && digestPattern.test(sha),
    )
  ) {
    throw new PublicAssetsError([`${metadataName}: metadata: public 빌드의 파일·해시 기록이 아닙니다.`]);
  }
  return value as unknown as Metadata;
}

async function fileNames(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new PublicAssetsError([`${name}: symlink: 배포 파일 밖을 가리킬 수 없습니다.`]);
    if (entry.isDirectory()) names.push(...(await fileNames(root, name)));
    else if (entry.isFile()) names.push(name);
    else throw new PublicAssetsError([`${name}: file-type: 일반 파일이 아닙니다.`]);
  }
  return names.sort();
}

// 문서 링크와 XML 식별자는 네트워크 자원 승인 목록과 구분한다.
const nonResourceIdentifiers = new Set([
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/2000/xmlns/',
  // 알림 주소 입력란의 설명용 예시. 실제 webhook 주소를 허용하는 규칙이 아니다.
  'https://discord.com/api/webhooks/…',
  // Zod가 JSON Schema 문서의 $schema에 넣는 식별자이며 가져오는 주소가 아니다.
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-04/schema#',
  // 라우터가 window.origin을 쓰지 못할 때 URL을 해석하는 기준과 tRPC 오류 안내 링크다.
  'http://localhost',
  'https://github.com/trpc/trpc/issues/new',
]);

function constantString(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left),
      right = constantString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const middle = constantString(span.expression);
      if (middle === undefined) return undefined;
      value += middle + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function resourceProperty(node: ts.Node): boolean {
  let current = node;
  const resourceName = /^(?:src|srcset|href|data|poster)$/i;
  while (
    ts.isBinaryExpression(current.parent) ||
    ts.isTemplateSpan(current.parent) ||
    ts.isTemplateExpression(current.parent) ||
    ts.isParenthesizedExpression(current.parent)
  ) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = ts.isPropertyAccessExpression(parent.left)
        ? parent.left.name.text
        : ts.isElementAccessExpression(parent.left) && parent.left.argumentExpression
          ? constantString(parent.left.argumentExpression)
          : undefined;
      if (name && resourceName.test(name)) return true;
    }
    current = parent;
  }
  const parent = current.parent;
  if (ts.isPropertyAssignment(parent)) return resourceName.test(parent.name.getText().replace(/['"]/g, ''));
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isCallExpression(parent)) {
    if (
      parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      /^(?:fetch|importScripts)$/.test(parent.expression.getText())
    )
      return true;
    if (ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === 'setAttribute')
      return /^(?:src|href|srcset|poster)$/i.test(constantString(parent.arguments[0]!) ?? '');
  }
  return ts.isNewExpression(parent) && /^(?:Worker|SharedWorker|EventSource)$/.test(parent.expression.getText());
}

export function inspectAssetText(
  text: string,
  file: string,
  files: ReadonlySet<string>,
  approvedUrls: ReadonlySet<string> = new Set(),
): string[] {
  const failures = new Set<string>();
  const fail = (rule: string, detail: string) => failures.add(`${file}: ${rule}: ${detail.slice(0, 180)}`);
  const inspect = (value: string, resource = false) => {
    if (approvedUrls.has(value)) return;
    if (/data\s*:\s*image\//i.test(value)) fail('inline-image', value);
    if (/opensamguk-images|\/?portraits\//i.test(value)) {
      // 경로 틀 조각('/portraits/')은 값 전체가 같을 때만 승인이다. 다른 문자열 안에서 지우지 않는다.
      const remainder = [...approvedUrls]
        .filter((url) => /^https?:\/\//i.test(url))
        .reduce((text, url) => text.replaceAll(url, ''), value);
      if (/opensamguk-images|\/?portraits\//i.test(remainder)) fail('portrait-path', value);
    }
    if (resource && /^(?:data|blob|javascript|file|ftp):/i.test(value.trim())) fail('resource-scheme', value);
    const urls = [...value.matchAll(/https?:\/\/[^\s"'`<>)[\]{}\\]+/gi)].map((match) => match[0]);
    if (/^\/\/[a-z0-9[]/i.test(value.trim())) urls.push(value.trim().split(/[\s"'<>]/)[0]!);
    for (const url of urls) {
      if (approvedUrls.has(url)) continue;
      const documentation = url.startsWith('https://react.dev/errors/');
      if (
        !resource &&
        !assetExtension.test(url) &&
        !/portraits\//i.test(url) &&
        (nonResourceIdentifiers.has(url) || documentation)
      )
        continue;
      fail('external-url', url);
    }
    if (
      (resource || /^(?:\/?assets\/|\.{1,2}\/|\/)/i.test(value)) &&
      !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value) &&
      assetExtension.test(value)
    ) {
      const path = value.split(/[?#]/)[0]!;
      const target = posix.normalize(
        path.startsWith('/') ? path.slice(1) : files.has(path) ? path : posix.join(posix.dirname(file), path),
      );
      if (!files.has(target)) fail('missing-asset', value);
    }
  };
  if (/\.[cm]?js$/i.test(file)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      const value = constantString(node);
      if (value !== undefined) inspect(value, resourceProperty(node));
      if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) inspect(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else if (/\.css$/i.test(file)) {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const decode = (value: string) =>
      value
        .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/\\([^\r\n])/g, '$1');
    for (const match of clean.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)|@import\s*(['"])(.*?)\3/gi))
      inspect(decode(match[2] ?? match[4] ?? ''), true);
    const decoded = decode(clean);
    inspect(decoded, true);
    for (const match of decoded.matchAll(/(?<!:)\/\/[a-z0-9[][^\s"'<>)]*/gi)) inspect(match[0], true);
    if (/data\s*:\s*image\//i.test(clean)) fail('inline-image', 'data:image/');
  } else if (/\.html$/i.test(file)) {
    const clean = text.replace(/<!--[\s\S]*?-->/g, '');
    const decode = (value: string) =>
      value.replace(
        /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|quot|apos|colon|sol));/gi,
        (_all, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
          if (hex || decimal) return String.fromCodePoint(Number.parseInt(hex ?? decimal!, hex ? 16 : 10));
          return ({ amp: '&', quot: '"', apos: "'", colon: ':', sol: '/' } as Record<string, string>)[
            named!.toLowerCase()
          ]!;
        },
      );
    for (const style of clean.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
      for (const item of inspectAssetText(style[1]!, file + '.inline.css', files, approvedUrls)) failures.add(item);
    for (const style of clean.matchAll(/\bstyle\s*=\s*(['"])(.*?)\1/gi))
      for (const item of inspectAssetText(decode(style[2]!), file + '.inline.css', files, approvedUrls))
        failures.add(item);
    for (const tag of clean.matchAll(/<([a-z][a-z0-9:-]*)\b[^>]*>/gi)) {
      if (tag[1]!.toLowerCase() === 'base') fail('html-base', tag[0]);
      const attributes = [...tag[0].matchAll(/([^\s<>/="']+)\s*=\s*(?:(['"])(.*?)\2|([^\s>]+))/gi)];
      if (
        tag[1]!.toLowerCase() === 'meta' &&
        attributes.some(
          (attr) =>
            attr[1]!.toLowerCase() === 'http-equiv' &&
            decode(attr[3] ?? attr[4] ?? '')
              .trim()
              .toLowerCase() === 'refresh',
        )
      )
        fail('html-refresh', tag[0]);
      for (const attr of attributes) {
        const name = attr[1]!.toLowerCase();
        const value = decode(attr[3] ?? attr[4] ?? '');
        // XML 이름공간 선언은 자원 요청 주소가 아니다.
        if (/^xmlns(?::[a-z]+)?$/i.test(name) && nonResourceIdentifiers.has(value)) continue;
        inspect(value, true);
        if (/^(?:src|srcset|href|xlink:href|data|poster)$/.test(name))
          for (const part of value.split(/,\s*/)) inspect(part.trim().split(/\s+/)[0]!, true);
      }
    }
    for (const script of clean.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const item of inspectAssetText(script[1]!, `${file}.inline.js`, files, approvedUrls)) failures.add(item);
    }
    if (/data\s*:\s*image\//i.test(clean)) fail('inline-image', 'data:image/');
  }
  return [...failures];
}

// D-087 초상 base. https·고정 주소만 받고 CSP img-src에 그 origin이 있어야 한다.
// opensamguk-images 원본이면 움직이는 브랜치 대신 전체 커밋 SHA로 고정해야 한다.
const githubRawPortraitBase = /^https:\/\/raw\.githubusercontent\.com\/opensamguk\/opensamguk-images\/[0-9a-f]{40}$/;
export function portraitBaseFailures(bases: readonly string[], imageSources: readonly string[]): string[] {
  const failures: string[] = [];
  for (const base of bases) {
    let url: URL | undefined;
    try {
      url = new URL(base);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      url.protocol !== 'https:' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      base.endsWith('/') ||
      (url.hostname === 'raw.githubusercontent.com' && !githubRawPortraitBase.test(base))
    )
      failures.push(`manifest/public-assets.json: portrait-base: 고정한 https 초상 주소가 아닙니다: ${base}`);
    else if (!imageSources.includes(url.origin))
      failures.push(`deploy/security.caddy: portrait-csp: 초상 출처가 img-src에 없습니다: ${url.origin}`);
  }
  return failures;
}

async function checkExternalAssets(root: string, dist: string, raw: Record<string, unknown>) {
  const manifest = manifestFrom(raw);
  const failures: string[] = [];
  const revision = raw.imageRevision;
  const base = `https://raw.githubusercontent.com/opensamguk/opensamguk-images/${String(revision)}`;
  const svgBase = `https://rawcdn.githack.com/opensamguk/opensamguk-images/${String(revision)}`;
  if (
    typeof revision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    raw.imageBaseUrl !== base ||
    raw.svgImageBaseUrl !== svgBase
  )
    failures.push('manifest/public-assets.json: image-revision: 전체 커밋 SHA로 고정한 이미지 주소가 필요합니다.');
  const catalog: unknown = JSON.parse(
    await readFile(resolve(root, 'packages/shared/src/publicImageCatalog.json'), 'utf8'),
  );
  const expected = [...manifest.bundledImages, ...(manifest.mapImages ?? [])]
    .sort((a, b) => (a.source < b.source ? -1 : 1))
    .map((image) => ({
      source: image.source,
      url: `${image.source.endsWith('.svg') ? svgBase : base}/public/${image.source.replace(/^apps\/web\/src\//, '')}`,
      sha256: image.sha256,
    }));
  if (JSON.stringify(catalog) !== JSON.stringify(expected))
    failures.push('publicImageCatalog.json: image-catalog: 승인 목록·해시·주소가 다릅니다.');
  const metadata: unknown = JSON.parse(await readFile(resolve(dist, metadataName), 'utf8'));
  if (!record(metadata) || metadata.schema !== 2 || JSON.stringify(metadata.remoteImages) !== JSON.stringify(expected))
    failures.push('public-build.json: remote-images: 빌드의 원격 이미지 목록이 다릅니다.');
  if (!record(metadata)) throw new PublicAssetsError(failures);
  const portraitBases = manifest.portraitPolicy === 'remote' ? manifest.remoteImageBases : [];
  if (portraitBases.length && !portraitBases.includes(String(metadata.imageBaseUrl)))
    throw new PublicAssetsError([
      ...failures,
      'public-build.json: metadata: 빌드에 쓴 VITE_IMAGE_BASE_URL이 manifest의 remoteImageBases에 없습니다.',
    ]);
  const meta = metadataFrom({ ...metadata, schema: 1 }, portraitBases);
  if (meta.images.length) failures.push('public-build.json: image-set: 이미지 바이트는 게임 배포에 넣지 않습니다.');
  const decisions = await readFile(resolve(root, 'docs/product/decisions.md'), 'utf8');
  if (!/^## D-060[. ]/m.test(decisions)) failures.push('docs/product/decisions.md: missing-decision: D-060');
  if (manifest.decision === 'D-087' && !/^## D-087[. ]/m.test(decisions))
    failures.push('docs/product/decisions.md: missing-decision: D-087');
  const csp = await readFile(resolve(root, 'deploy/security.caddy'), 'utf8');
  const imageSources = [...csp.matchAll(/img-src\s+([^;"\r\n]+)/g)];
  if (
    imageSources.length !== 1 ||
    imageSources[0]![1]!.trim() !== "'self' https://raw.githubusercontent.com https://rawcdn.githack.com"
  )
    failures.push('deploy/security.caddy: image-csp: 승인한 이미지 출처 하나만 허용합니다.');
  failures.push(...portraitBaseFailures(portraitBases, imageSources[0]?.[1]?.trim().split(/\s+/) ?? []));
  const actual = (await fileNames(dist)).filter((name) => name !== metadataName);
  if (JSON.stringify(Object.keys(meta.files).sort()) !== JSON.stringify(actual))
    failures.push('public-build.json: file-set: 배포 파일 목록이 다릅니다.');
  if (!actual.includes('index.html')) failures.push('index.html: missing-entry: 공개 화면이 없습니다.');
  // D-087이면 초상 base와 경로 틀의 '/portraits/' 조각만 더 허용한다. 완성된 초상 주소 문자열은 여전히 거부한다.
  const urls = new Set([
    ...expected.map((image) => image.url),
    ...portraitBases,
    ...(portraitBases.length ? ['/portraits/'] : []),
  ]);
  for (const file of actual) {
    const bytes = await readFile(resolve(dist, file));
    if (imageExtension.test(file)) failures.push(`${file}: image-set: 로컬 이미지를 배포할 수 없습니다.`);
    else if (!/\.(?:html|[cm]?js|css|woff2?|ttf|otf)$/i.test(file)) failures.push(`${file}: unsupported-asset`);
    if (digest(bytes) !== meta.files[file]) failures.push(`${file}: file-hash: 빌드 뒤 바이트가 바뀌었습니다.`);
    if (/\.(?:html|[cm]?js|css)$/i.test(file))
      failures.push(...inspectAssetText(bytes.toString('utf8'), file, new Set(actual), urls));
  }
  if (failures.length) throw new PublicAssetsError([...new Set(failures)]);
  return {
    files: actual.length,
    images: 0,
    remoteImages: expected.length,
    portraitBases: portraitBases.length,
    decision: manifest.decision,
  };
}

export async function checkPublicAssets(options: { root?: string; dist?: string } = {}) {
  const root = options.root ?? projectRoot;
  const dist = options.dist ?? resolve(root, 'apps/web/dist');
  const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));
  const rawManifest = await readJson(resolve(root, 'manifest/public-assets.json'));
  if (record(rawManifest) && rawManifest.delivery === 'external') return checkExternalAssets(root, dist, rawManifest);
  const manifest = manifestFrom(rawManifest);
  // 이미지를 번들에 넣는 옛 방식은 img-src가 self뿐이라 원격 초상을 쓸 수 없다.
  if (manifest.portraitPolicy !== 'fallback-only')
    throw new PublicAssetsError([
      'manifest/public-assets.json: decision-policy: 원격 초상(D-087)은 외부 이미지 배포에서만 씁니다.',
    ]);
  const metadata = metadataFrom(await readJson(resolve(dist, metadataName)));
  const failures: string[] = [];
  const decisions = await readFile(resolve(root, 'docs/product/decisions.md'), 'utf8');
  if (!/^## D-031\./m.test(decisions)) failures.push('docs/product/decisions.md: missing-decision: D-031');
  const csp = await readFile(resolve(root, 'deploy/security.caddy'), 'utf8');
  const imageSources = [...csp.matchAll(/img-src\s+([^;"\r\n]+)/g)];
  if (imageSources.length !== 1 || imageSources[0]![1]!.trim() !== "'self'")
    failures.push('deploy/security.caddy: image-csp: img-src는 self만 허용합니다.');
  const approvedImages = [...manifest.bundledImages, ...(manifest.mapImages ?? [])];
  const approvedHashes = new Map<string, string>();
  for (const image of approvedImages) {
    const actualHash = digest(await readFile(resolve(root, image.source)));
    if (actualHash !== image.sha256) failures.push(`${image.source}: source-hash: 승인한 자산과 다릅니다.`);
    approvedHashes.set(image.source, image.sha256);
  }
  const names = await fileNames(dist),
    recorded = Object.keys(metadata.files).sort();
  const actual = names.filter((name) => name !== metadataName);
  if (JSON.stringify(recorded) !== JSON.stringify(actual))
    failures.push(`${metadataName}: file-set: 실제 배포 파일 목록과 다릅니다.`);
  if (!actual.includes('index.html')) failures.push('index.html: missing-entry: 공개 화면이 없습니다.');
  const images = actual.filter((name) => imageExtension.test(name));
  if (
    images.length !== approvedImages.length ||
    new Set(metadata.images.map((image) => image.source)).size !== approvedImages.length ||
    JSON.stringify(metadata.images.map((x) => x.file).sort()) !== JSON.stringify(images)
  )
    failures.push(`${metadataName}: image-set: 승인한 기본 SVG와 지도 자산 집합이 아닙니다.`);
  for (const name of actual) {
    const bytes = await readFile(resolve(dist, name));
    if (metadata.files[name] !== digest(bytes)) failures.push(`${name}: file-hash: 빌드 기록과 바이트가 다릅니다.`);
    if (!/\.(?:html|[cm]?js|css|woff2?|ttf|otf)$/i.test(name) && !imageExtension.test(name))
      failures.push(`${name}: unsupported-asset: 승인하지 않은 배포 파일 형식입니다.`);
    if (imageExtension.test(name)) {
      const entry = metadata.images.find((image) => image.file === name);
      const emittedBase = posix.basename(name);
      const sourceBase = entry ? posix.basename(entry.source) : '';
      const extension = posix.extname(sourceBase);
      const stem = sourceBase.slice(0, -extension.length);
      const suffix = emittedBase.slice(stem.length + 1, -extension.length);
      if (
        !entry ||
        !approvedHashes.has(entry.source) ||
        !emittedBase.startsWith(`${stem}-`) ||
        !emittedBase.endsWith(extension) ||
        !/^[A-Za-z0-9_-]{8,}$/.test(suffix) ||
        digest(bytes) !== approvedHashes.get(entry.source) ||
        entry.sha256 !== approvedHashes.get(entry.source)
      )
        failures.push(`${name}: image-hash: 승인한 기본 SVG나 지도 자산이 아닙니다.`);
    }
    if (/\.(?:html|[cm]?js|css)$/i.test(name))
      failures.push(...inspectAssetText(bytes.toString('utf8'), name, new Set(actual)));
  }
  if (failures.length) throw new PublicAssetsError([...new Set(failures)]);
  return { files: actual.length, images: images.length, decision: manifest.decision };
}

async function main() {
  try {
    const { values } = parseArgs({ options: { dist: { type: 'string' } } });
    const result = await checkPublicAssets(values.dist ? { dist: resolve(values.dist) } : {});
    const portraitBases = 'portraitBases' in result ? result.portraitBases : 0;
    console.log(
      `공개 자산 검사 통과: ${result.decision}, 파일 ${result.files}개, 승인 이미지 ${result.images}개, 초상 base ${portraitBases}개`,
    );
  } catch (error) {
    console.error(
      error instanceof PublicAssetsError
        ? error.message
        : '공개 자산 검사 실패: 승인 목록과 public 빌드 파일을 확인하세요.',
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
