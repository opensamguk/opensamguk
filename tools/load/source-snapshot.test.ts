import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapSnapshot } from './bootstrap.mjs';
import { OwnedCommands, sourceSnapshot } from './lifecycle';
import { parseGitTree, sourceEntryHash, snapshotSource, type SourceEntry } from './source-snapshot.mjs';

const rootReal = resolve('/load-source-fixture');
const link: SourceEntry = {
  name: 'CLAUDE.md',
  mode: '120000',
  kind: 'symlink',
  rootReal,
  fileReal: resolve(rootReal, 'CLAUDE.md'),
  platform: 'linux',
  bytes: Buffer.alloc(0),
  linkBlob: 'AGENTS.md',
  actualLinkText: 'AGENTS.md',
  target: { name: 'AGENTS.md', real: resolve(rootReal, 'AGENTS.md'), mode: '100644', kind: 'regular' },
};
const oid = (text: string) =>
  createHash('sha1')
    .update('blob ' + Buffer.byteLength(text) + '\0')
    .update(text)
    .digest('hex');
const tree = '100644 blob ' + 'a'.repeat(40) + '\tAGENTS.md\0' + '120000 blob ' + oid('AGENTS.md') + '\tCLAUDE.md\0';

async function fixture(run: (root: string, git: (args: readonly string[]) => Promise<string>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'opensamguk-load-source-'));
  const errors: unknown[] = [];
  try {
    await writeFile(join(root, 'AGENTS.md'), 'tracked source\n');
    if (process.platform === 'win32') await writeFile(join(root, 'CLAUDE.md'), 'AGENTS.md');
    else await symlink('AGENTS.md', join(root, 'CLAUDE.md'));
    const git = async (args: readonly string[]) => {
      if (args[0] === 'ls-files') return 'AGENTS.md\0CLAUDE.md\0';
      if (args[0] === 'ls-tree') return tree;
      if (args[0] === 'cat-file' && args[2] === oid('AGENTS.md')) return 'AGENTS.md';
      if (args[0] === 'rev-parse') return 'b'.repeat(40) + '\n';
      throw new Error('Unexpected fixture Git command');
    };
    await run(root, git);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await rm(root, { recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Source fixture failed');
}

describe('L4/L5 Git 정본 링크 snapshot', () => {
  it('Linux native 링크와 Windows Git materialization의 정본 hash가 같다', () => {
    const native = sourceEntryHash(link);
    expect(native).toBe(createHash('sha256').update('AGENTS.md').digest('hex'));
    expect(
      sourceEntryHash({
        ...link,
        kind: 'regular',
        platform: 'win32',
        bytes: Buffer.from('AGENTS.md'),
        actualLinkText: undefined,
      }),
    ).toBe(native);
    expect(() => sourceEntryHash({ ...link, kind: 'regular', bytes: Buffer.from('AGENTS.md') })).toThrow(
      'LOAD_SOURCE_INVALID',
    );
  });
  it('외부·절대·상위 탈출·부재·미추적·다른 링크와 mode를 거부한다', () => {
    for (const patch of [
      { mode: undefined },
      { mode: '160000' },
      { actualLinkText: 'OTHER.md' },
      { linkBlob: '../outside.md' },
      { linkBlob: '/etc/passwd' },
      { linkBlob: 'C:/outside.md' },
      { linkBlob: '\\\\host\\share' },
      { linkBlob: 'AGENTS.md\n' },
      { target: undefined },
      { target: { ...link.target!, mode: undefined } },
      { target: { ...link.target!, kind: 'symlink' } },
      { target: { ...link.target!, real: resolve(rootReal, '..', 'outside.md') } },
      { target: { ...link.target!, name: 'OTHER.md' } },
    ])
      expect(() => sourceEntryHash({ ...link, ...patch })).toThrow('LOAD_SOURCE_INVALID');
    expect(() =>
      sourceEntryHash({ ...link, platform: 'win32', kind: 'regular', bytes: Buffer.from('AGENTS.md\n') }),
    ).toThrow('LOAD_SOURCE_INVALID');
  });
  it('추적 regular 파일의 실제 bytes를 hash하고 경로 우회와 새 symlink는 막는다', () => {
    const regular: SourceEntry = {
      ...link,
      name: 'AGENTS.md',
      mode: '100644',
      kind: 'regular',
      fileReal: resolve(rootReal, 'AGENTS.md'),
      bytes: Buffer.from('old'),
    };
    expect(sourceEntryHash(regular)).not.toBe(sourceEntryHash({ ...regular, bytes: Buffer.from('new') }));
    expect(() => sourceEntryHash({ ...regular, fileReal: resolve(rootReal, '..', 'AGENTS.md') })).toThrow();
    expect(() => sourceEntryHash({ ...regular, name: '../AGENTS.md' })).toThrow();
    expect(() => sourceEntryHash({ ...regular, kind: 'symlink' })).toThrow();
    expect(() => sourceEntryHash({ ...regular, mode: undefined, kind: 'symlink' })).toThrow();
  });
  it('Git mode·blob type·중복 경로·알 수 없는 항목을 그대로 실패시킨다', () => {
    expect(parseGitTree(tree).get('CLAUDE.md')?.mode).toBe('120000');
    for (const raw of [
      '',
      tree + tree,
      tree.replace('120000', '160000'),
      tree.replace('120000 blob', '120000 commit'),
      tree.replace('CLAUDE.md', '../CLAUDE.md'),
    ])
      expect(() => parseGitTree(raw)).toThrow('LOAD_SOURCE_INVALID');
  });
  it('설치 전 bootstrap와 설치 후 shared 수집자가 실제 임시 파일에서 같은 manifest를 만든다', async () => {
    await fixture(async (root, git) => {
      const signal = new AbortController().signal,
        commands = new OwnedCommands(root);
      vi.spyOn(commands, 'run').mockImplementation(async (command, args, options) => {
        expect(command).toBe('git');
        expect(options.timeoutMs).toBe(10000);
        return git(args);
      });
      const native = async (
        command: string,
        args: readonly string[],
        _label: string,
        _signal: AbortSignal,
        timeout: number,
      ) => {
        expect(command).toBe('git');
        expect(timeout).toBe(10000);
        return git(args);
      };
      const before = await bootstrapSnapshot(root, native, signal);
      expect(await sourceSnapshot(commands, signal)).toEqual(before);
      expect(before.files).toBe(2);
      await writeFile(join(root, 'AGENTS.md'), 'changed source\n');
      const after = await bootstrapSnapshot(root, native, signal);
      expect(await sourceSnapshot(commands, signal)).toEqual(after);
      expect(after.sha256).not.toBe(before.sha256);
      expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('changed source\n');
    });
  });
  it('두 수집자가 변조 materialization·없는 target·다른 Git blob을 모두 거부한다', async () => {
    await fixture(async (root, git) => {
      const signal = new AbortController().signal;
      const checkBoth = async (callback: (args: readonly string[]) => Promise<string>) => {
        const commands = new OwnedCommands(root);
        vi.spyOn(commands, 'run').mockImplementation(async (_command, args) => callback(args));
        await expect(bootstrapSnapshot(root, async (_command, args) => callback(args), signal)).rejects.toThrow();
        await expect(sourceSnapshot(commands, signal)).rejects.toThrow();
      };
      await checkBoth(async (args) => (args[0] === 'cat-file' ? 'OTHER.md' : git(args)));
      await rm(join(root, 'AGENTS.md'));
      await checkBoth(git);
      await writeFile(join(root, 'AGENTS.md'), 'restored');
      await rm(join(root, 'CLAUDE.md'));
      await writeFile(join(root, 'CLAUDE.md'), 'OTHER.md');
      await checkBoth(git);
    });
  });
  it('취소 후 후속 Git·파일 수집을 시작하지 않는다', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      snapshotSource(
        rootReal,
        async () => {
          calls++;
          controller.abort();
          return 'AGENTS.md\0';
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
