import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile, link, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fileInventory, finalizeManifest, hashFile } from './release-artifact';
import { preflightRelease } from './release-preflight';

const run = promisify(execFile),
  require = createRequire(import.meta.url);
const revision = 'a'.repeat(40),
  sourceFile = fileURLToPath(new URL('./release-preflight.ts', import.meta.url));
let owned: string;
beforeAll(async () => {
  owned = await mkdtemp(join(tmpdir(), 'opensamguk-preflight-'));
});
afterAll(async () => {
  const root = resolve(owned);
  if (!basename(root).startsWith('opensamguk-preflight-') || relative(resolve(tmpdir()), root).startsWith('..'))
    throw new Error('자기 시험 경로를 확인하세요.');
  await rm(root, { recursive: true });
});
async function fixture(change?: (manifest: Record<string, unknown>) => void) {
  const root = join(owned, randomUUID()),
    release = join(root, revision),
    partial = join(release, '.partial-' + randomUUID());
  const context = join(partial, 'context'),
    web = join(release, 'payload/web');
  const migration = '20260101000000_initial';
  await mkdir(web, { recursive: true });
  for (const [name, bytes] of Object.entries({
    ['packages/db/prisma/migrations/' + migration + '/migration.sql']: 'CREATE TABLE fixture (id integer);\n',
    'packages/db/sql/resources-init.sql': '-- fixture resources\n',
    'manifest/public-assets.json': JSON.stringify({
      portraitPolicy: 'fallback-only',
      remoteImageBases: [],
      externalAssetOrigins: [],
    }),
  })) {
    await mkdir(dirname(join(context, name)), { recursive: true });
    await writeFile(join(context, name), bytes);
  }
  await writeFile(join(partial, 'source.tar'), 'fixture source archive bytes');
  await writeFile(join(release, 'payload/images.tar'), 'fixture image archive bytes');
  await writeFile(join(release, 'payload/web.tar'), 'fixture web archive bytes');
  await writeFile(join(web, 'index.html'), '<html>fixture public</html>');
  await writeFile(
    join(web, 'public-build.json'),
    JSON.stringify({ mode: 'public', imageBaseUrl: '', images: Array.from({ length: 6 }, (_, id) => ({ id })) }),
  );
  const sourceHash = createHash('sha256');
  for (const file of await fileInventory(context))
    sourceHash
      .update(file.path + '\0')
      .update(await readFile(join(context, file.path)))
      .update('\0');
  const sourceTreeSha256 = sourceHash.digest('hex');
  const manifest = {
    version: 1,
    sourceRevision: revision,
    sourceTreeSha256,
    sourceArchive: await hashFile(join(partial, 'source.tar')),
    packageManager: 'pnpm@10.33.0',
    images: ['server', 'engine', 'migrate'].map((target, index) => ({
      target,
      id: 'sha256:' + String(index + 1).repeat(64),
      revision,
      sourceTreeSha256,
    })),
    imageArchive: { path: 'payload/images.tar', ...(await hashFile(join(release, 'payload/images.tar'))) },
    web: {
      directory: 'payload/web',
      files: await fileInventory(web),
      archive: { path: 'payload/web.tar', ...(await hashFile(join(release, 'payload/web.tar'))) },
      imageBaseUrl: '',
    },
    migrations: [
      {
        name: migration,
        ...(await hashFile(join(context, 'packages/db/prisma/migrations', migration, 'migration.sql'))),
      },
    ],
    resourcesSql: await hashFile(join(context, 'packages/db/sql/resources-init.sql')),
    publicAssets: {
      ...(await hashFile(join(context, 'manifest/public-assets.json'))),
      portraitPolicy: 'fallback-only',
      externalPortraits: 0,
    },
    dataContract: 'unknown',
  };
  change?.(manifest);
  const manifestPath = await finalizeManifest(release, manifest);
  const input = {
    manifestPath,
    manifestSha256: (await hashFile(manifestPath)).sha256,
    sourceRevision: revision,
    receiptDirectory: join(root, 'receipt'),
  };
  return { root, release, partial, context, input };
}
async function rejected(input: unknown) {
  await expect(preflightRelease(input)).rejects.toThrow('릴리스 사전 확인을 마치지 못했습니다.');
}

it('AC-M2-08/AC-M3-10 실제 파일을 확인한 receipt만 확정하고 산출물·current는 바꾸지 않는다', async () => {
  const f = await fixture(),
    current = join(f.root, 'current');
  await writeFile(current, 'prior-release\n');
  const before = await fileInventory(f.release),
    result = await preflightRelease(f.input);
  expect(await fileInventory(f.release)).toEqual(before);
  expect(await readFile(current, 'utf8')).toBe('prior-release\n');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as Record<string, unknown>;
  expect(receipt).toMatchObject({
    outcome: 'artifact-preflight-passed',
    sourceRevision: revision,
    dataContract: 'unknown',
    deploymentStarted: false,
    currentChanged: false,
    rollbackAuthorized: false,
  });
  expect((await hashFile(result.receiptPath)).sha256).toBe(result.receiptSha256);
  expect((await lstat(result.receiptPath)).nlink).toBe(1);
  await rejected(f.input);
  expect((await hashFile(result.receiptPath)).sha256).toBe(result.receiptSha256);
});
for (const target of [
  'payload/images.tar',
  'payload/web.tar',
  'payload/web/index.html',
  'manifest.json',
  'manifest.sha256',
])
  it(`AC-M2-08 확정 뒤 변조한 ${target}를 거부한다`, async () => {
    const f = await fixture();
    await writeFile(join(f.release, target), 'tampered');
    await rejected(f.input);
  });
