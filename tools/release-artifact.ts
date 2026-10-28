import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const releaseInput = z.strictObject({
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  outputDirectory: z
    .string()
    .min(1)
    .refine(isAbsolute)
    .refine((value) => !/[,"\r\n]/.test(value)),
  dockerExecutable: z.string().min(1).refine(isAbsolute),
});
function requireCondition(value: unknown): asserts value {
  if (!value) throw new Error('릴리스 산출물 조건을 확인하세요.');
}
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
};
export function safeSourcePath(path: string) {
  requireCondition(path && !path.startsWith('/') && !/[\\:\r\n]/.test(path) && !path.includes(String.fromCharCode(0)));
  requireCondition(path.split('/').every((part) => part && part !== '.' && part !== '..'));
  return path;
}
async function git(cwd: string, args: string[]) {
  return (await run('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
}
export async function hashFile(path: string) {
  requireCondition((await lstat(path)).isFile());
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    requireCondition(before.isFile() && before.nlink === 1);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const after = await handle.stat();
    requireCondition(bytes === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs);
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    await handle.close();
  }
}
export async function fileInventory(directory: string) {
  const files: string[] = [];
  async function visit(path: string) {
    for (const entry of await readdir(path)) {
      const full = join(path, entry),
        stat = await lstat(full);
      requireCondition(!stat.isSymbolicLink());
      if (stat.isDirectory()) await visit(full);
      else {
        requireCondition(stat.isFile());
        files.push(relative(directory, full).split(sep).join('/'));
      }
    }
  }
  await visit(directory);
  return Promise.all(
    files
      .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
      .map(async (path) => ({ path, ...(await hashFile(join(directory, path))) })),
  );
}
export async function prepareSource(cwd: string, revision: string, destination: string) {
  requireCondition(/^[a-f0-9]{40}$/.test(revision));
  requireCondition((await git(cwd, ['rev-parse', revision + '^{commit}'])).trim() === revision);
  await git(cwd, ['merge-base', '--is-ancestor', revision, 'origin/main']);
  const tree = (await git(cwd, ['ls-tree', '-r', '-z', '--full-tree', revision])).split('\0').filter(Boolean);
  const entries = new Map<string, { mode: string; object: string }>();
  for (const entry of tree) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    requireCondition(match);
    const path = safeSourcePath(match[3]!);
    requireCondition(!entries.has(path));
    requireCondition(['100644', '100755'].includes(match[1]!) || (path === 'CLAUDE.md' && match[1] === '120000'));
    entries.set(path, { mode: match[1]!, object: match[2]! });
  }
  const link = entries.get('CLAUDE.md');
  if (link?.mode === '120000') {
    requireCondition((await git(cwd, ['cat-file', 'blob', link.object])) === 'AGENTS.md');
    requireCondition(['100644', '100755'].includes(entries.get('AGENTS.md')?.mode ?? ''));
  }
  await mkdir(destination);
  const archive = join(dirname(destination), 'source.tar');
  // 검증한 commit만 추출하고 Windows에서도 알려진 내부 링크를 일반 파일로 만든다.
  await git(cwd, [
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
    'archive',
    '--format=tar',
    '--output=' + archive,
    revision,
  ]);
  await run(
    'tar',
    ['--extract', '--file', archive, '--directory', destination, '--no-same-owner', '--exclude=CLAUDE.md'],
    { windowsHide: true },
  );
  if (link) {
    const bytes =
      link.mode === '120000'
        ? await readFile(join(destination, 'AGENTS.md'))
        : Buffer.from(await git(cwd, ['cat-file', 'blob', link.object]));
    await writeFile(join(destination, 'CLAUDE.md'), bytes, { flag: 'wx' });
  }
  const inventory = await fileInventory(destination);
  requireCondition(inventory.length === entries.size && inventory.every((file) => entries.has(file.path)));
  const fingerprint = createHash('sha256');
  for (const file of inventory) {
    const expected = entries.get(file.path)!;
    const sourceObject =
      file.path === 'CLAUDE.md' && expected.mode === '120000' ? entries.get('AGENTS.md')!.object : expected.object;
    const actualObject = createHash('sha1')
      .update(`blob ${file.bytes}\0`)
      .update(await readFile(join(destination, file.path)))
      .digest('hex');
    requireCondition(actualObject === sourceObject);
    await chmod(join(destination, file.path), expected.mode === '100755' ? 0o755 : 0o644);
    fingerprint
      .update(file.path + '\0')
      .update(await readFile(join(destination, file.path)))
      .update('\0');
  }
  return { sourceTreeSha256: fingerprint.digest('hex'), archive: await hashFile(archive) };
}
async function plainDirectory(path: string) {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink());
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
export async function reserveRelease(cwd: string, output: string, revision: string) {
  requireCondition(isAbsolute(output) && /^[a-f0-9]{40}$/.test(revision));
  await plainDirectory(output);
  const parent = await realpath(output);
  requireCondition(!/[,"\r\n]/.test(parent));
  const worktrees = (await git(cwd, ['worktree', 'list', '--porcelain', '-z']))
    .split('\0')
    .filter((value) => value.startsWith('worktree '));
  for (const line of worktrees) requireCondition(!inside(await realpath(line.slice(9)), parent));
  const directory = join(parent, revision);
  // mkdir는 기존 빈 디렉터리도 거부한다. 실패한 자기 partial도 자동 삭제하지 않는다.
  await mkdir(directory, { mode: 0o700 });
  const partial = join(directory, '.partial-' + randomUUID());
  await mkdir(partial, { mode: 0o700 });
  return { directory, partial };
}
export async function finalizeManifest(directory: string, manifest: unknown) {
  const bytes = JSON.stringify(manifest, null, 2) + '\n',
    digest = sha(bytes);
  const partial = join(directory, 'manifest.partial.json');
  await writeFile(partial, bytes, { flag: 'wx' });
  requireCondition(sha(await readFile(partial)) === digest);
  const checksum = join(directory, 'manifest.sha256');
  await writeFile(checksum, digest + '  manifest.json\n', { flag: 'wx' });
  requireCondition((await readFile(checksum, 'utf8')) === digest + '  manifest.json\n');
  // 완성 표시는 체크섬까지 검증한 뒤 마지막에만 확정한다.
  await rename(partial, join(directory, 'manifest.json'));
  return join(directory, 'manifest.json');
}
async function dockerStep(executable: string, args: string[], log: string) {
  const fd = openSync(log, 'wx');
  try {
    await new Promise<void>((resolveStep, reject) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
      let failure: unknown;
      child.once('error', (error) => {
        failure = error;
      });
      child.once('close', (code, signal) =>
        code === 0 && signal === null && !failure ? resolveStep() : reject(new Error('이미지 명령이 실패했습니다.')),
      );
    });
  } finally {
    closeSync(fd);
  }
}
export async function buildRelease(inputValue: unknown, cwd = root) {
  const input = releaseInput.parse(inputValue);
  requireCondition((await lstat(input.dockerExecutable)).isFile());
  const { directory, partial } = await reserveRelease(cwd, input.outputDirectory, input.sourceRevision);
  const context = join(partial, 'context');
  const source = await prepareSource(cwd, input.sourceRevision, context);
  const images: Array<{ target: string; id: string; revision: string; sourceTreeSha256: string }> = [];
  const tag = 'opensamguk-release-local:' + randomUUID();
  const logs = join(directory, 'build-logs');
  await mkdir(logs);
  for (const target of ['server', 'engine', 'migrate', 'web']) {
    const args = [
      'build',
      '--progress=plain',
      '--file',
      join(context, 'deploy/Dockerfile'),
      '--target',
      target,
      '--build-arg',
      'SOURCE_REVISION=' + input.sourceRevision,
      '--build-arg',
      'SOURCE_TREE_SHA256=' + source.sourceTreeSha256,
    ];
    if (target === 'web') args.push('--output', 'type=local,dest=' + join(partial, 'export'));
    else args.push('--tag', tag + '-' + target);
    args.push(context);
    await dockerStep(input.dockerExecutable, args, join(logs, target + '.log'));
    if (target === 'web') continue;
    const [image] = JSON.parse(
      (
        await run(input.dockerExecutable, ['image', 'inspect', tag + '-' + target], {
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    ) as Array<{ Id: string; Config: { User: string; Env: string[]; Labels: Record<string, string> } }>;
    requireCondition(image && /^sha256:[a-f0-9]{64}$/.test(image.Id));
    requireCondition(image.Config.User === '10001:10001' && image.Config.Env.includes('NODE_ENV=production'));
    requireCondition(!image.Config.Env.some((value) => /^(DATABASE_URL|MAIL_API_KEY|RESEND_API_KEY)=/.test(value)));
    requireCondition(image.Config.Labels['org.opencontainers.image.revision'] === input.sourceRevision);
    requireCondition(image.Config.Labels['org.opensamguk.source-tree-sha256'] === source.sourceTreeSha256);
    images.push({ target, id: image.Id, revision: input.sourceRevision, sourceTreeSha256: source.sourceTreeSha256 });
  }
  const payload = join(partial, 'payload');
  await mkdir(payload);
  await dockerStep(
    input.dockerExecutable,
    ['save', '--output', join(payload, 'images.tar'), ...images.map((image) => image.id)],
    join(logs, 'save.log'),
  );
  await rename(join(partial, 'export', 'web'), join(payload, 'web'));
  const webFiles = await fileInventory(join(payload, 'web'));
  requireCondition(webFiles.length > 0);
  const metadata = JSON.parse(await readFile(join(payload, 'web', 'public-build.json'), 'utf8')) as {
    mode: string;
    imageBaseUrl: string;
    images: unknown[];
  };
  requireCondition(metadata.mode === 'public' && metadata.imageBaseUrl === '' && metadata.images.length === 6);
  await run('tar', ['--create', '--file', join(payload, 'web.tar'), '--directory', join(payload, 'web'), '.'], {
    windowsHide: true,
  });
  const migrations = [];
  for (const name of (await readdir(join(context, 'packages/db/prisma/migrations')))
    .filter((name) => /^\d{14}_/.test(name))
    .sort())
    migrations.push({
      name,
      ...(await hashFile(join(context, 'packages/db/prisma/migrations', name, 'migration.sql'))),
    });
  requireCondition(migrations.length > 0);
  const publicAssetManifest = await hashFile(join(context, 'manifest/public-assets.json'));
  const assetPolicy = JSON.parse(await readFile(join(context, 'manifest/public-assets.json'), 'utf8')) as {
    portraitPolicy: string;
    remoteImageBases: string[];
    externalAssetOrigins: string[];
  };
  requireCondition(
    assetPolicy.portraitPolicy === 'fallback-only' &&
      assetPolicy.remoteImageBases.length === 0 &&
      assetPolicy.externalAssetOrigins.length === 0,
  );
  const packageManager = (
    JSON.parse(await readFile(join(context, 'package.json'), 'utf8')) as { packageManager: string }
  ).packageManager;
  requireCondition(packageManager === 'pnpm@10.33.0');
  const manifest = {
    version: 1,
    sourceRevision: input.sourceRevision,
    sourceTreeSha256: source.sourceTreeSha256,
    sourceArchive: source.archive,
    packageManager,
    images,
    imageArchive: { path: 'payload/images.tar', ...(await hashFile(join(payload, 'images.tar'))) },
    web: {
      directory: 'payload/web',
      files: webFiles,
      archive: { path: 'payload/web.tar', ...(await hashFile(join(payload, 'web.tar'))) },
      imageBaseUrl: metadata.imageBaseUrl,
    },
    migrations,
    resourcesSql: await hashFile(join(context, 'packages/db/sql/resources-init.sql')),
    publicAssets: { ...publicAssetManifest, portraitPolicy: assetPolicy.portraitPolicy, externalPortraits: 0 },
    dataContract: 'unknown',
  };
  await rename(payload, join(directory, 'payload'));
  return finalizeManifest(directory, manifest);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    requireCondition(process.argv.length === 3);
    const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as unknown;
    console.log(await buildRelease(input));
  } catch {
    console.error('릴리스 산출물을 확정하지 못했습니다. 자체 partial과 빌드 기록을 확인하세요.');
    process.exitCode = 1;
  }
}
