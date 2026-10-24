import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

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

function manifestFrom(value: unknown): Manifest {
  if (
    !record(value) ||
    value.decision !== 'D-031' ||
    value.portraitPolicy !== 'fallback-only' ||
    !stringArray(value.remoteImageBases) ||
    value.remoteImageBases.length !== 0 ||
    !stringArray(value.externalAssetOrigins) ||
    value.externalAssetOrigins.length !== 0 ||
    !stringArray(value.portraitVariants) ||
    value.portraitVariants.join(',') !== 'portrait,icon,thumb' ||
    !Array.isArray(value.bundledImages) ||
    value.bundledImages.length !== 1 ||
    !record(value.bundledImages[0]) ||
    value.bundledImages[0].source !== fallbackSource ||
    typeof value.bundledImages[0].sha256 !== 'string' ||
    !digestPattern.test(value.bundledImages[0].sha256)
  ) {
    throw new PublicAssetsError([
      'manifest/public-assets.json: decision-policy: D-031의 기본 SVG 승인 목록이 아닙니다.',
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

function metadataFrom(value: unknown): Metadata {
  if (
    !record(value) ||
    value.schema !== 1 ||
    value.mode !== 'public' ||
    value.imageBaseUrl !== '' ||
    !Array.isArray(value.images) ||
    !value.images.every(
      (x) =>
        record(x) &&
        typeof x.file === 'string' &&
        safeRelative(x.file) &&
        x.source === fallbackSource &&
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

export function inspectAssetText(text: string, file: string, files: ReadonlySet<string>): string[] {
  const failures = new Set<string>();
  const fail = (rule: string, detail: string) => failures.add(`${file}: ${rule}: ${detail.slice(0, 180)}`);
  const inspect = (value: string, resource = false) => {
    if (/data\s*:\s*image\//i.test(value)) fail('inline-image', value);
    if (/opensamguk-images|\/?portraits\//i.test(value)) fail('portrait-path', value);
    if (resource && /^(?:data|blob|javascript|file|ftp):/i.test(value.trim())) fail('resource-scheme', value);
    const urls = [...value.matchAll(/https?:\/\/[^\s"'`<>)[\]{}\\]+/gi)].map((match) => match[0]);
    if (/^\/\/[a-z0-9[]/i.test(value.trim())) urls.push(value.trim().split(/[\s"'<>]/)[0]!);
    for (const url of urls) {
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
    for (const match of decoded.matchAll(/\/\/[a-z0-9[][^\s"'<>)]*/gi)) inspect(match[0], true);
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
      for (const item of inspectAssetText(style[1]!, file + '.inline.css', files)) failures.add(item);
    for (const style of clean.matchAll(/\bstyle\s*=\s*(['"])(.*?)\1/gi))
      for (const item of inspectAssetText(decode(style[2]!), file + '.inline.css', files)) failures.add(item);
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
      for (const item of inspectAssetText(script[1]!, `${file}.inline.js`, files)) failures.add(item);
    }
    if (/data\s*:\s*image\//i.test(clean)) fail('inline-image', 'data:image/');
  }
  return [...failures];
}

export async function checkPublicAssets(options: { root?: string; dist?: string } = {}) {
  const root = options.root ?? projectRoot;
  const dist = options.dist ?? resolve(root, 'apps/web/dist');
  const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));
  const manifest = manifestFrom(await readJson(resolve(root, 'manifest/public-assets.json')));
  const metadata = metadataFrom(await readJson(resolve(dist, metadataName)));
  const failures: string[] = [];
  const decisions = await readFile(resolve(root, 'docs/product/decisions.md'), 'utf8');
  if (!/^## D-031\./m.test(decisions)) failures.push('docs/product/decisions.md: missing-decision: D-031');
  const csp = await readFile(resolve(root, 'deploy/security.caddy'), 'utf8');
  const imageSources = [...csp.matchAll(/img-src\s+([^;"\r\n]+)/g)];
  if (imageSources.length !== 1 || imageSources[0]![1]!.trim() !== "'self'")
    failures.push('deploy/security.caddy: image-csp: img-src는 self만 허용합니다.');
  const sourceHash = digest(await readFile(resolve(root, fallbackSource)));
  if (sourceHash !== manifest.bundledImages[0]!.sha256)
    failures.push(`${fallbackSource}: source-hash: 승인한 SVG와 다릅니다.`);
  const names = await fileNames(dist),
    recorded = Object.keys(metadata.files).sort();
  const actual = names.filter((name) => name !== metadataName);
  if (JSON.stringify(recorded) !== JSON.stringify(actual))
    failures.push(`${metadataName}: file-set: 실제 배포 파일 목록과 다릅니다.`);
  if (!actual.includes('index.html')) failures.push('index.html: missing-entry: 공개 화면이 없습니다.');
  const images = actual.filter((name) => imageExtension.test(name));
  if (images.length !== 1 || JSON.stringify(metadata.images.map((x) => x.file).sort()) !== JSON.stringify(images))
    failures.push(`${metadataName}: image-set: 기본 SVG 하나만 있어야 합니다.`);
  for (const name of actual) {
    const bytes = await readFile(resolve(dist, name));
    if (metadata.files[name] !== digest(bytes)) failures.push(`${name}: file-hash: 빌드 기록과 바이트가 다릅니다.`);
    if (!/\.(?:html|[cm]?js|css|woff2?|ttf|otf)$/i.test(name) && !imageExtension.test(name))
      failures.push(`${name}: unsupported-asset: 승인하지 않은 배포 파일 형식입니다.`);
    if (imageExtension.test(name)) {
      const entry = metadata.images.find((image) => image.file === name);
      const originalName = posix.basename(name).replace(/-[A-Za-z0-9_-]{8,}(?=\.[^.]+$)/, '');
      if (
        originalName !== 'fallback.svg' ||
        !entry ||
        entry.source !== fallbackSource ||
        digest(bytes) !== sourceHash ||
        entry.sha256 !== sourceHash
      )
        failures.push(`${name}: image-hash: 승인한 기본 SVG가 아닙니다.`);
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
    console.log(
      `공개 자산 검사 통과: ${result.decision}, 파일 ${result.files}개, 기본 SVG ${result.images}개, 외부 초상 0개`,
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
