import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { fileInventory, hashFile, safeSourcePath } from './release-artifact';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const absolute = z
  .string()
  .min(1)
  .refine(isAbsolute)
  .refine((value) => !/[\0\r\n]/.test(value));
export const preflightInput = z.strictObject({
  manifestPath: absolute,
  manifestSha256: digest,
  sourceRevision: revision,
  receiptDirectory: absolute,
});
const fingerprint = z.strictObject({
  sha256: digest,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const archive = fingerprint.extend({ path: z.string() });
const file = fingerprint.extend({ path: z.string() });
const releaseManifest = z.strictObject({
  version: z.literal(1),
  sourceRevision: revision,
  sourceTreeSha256: digest,
  sourceArchive: fingerprint,
  packageManager: z.literal('pnpm@10.33.0'),
  images: z
    .array(
      z.strictObject({
        target: z.enum(['server', 'engine', 'migrate']),
        id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        revision,
        sourceTreeSha256: digest,
      }),
    )
    .length(3),
  imageArchive: archive,
  web: z.strictObject({
    directory: z.literal('payload/web'),
    files: z.array(file).min(1),
    archive,
    imageBaseUrl: z.literal(''),
  }),
  migrations: z.array(fingerprint.extend({ name: z.string().regex(/^\d{14}_[a-z0-9_]+$/) })).min(1),
  resourcesSql: fingerprint,
  publicAssets: fingerprint.extend({ portraitPolicy: z.literal('fallback-only'), externalPortraits: z.literal(0) }),
  dataContract: z.literal('unknown'),
});
type Fingerprint = z.infer<typeof fingerprint>;
class PreflightError extends Error {
  constructor(readonly code: string) {
    super('릴리스 사전 확인을 마치지 못했습니다.');
  }
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new PreflightError(code);
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
};
async function plainDirectory(path: string) {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'DIRECTORY');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function checkedFile(root: string, name: string, expected: Fingerprint) {
  safeSourcePath(name);
  const path = resolve(root, name);
  requireCondition(inside(root, path), 'PATH');
  await plainDirectory(dirname(path));
  const actual = await hashFile(path);
  requireCondition(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, 'HASH');
}

// AC-M2-08 / AC-M3-10 일부. 파일만 확인하며 Docker·DB·서비스·current를 바꾸지 않는다.
export async function preflightRelease(value: unknown) {
  try {
    const parsed = preflightInput.parse(value);
    const input = {
      ...parsed,
      manifestPath: resolve(parsed.manifestPath),
      receiptDirectory: resolve(parsed.receiptDirectory),
    };
    const directory = dirname(input.manifestPath);
    requireCondition(input.manifestPath === join(directory, 'manifest.json'), 'MANIFEST');
    requireCondition(!inside(directory, resolve(input.receiptDirectory)), 'OUTPUT');
    await plainDirectory(directory);
    await plainDirectory(dirname(input.receiptDirectory));
    const manifestHash = await hashFile(input.manifestPath);
    requireCondition(manifestHash.sha256 === input.manifestSha256, 'MANIFEST');
    const bytes = await readFile(input.manifestPath);
    requireCondition(sha(bytes) === input.manifestSha256, 'MANIFEST');
    await checkedFile(directory, 'manifest.sha256', {
      bytes: Buffer.byteLength(input.manifestSha256 + '  manifest.json\n'),
      sha256: sha(Buffer.from(input.manifestSha256 + '  manifest.json\n')),
    });
    const manifest = releaseManifest.parse(JSON.parse(bytes.toString('utf8')));
    requireCondition(manifest.sourceRevision === input.sourceRevision, 'REVISION');
    requireCondition(new Set(manifest.images.map((image) => image.target)).size === 3, 'IMAGES');
    for (const image of manifest.images)
      requireCondition(
        image.revision === input.sourceRevision && image.sourceTreeSha256 === manifest.sourceTreeSha256,
        'IMAGES',
      );
    requireCondition(
      manifest.imageArchive.path === 'payload/images.tar' && manifest.web.archive.path === 'payload/web.tar',
      'PATH',
    );
    await checkedFile(directory, manifest.imageArchive.path, manifest.imageArchive);
    await checkedFile(directory, manifest.web.archive.path, manifest.web.archive);
    const web = join(directory, manifest.web.directory);
    await plainDirectory(web);
    const webFiles = await fileInventory(web);
    requireCondition(new Set(manifest.web.files.map((entry) => entry.path)).size === manifest.web.files.length, 'WEB');
    requireCondition(webFiles.length === manifest.web.files.length, 'WEB');
    for (const entry of manifest.web.files) await checkedFile(web, entry.path, entry);
    const metadata = JSON.parse(await readFile(join(web, 'public-build.json'), 'utf8')) as Record<string, unknown>;
    requireCondition(
      metadata.mode === 'public' &&
        metadata.imageBaseUrl === '' &&
        Array.isArray(metadata.images) &&
        metadata.images.length === 6,
      'PUBLIC',
    );

    // 현재 producer는 확정 payload 옆의 단 하나의 partial에 원본 archive/context를 보존한다.
    const partials = (await readdir(directory)).filter((name) =>
      /^\.partial-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name),
    );
    requireCondition(partials.length === 1, 'SOURCE');
    const partial = join(directory, partials[0]!);
    await plainDirectory(partial);
    await checkedFile(partial, 'source.tar', manifest.sourceArchive);
    const context = join(partial, 'context');
    await plainDirectory(context);
    const sourceFiles = await fileInventory(context),
      sourceHash = createHash('sha256');
    for (const entry of sourceFiles) {
      await checkedFile(context, entry.path, entry);
      sourceHash
        .update(entry.path + '\0')
        .update(await readFile(join(context, entry.path)))
        .update('\0');
    }
    requireCondition(sourceHash.digest('hex') === manifest.sourceTreeSha256, 'SOURCE');
    const migrations = join(context, 'packages/db/prisma/migrations');
    await plainDirectory(migrations);
    const actualNames = (await readdir(migrations)).filter((name) => /^\d{14}_/.test(name)).sort();
    requireCondition(
      JSON.stringify(actualNames) === JSON.stringify(manifest.migrations.map((entry) => entry.name)),
      'MIGRATIONS',
    );
    for (const migration of manifest.migrations)
      await checkedFile(migrations, migration.name + '/migration.sql', migration);
    await checkedFile(context, 'packages/db/sql/resources-init.sql', manifest.resourcesSql);
    await checkedFile(context, 'manifest/public-assets.json', manifest.publicAssets);
    const policy = JSON.parse(await readFile(join(context, 'manifest/public-assets.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    requireCondition(
      policy.portraitPolicy === 'fallback-only' &&
        Array.isArray(policy.remoteImageBases) &&
        policy.remoteImageBases.length === 0 &&
        Array.isArray(policy.externalAssetOrigins) &&
        policy.externalAssetOrigins.length === 0,
      'PUBLIC',
    );
    // 검증 중 manifest 교체도 성공 receipt로 확정하지 않는다.
    requireCondition((await hashFile(input.manifestPath)).sha256 === input.manifestSha256, 'MANIFEST');
    const receipt = {
      version: 1,
      runId: randomUUID(),
      outcome: 'artifact-preflight-passed',
      sourceRevision: input.sourceRevision,
      manifestSha256: input.manifestSha256,
      sourceTreeSha256: manifest.sourceTreeSha256,
      checkedAt: new Date().toISOString(),
      imageIds: manifest.images,
      webFiles: webFiles.length,
      migrations: manifest.migrations.length,
      dataContract: 'unknown',
      deploymentStarted: false,
      currentChanged: false,
      rollbackAuthorized: false,
    };
    await mkdir(input.receiptDirectory, { mode: 0o700 });
    const temporary = join(input.receiptDirectory, 'receipt.partial.json'),
      final = join(input.receiptDirectory, 'receipt.json');
    const receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
    await writeFile(temporary, receiptBytes, { flag: 'wx', mode: 0o600 });
    requireCondition((await readFile(temporary, 'utf8')) === receiptBytes, 'OUTPUT');
    // link는 이미 있는 final을 덮지 않으며 완성된 파일만 최종 이름으로 공개한다.
    await link(temporary, final);
    await unlink(temporary);
    return { receiptPath: final, receiptSha256: sha(Buffer.from(receiptBytes)) };
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError('INPUT_OR_IO');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    requireCondition(process.argv.length === 4 && process.argv[2] === '--preflight', 'MODE');
    requireCondition(isAbsolute(process.argv[3]!), 'INPUT');
    const result = await preflightRelease(JSON.parse(await readFile(process.argv[3]!, 'utf8')));
    console.log(JSON.stringify({ outcome: 'artifact-preflight-passed', receiptSha256: result.receiptSha256 }));
  } catch {
    console.error('릴리스 사전 확인을 마치지 못했습니다. 배포·복귀·current 변경은 실행하지 않았습니다.');
    process.exitCode = 1;
  }
}
