// AC-M3-07. 설치 전후에 같은 Git 링크 계약을 쓰며 Node 내장 모듈만 불러온다.
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const invalid = () => {
  throw new Error('LOAD_SOURCE_INVALID');
};
const safeName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  !/[\\\0\r\n]/.test(name) &&
  !isAbsolute(name) &&
  !/^[a-z]:/i.test(name) &&
  name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const inside = (root, file) => {
  const name = relative(root, file);
  return name !== '' && !isAbsolute(name) && name !== '..' && !name.startsWith('../') && !name.startsWith('..\\');
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseGitTree(raw) {
  const entries = new Map();
  for (const line of raw.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match || !safeName(match[3]) || entries.has(match[3])) invalid();
    entries.set(match[3], { mode: match[1], oid: match[2] });
  }
  if (!entries.size) invalid();
  return entries;
}

// 파일 시스템 관측값의 순수 검증이다. 실제 수집자는 아래에서 따로 경로와 파일을 읽는다.
export function sourceEntryHash(input) {
  const { name, mode, kind, bytes, rootReal, fileReal, platform } = input;
  if (!safeName(name) || !inside(rootReal, fileReal) || fileReal !== resolve(rootReal, name)) invalid();
  if (mode !== undefined && !['100644', '100755', '120000'].includes(mode)) invalid();
  if (mode !== '120000') {
    if (kind !== 'regular') invalid();
    return digest(bytes);
  }
  const { linkBlob, actualLinkText, target } = input;
  if (
    typeof linkBlob !== 'string' ||
    !linkBlob ||
    /[\\\0\r\n]/.test(linkBlob) ||
    isAbsolute(linkBlob) ||
    /^[a-z]:/i.test(linkBlob)
  )
    invalid();
  const targetPath = resolve(rootReal, dirname(name), linkBlob);
  if (
    !inside(rootReal, targetPath) ||
    !target ||
    target.real !== targetPath ||
    !inside(rootReal, target.real) ||
    target.kind !== 'regular' ||
    !['100644', '100755'].includes(target.mode) ||
    !safeName(target.name) ||
    resolve(rootReal, target.name) !== target.real
  )
    invalid();
  if (kind === 'symlink') {
    if (actualLinkText !== linkBlob) invalid();
  } else if (kind === 'regular') {
    if (platform !== 'win32' || !Buffer.from(bytes).equals(Buffer.from(linkBlob))) invalid();
  } else invalid();
  return digest(linkBlob);
}

export async function snapshotSource(root, git, signal) {
  const observe = async (work) => {
    signal.throwIfAborted();
    const value = await work();
    signal.throwIfAborted();
    return value;
  };
  const run = async (args) => {
    signal.throwIfAborted();
    const raw = await git(args);
    signal.throwIfAborted();
    return raw;
  };
  const names = (await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .split('\0')
    .filter(Boolean)
    .sort();
  if (!names.length || new Set(names).size !== names.length || names.some((name) => !safeName(name))) invalid();
  const entries = parseGitTree(await run(['ls-tree', '-r', '-z', 'HEAD']));
  if ([...entries.keys()].some((name) => !names.includes(name))) invalid();
  const rootReal = await observe(() => realpath(root));
  signal.throwIfAborted();
  const rows = [];
  for (const name of names) {
    signal.throwIfAborted();
    const file = resolve(rootReal, name),
      stat = await observe(() => lstat(file)),
      entry = entries.get(name);
    signal.throwIfAborted();
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'regular' : 'other';
    let input;
    if (entry?.mode === '120000') {
      const linkBlob = await run(['cat-file', 'blob', entry.oid]);
      const blob = Buffer.from(linkBlob);
      if (
        createHash('sha1')
          .update('blob ' + blob.length + '\0')
          .update(blob)
          .digest('hex') !== entry.oid
      )
        invalid();
      if (!linkBlob || /[\\\0\r\n]/.test(linkBlob) || isAbsolute(linkBlob) || /^[a-z]:/i.test(linkBlob)) invalid();
      const targetPath = resolve(rootReal, dirname(name), linkBlob);
      if (!inside(rootReal, targetPath)) invalid();
      const targetReal = await observe(() => realpath(targetPath)),
        targetStat = await observe(() => lstat(targetPath));
      signal.throwIfAborted();
      const targetName = relative(rootReal, targetReal).split('\\').join('/'),
        targetEntry = entries.get(targetName);
      if (!names.includes(targetName)) invalid();
      input = {
        name,
        mode: entry.mode,
        kind,
        rootReal,
        fileReal: file,
        platform: process.platform,
        linkBlob,
        bytes: kind === 'regular' ? await observe(() => readFile(file)) : Buffer.alloc(0),
        actualLinkText: kind === 'symlink' ? await observe(() => readlink(file)) : undefined,
        target: {
          name: targetName,
          real: targetReal,
          mode: targetEntry?.mode,
          kind: targetStat.isFile() && !targetStat.isSymbolicLink() ? 'regular' : 'other',
        },
      };
    } else {
      if (kind !== 'regular') invalid();
      input = {
        name,
        mode: entry?.mode,
        kind,
        rootReal,
        fileReal: await observe(() => realpath(file)),
        platform: process.platform,
        bytes: await observe(() => readFile(file)),
      };
    }
    signal.throwIfAborted();
    rows.push({ name, sha256: sourceEntryHash(input) });
  }
  const head = (await run(['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) invalid();
  return { head, sha256: digest(rows.map((row) => row.name + '\0' + row.sha256 + '\n').join('')), files: rows.length };
}