for (const target of [
  'source.tar',
  'context/packages/db/sql/resources-init.sql',
  'context/packages/db/prisma/migrations/20260101000000_initial/migration.sql',
  'context/manifest/public-assets.json',
])
  it(`AC-M2-08 원본 보존 자료 ${target}의 변조를 거부한다`, async () => {
    const f = await fixture();
    await writeFile(join(f.partial, target), 'tampered');
    await rejected(f.input);
  });
it('AC-M2-08 누락 파일·다른 source SHA·알 수 없는 입력·복귀 요청을 거부한다', async () => {
  const f = await fixture();
  await rejected({ ...f.input, sourceRevision: 'b'.repeat(40) });
  await rejected({ ...f.input, rollback: true });
  await rm(join(f.release, 'payload/images.tar'));
  await rejected(f.input);
});
it('AC-M2-08 final manifest 없는 partial과 목록 밖 web 파일을 거부한다', async () => {
  const f = await fixture();
  await writeFile(join(f.release, 'payload/web/extra.js'), 'extra');
  await rejected(f.input);
  await rm(f.input.manifestPath);
  await rejected(f.input);
});
it('AC-M2-08 archive 경로 탈출과 미지원 자료 계약은 해시가 맞아도 거부한다', async () => {
  const escaped = await fixture((m) => {
    (m.imageArchive as { path: string }).path = '../outside';
  });
  await rejected(escaped.input);
  const future = await fixture((m) => {
    m.dataContract = 'supported';
  });
  await rejected(future.input);
});
it('AC-M2-08 중복 이미지 대상과 알 수 없는 manifest 키를 거부한다', async () => {
  const duplicate = await fixture((m) => {
    const images = m.images as Array<{ target: string }>;
    images[2]!.target = 'server';
  });
  await rejected(duplicate.input);
  const extra = await fixture((m) => {
    m.unreviewed = true;
  });
  await rejected(extra.input);
});
it('AC-M2-08 파일 hardlink와 디렉터리 링크를 따라가지 않는다', async () => {
  const f = await fixture();
  await link(join(f.partial, 'source.tar'), join(f.root, 'archive-hardlink'));
  await rejected(f.input);
  const g = await fixture(),
    alias = join(g.root, 'alias');
  await symlink(g.release, alias, 'junction');
  await rejected({ ...g.input, manifestPath: join(alias, 'manifest.json') });
});
it('AC-M2-08 산출물 안 receipt와 이미 있는 receipt 디렉터리를 거부한다', async () => {
  const f = await fixture();
  await rejected({ ...f.input, receiptDirectory: join(f.release, 'receipt') });
  await mkdir(f.input.receiptDirectory);
  await writeFile(join(f.input.receiptDirectory, 'receipt.json'), 'existing');
  await rejected(f.input);
  expect(await readFile(join(f.input.receiptDirectory, 'receipt.json'), 'utf8')).toBe('existing');
});
it('AC-M2-08 실제 Bash/Node CLI는 preflight만 성공하고 복귀·잘못된 입력은 고정 오류로 끝난다', async () => {
  const f = await fixture(),
    config = join(f.root, 'input.json');
  await writeFile(config, JSON.stringify(f.input));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const script = fileURLToPath(new URL('./deploy.sh', import.meta.url));
  const result = await run(bash, [script, '--preflight', config], { timeout: 5000 });
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'artifact-preflight-passed' });
  const failed = await run(
    process.execPath,
    ['--import', pathToFileURL(require.resolve('tsx')).href, sourceFile, '--rollback', config],
    {
      timeout: 5000,
    },
  ).then(
    () => ({ code: 0, stdout: '', stderr: '' }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
  expect(failed.code).toBe(1);
  expect(failed.stdout).toBe('');
  expect(failed.stderr).toContain('current 변경은 실행하지 않았습니다.');
  await writeFile(config, '{private-canary-not-for-logs');
  const invalid = await run(
    process.execPath,
    ['--import', pathToFileURL(require.resolve('tsx')).href, sourceFile, '--preflight', config],
    {
      timeout: 5000,
    },
  ).catch((error: { code: number; stderr: string }) => error);
  expect(invalid).toHaveProperty('code', 1);
  expect(invalid.stderr).not.toContain('private-canary-not-for-logs');
});
