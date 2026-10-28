import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  fileInventory,
  finalizeManifest,
  hashFile,
  prepareSource,
  releaseInput,
  reserveRelease,
  safeSourcePath,
} from './release-artifact';

const run = promisify(execFile);
let owned: string;
beforeAll(async () => {
  owned = await mkdtemp(join(tmpdir(), 'opensamguk-release-manifest-test-'));
});
afterAll(async () => {
  const absolute = resolve(owned);
  if (
    !basename(absolute).startsWith('opensamguk-release-manifest-test-') ||
    relative(resolve(tmpdir()), absolute).startsWith('..')
  )
    throw new Error('자기 시험 경로를 확인하세요.');
  await rm(absolute, { recursive: true });
});
async function git(cwd: string, args: string[]) {
  return (await run('git', args, { cwd, windowsHide: true })).stdout.trim();
}
async function fixture() {
  const directory = await mkdtemp(join(owned, 'case-')),
    repo = join(directory, 'repo'),
    output = join(directory, 'output');
  await mkdir(repo);
  await mkdir(output);
  await git(repo, ['init', '--initial-branch=main']);
  await writeFile(join(repo, 'AGENTS.md'), 'committed instructions\n');
  await writeFile(join(repo, 'ordinary.txt'), 'committed content\n');
  await git(repo, ['add', '.']);
  const revision = await commit(repo);
  await git(repo, ['update-ref', 'refs/remotes/origin/main', revision]);
  return { directory, repo, output, revision };
}
async function commit(repo: string) {
  await git(repo, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--no-gpg-sign',
    '-m',
    'fixture',
  ]);
  return git(repo, ['rev-parse', 'HEAD']);
}
async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
for (const path of [
  '../escape',
  '/root',
  'a/../b',
  'a\\b',
  'C:drive',
  'a//b',
  './a',
  'line\nname',
  'nul' + String.fromCharCode(0),
])
  it(`T2-15 AC-M2-08 잘못된 소스 경로 거부 ${JSON.stringify(path)}`, () => {
    expect(() => safeSourcePath(path)).toThrow();
  });

it('T2-15 AC-M2-08 입력은 실제 SHA·절대 경로만 받고 알 수 없는 필드를 거부한다', () => {
  const valid = {
    sourceRevision: 'a'.repeat(40),
    outputDirectory: resolve(tmpdir()),
    dockerExecutable: process.execPath,
  };
  expect(releaseInput.safeParse(valid).success).toBe(true);
  for (const value of [
    { ...valid, sourceRevision: 'HEAD' },
    { ...valid, outputDirectory: 'relative' },
    { ...valid, dockerExecutable: 'docker' },
    { ...valid, DATABASE_URL: 'not-accepted' },
    { ...valid, outputDirectory: join(resolve(tmpdir()), 'owned,dest=outside') },
    { ...valid, outputDirectory: join(resolve(tmpdir()), 'owned"quoted') },
  ])
    expect(releaseInput.safeParse(value).success).toBe(false);
});
it('T2-15 AC-M2-08 Docker CSV 옵션을 바꾸는 출력 부모를 예약 전에 거부한다', async () => {
  const { repo, directory, revision } = await fixture();
  const output = join(directory, 'owned,dest=outside');
  await mkdir(output);
  await expect(reserveRelease(repo, output, revision)).rejects.toThrow();
  expect(await exists(join(output, revision))).toBe(false);
});
it('T2-15 AC-M2-08 실제 Git archive는 dirty·untracked 파일을 포함하지 않는다', async () => {
  const { directory, repo, revision } = await fixture();
  await writeFile(join(repo, 'AGENTS.md'), 'dirty instructions\n');
  await writeFile(join(repo, '.env'), 'private-canary-only\n');
  const destination = join(directory, 'context');
  const result = await prepareSource(repo, revision, destination);
  expect(await readFile(join(destination, 'AGENTS.md'), 'utf8')).toBe('committed instructions\n');
  expect(await exists(join(destination, '.env'))).toBe(false);
  const hash = createHash('sha256')
    .update('AGENTS.md\0committed instructions\n\0ordinary.txt\0committed content\n\0')
    .digest('hex');
  expect(result.sourceTreeSha256).toBe(hash);
  expect(result.archive.bytes).toBeGreaterThan(0);
});
it('T2-15 AC-M2-08 origin/main에 없는 실제 commit은 추출 전에 거부한다', async () => {
  const { directory, repo } = await fixture();
  await writeFile(join(repo, 'new.txt'), 'new\n');
  await git(repo, ['add', '.']);
  const revision = await commit(repo);
  const destination = join(directory, 'context');
  await expect(prepareSource(repo, revision, destination)).rejects.toThrow();
  expect(await exists(destination)).toBe(false);
});
it('T2-15 AC-M2-08 Git의 알려진 내부 링크만 실제 파일로 바꾼다', async () => {
  const { directory, repo } = await fixture();
  await writeFile(join(directory, 'link-content'), 'AGENTS.md');
  const object = await git(repo, ['hash-object', '-w', join(directory, 'link-content')]);
  await git(repo, ['update-index', '--add', '--cacheinfo', '120000,' + object + ',CLAUDE.md']);
  const revision = await commit(repo);
  await git(repo, ['update-ref', 'refs/remotes/origin/main', revision]);
  const destination = join(directory, 'context');
  await prepareSource(repo, revision, destination);
  expect((await lstat(join(destination, 'CLAUDE.md'))).isFile()).toBe(true);
  expect(await readFile(join(destination, 'CLAUDE.md'), 'utf8')).toBe('committed instructions\n');
});
it('T2-15 AC-M2-08 다른 Git 링크는 추출 전에 거부한다', async () => {
  const { directory, repo } = await fixture();
  await writeFile(join(directory, 'link-content'), '../outside');
  const object = await git(repo, ['hash-object', '-w', join(directory, 'link-content')]);
  await git(repo, ['update-index', '--add', '--cacheinfo', '120000,' + object + ',escape']);
  const revision = await commit(repo);
  await git(repo, ['update-ref', 'refs/remotes/origin/main', revision]);
  await expect(prepareSource(repo, revision, join(directory, 'context'))).rejects.toThrow();
  expect(await exists(join(directory, 'context'))).toBe(false);
});
it('T2-15 AC-M2-08 checkout 안 출력과 기존 빈 release 디렉터리를 덮어쓰지 않는다', async () => {
  const { repo, output, revision } = await fixture();
  await expect(reserveRelease(repo, repo, revision)).rejects.toThrow();
  await mkdir(join(output, revision));
  await expect(reserveRelease(repo, output, revision)).rejects.toThrow();
  expect(await exists(join(output, revision))).toBe(true);
});
it('T2-15 AC-M2-08 같은 release의 동시 확보는 한 번만 성공한다', async () => {
  const { repo, output, revision } = await fixture();
  const results = await Promise.allSettled([
    reserveRelease(repo, output, revision),
    reserveRelease(repo, output, revision),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
});
it('T2-15 AC-M2-08 실제 바이트 변경은 inventory 해시에서 드러난다', async () => {
  const directory = await mkdtemp(join(owned, 'files-'));
  await writeFile(join(directory, 'asset'), 'before');
  const before = await fileInventory(directory);
  await writeFile(join(directory, 'asset'), 'after');
  const after = await fileInventory(directory);
  expect(before[0]!.sha256).not.toBe(after[0]!.sha256);
  expect(after[0]!.bytes).toBe(5);
  expect(await hashFile(join(directory, 'asset'))).toEqual({ sha256: after[0]!.sha256, bytes: 5 });
});
it('T2-15 AC-M2-08 경로는 플랫폼·대소문자·유니코드와 무관하게 UTF-8 바이트 순서로 정렬한다', async () => {
  const directory = await mkdtemp(join(owned, 'order-'));
  await mkdir(join(directory, 'a'));
  for (const name of ['a/child', 'a.md', 'Z', '\u{10000}', '\uE000']) await writeFile(join(directory, name), 'data');
  expect((await fileInventory(directory)).map((file) => file.path)).toEqual([
    'Z',
    'a.md',
    'a/child',
    '\uE000',
    '\u{10000}',
  ]);
});
it('T2-15 AC-M2-08 체크섬 쓰기 실패는 확정 manifest를 남기지 않는다', async () => {
  const directory = await mkdtemp(join(owned, 'manifest-fail-'));
  await mkdir(join(directory, 'manifest.sha256'));
  await expect(finalizeManifest(directory, { version: 1 })).rejects.toThrow();
  expect(await exists(join(directory, 'manifest.json'))).toBe(false);
  expect(await exists(join(directory, 'manifest.partial.json'))).toBe(true);
});
it('T2-15 AC-M2-08 성공 manifest는 기록한 체크섬과 일치하고 다시 쓰지 않는다', async () => {
  const directory = await mkdtemp(join(owned, 'manifest-ok-'));
  const file = await finalizeManifest(directory, { version: 1, dataContract: 'unknown' });
  const bytes = await readFile(file),
    checksum = createHash('sha256').update(bytes).digest('hex');
  expect(await readFile(join(directory, 'manifest.sha256'), 'utf8')).toBe(checksum + '  manifest.json\n');
  await expect(finalizeManifest(directory, { version: 2 })).rejects.toThrow();
  expect(await readFile(file)).toEqual(bytes);
});
