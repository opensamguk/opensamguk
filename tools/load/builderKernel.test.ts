import { describe, expect, it } from 'vitest';
import {
  builderKernelFailure,
  builderKernelMatches,
  builderNamespaceReader,
  readBuilderKernelProof,
  type BuilderKernelReader,
} from './builderKernel';
import { ciFailureDiagnostic, verifyBuilder } from './ci';

const id = 'b'.repeat(64),
  pid = 123,
  scope = `/sys/fs/cgroup/system.slice/docker-${id}.scope`,
  proc = `/proc/${pid}`;
type Operation = 'read' | 'directory' | 'canonical' | 'link' | 'filesystem';
type Change = (operation: Operation, path: string, count: number, original: unknown) => unknown;
function stat(start = '456', processId = pid, state = 'S') {
  const fields = Array<string>(20).fill('0');
  fields[0] = state;
  fields[19] = start;
  return `${processId} (buildkit ) helper) ${fields.join(' ')}\n`;
}
function fixture(path = `${scope}/buildkit/worker`, change?: Change) {
  const text = `0::${path.slice('/sys/fs/cgroup'.length)}\n`,
    files: Record<string, string> = {
      [`${proc}/stat`]: stat(),
      [`${proc}/cgroup`]: text,
      [`${scope}/cpu.max`]: '100000 100000\n',
      [`${scope}/memory.max`]: '2147483648\n',
      [`${scope}/memory.swap.max`]: '0\n',
    },
    links: Record<string, string> = {
      '/proc/self/ns/cgroup': 'cgroup:[100]',
      [`${proc}/ns/cgroup`]: 'cgroup:[200]',
      '/proc/self/ns/mnt': 'mnt:[300]',
    },
    calls: { operation: Operation; path: string }[] = [],
    counts = new Map<string, number>(),
    inodes = new Map<string, string>();
  function invoke<T>(operation: Operation, path: string, original: T): T {
    calls.push({ operation, path });
    const key = `${operation}:${path}`,
      count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return (change ? change(operation, path, count, original) : original) as T;
  }
  const reader: BuilderKernelReader = {
    read: async (path) => {
      if (!(path in files)) throw new Error('private-canary-path');
      return invoke('read', path, files[path]!);
    },
    directory: async (path) => {
      if (!inodes.has(path)) inodes.set(path, String(inodes.size + 1));
      return invoke('directory', path, { directory: true, symlink: false, dev: '1', ino: inodes.get(path)! });
    },
    canonical: async (path) => invoke('canonical', path, path),
    link: async (path) => invoke('link', path, links[path]!),
    targetNamespace: async (pid) => invoke('link', `/proc/${pid}/ns/cgroup`, links[`/proc/${pid}/ns/cgroup`]!),
    filesystem: async (path) => invoke('filesystem', path, 0x63677270),
  };
  return { text, files, reader, calls };
}
function builder(text: string) {
  const name = `opensamguk-load-build-${'a'.repeat(32)}`,
    containerName = `buildx_buildkit_${name}0`;
  return {
    row: {
      Id: id,
      Name: `/${containerName}`,
      Image: 'buildkit-image',
      State: { Running: true, Pid: pid, OOMKilled: false },
      HostConfig: {
        CpuQuota: 100000,
        CpuPeriod: 100000,
        Memory: 2147483648,
        MemorySwap: 2147483648,
        CgroupParent: '',
        CgroupnsMode: 'private',
        RestartPolicy: { Name: 'no' },
      },
      Mounts: [{ Type: 'volume', Name: `${containerName}_state`, Destination: '/var/lib/buildkit' }],
    },
    expected: { name, imageId: 'buildkit-image', cgroupText: text },
  };
}
const signal = () => new AbortController().signal;
async function rejected(source: ReturnType<typeof fixture>, check: string) {
  let error: unknown;
  try {
    await readBuilderKernelProof({ id, pid }, signal(), source.reader);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('LOAD_BUILDER_UNVERIFIED');
  expect(builderKernelFailure(error)).toBe(check);
  expect(JSON.stringify(ciFailureDiagnostic('builder-runtime', error))).not.toContain('canary');
}

describe('builder kernel parent limits and process identity', () => {
  it('the privileged reader permits only the validated PID namespace and fixed command arguments', async () => {
    const controller = new AbortController(),
      calls: { args: readonly string[]; signal: AbortSignal }[] = [],
      reader = builderNamespaceReader(async (args, ownSignal) => {
        calls.push({ args, signal: ownSignal });
        return 'cgroup:[200]\n';
      });
    expect(await reader.targetNamespace(pid, controller.signal)).toBe('cgroup:[200]');
    expect(calls).toEqual([
      { args: ['-n', '/usr/bin/readlink', '--', '/proc/123/ns/cgroup'], signal: controller.signal },
    ]);
    for (const invalid of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])
      await expect(reader.targetNamespace(invalid, controller.signal)).rejects.toThrow('LOAD_BUILDER_UNVERIFIED');
    controller.abort();
    await expect(reader.targetNamespace(pid, controller.signal)).rejects.toThrow('LOAD_BUILDER_UNVERIFIED');
    expect(calls).toHaveLength(1);
  });
  it.each(['', 'cgroup:[0]\n', 'cgroup:[200]\nprivate-canary', 'mnt:[200]\n', '/private-canary', 'cgroup:[200]\n\n'])(
    'the privileged reader discards invalid or private output',
    async (output) => {
      const reader = builderNamespaceReader(async () => output);
      await expect(reader.targetNamespace(pid, signal())).rejects.toThrow(/^LOAD_BUILDER_UNVERIFIED$/);
    },
  );
  it('privileged reader failure and a late abort never become namespace proof or raw diagnostics', async () => {
    const failure = builderNamespaceReader(async () => {
      throw new Error('private-canary');
    });
    await expect(failure.targetNamespace(pid, signal())).rejects.toThrow(/^LOAD_BUILDER_UNVERIFIED$/);
    const controller = new AbortController(),
      late = builderNamespaceReader(async () => {
        controller.abort();
        return 'cgroup:[200]\n';
      });
    await expect(late.targetNamespace(pid, controller.signal)).rejects.toThrow(/^LOAD_BUILDER_UNVERIFIED$/);
  });
  it.each([scope, `${scope}/buildkit/worker`, `${scope}/init.scope`])(
    'attests only the actual owned hierarchy with stable parent limits: %s',
    async (path) => {
      const source = fixture(path),
        proof = await readBuilderKernelProof({ id, pid }, signal(), source.reader),
        { row, expected } = builder(source.text);
      expect(builderKernelMatches(proof, { id, pid, cgroupText: source.text })).toBe(true);
      expect(verifyBuilder(row, { ...expected, kernelProof: proof }).id).toBe(id);
      expect(proof.observed).toEqual({
        processStartTime: '456',
        descendantDepth: path.slice(scope.length).split('/').length - 1,
        cpuQuota: 100000,
        cpuPeriod: 100000,
        memoryMax: 2147483648,
        swapMax: 0,
        stable: true,
      });
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.observed)).toBe(true);
      const capReads = source.calls.filter((call) => call.operation === 'read' && call.path.startsWith(scope));
      expect(capReads.map((call) => call.path)).toEqual([
        `${scope}/cpu.max`,
        `${scope}/memory.max`,
        `${scope}/memory.swap.max`,
        `${scope}/cpu.max`,
        `${scope}/memory.max`,
        `${scope}/memory.swap.max`,
      ]);
    },
  );
  it('a descendant path or a copied/forged proof alone never authorizes the builder', async () => {
    const source = fixture(),
      proof = await readBuilderKernelProof({ id, pid }, signal(), source.reader),
      { row, expected } = builder(source.text);
    expect(() => verifyBuilder(row, expected)).toThrow('LOAD_BUILDER_UNVERIFIED');
    expect(() => verifyBuilder(row, { ...expected, kernelProof: { ...proof } })).toThrow('LOAD_BUILDER_UNVERIFIED');
    for (const identity of [
      { id: 'c'.repeat(64), pid, cgroupText: source.text },
      { id, pid: pid + 1, cgroupText: source.text },
      { id, pid, cgroupText: `${source.text.trim()}/other\n` },
    ])
      expect(builderKernelMatches(proof, identity)).toBe(false);
    expect(builderKernelMatches({ observed: true }, { id, pid, cgroupText: source.text })).toBe(false);
    expect(() =>
      verifyBuilder({ ...row, State: { ...row.State, Pid: pid + 1 } }, { ...expected, kernelProof: proof }),
    ).toThrow('LOAD_BUILDER_UNVERIFIED');
    expect(() =>
      verifyBuilder({ ...row, HostConfig: { ...row.HostConfig, Memory: 1 } }, { ...expected, kernelProof: proof }),
    ).toThrow('LOAD_BUILDER_UNVERIFIED');
  });
  it.each([
    '/sys/fs/cgroup',
    '/sys/fs/cgroup/system.slice',
    `/sys/fs/cgroup/foreign.slice/docker-${id}.scope/worker`,
    `${scope}-suffix/worker`,
    `${scope}/../other`,
    `${scope}/./worker`,
    `${scope}//worker`,
    `${scope}/worker (deleted)`,
    `${scope}/docker-${'c'.repeat(64)}.scope/worker`,
    `${scope}/docker-${id}.scope/worker`,
    `${scope}/worker\\escape`,
    `${scope}/${'x'.repeat(256)}`,
    `${scope}/${Array(33).fill('x').join('/')}`,
    `/sys/fs/cgroup/sys/fs/cgroup/system.slice/docker-${id}.scope/worker`,
  ])('rejects a root, foreign, ambiguous or unbounded hierarchy: %s', async (path) => {
    const source = fixture(path);
    await rejected(source, 'unified-path');
    expect(source.calls.every((call) => call.path.startsWith(proc))).toBe(true);
  });
  it.each(['0::/\n', '0::/private-canary\n0::/\n', '1:cpu:/private-canary\n', '0::/private-canary\nextra'])(
    'requires exactly one unified cgroup row: %s',
    async (text) => {
      const source = fixture();
      source.files[`${proc}/cgroup`] = text;
      await rejected(source, 'unified-path');
    },
  );
  it.each([
    ['cpu.max', 'max 100000\n'],
    ['cpu.max', '200000 100000\n'],
    ['cpu.max', '100000 200000\n'],
    ['memory.max', 'max\n'],
    ['memory.max', '4294967296\n'],
    ['memory.swap.max', 'max\n'],
    ['memory.swap.max', '2147483648\n'],
  ])('rejects incorrect actual parent limits: %s %s', async (name, value) => {
    const source = fixture();
    source.files[`${scope}/${name}`] = value;
    await rejected(source, name === 'cpu.max' ? 'cpu-max' : name === 'memory.max' ? 'memory-max' : 'swap-max');
  });
  it.each([
    ['symlink', 'directory'],
    ['not-directory', 'directory'],
    ['canonical-alias', 'directory'],
    ['wrong-filesystem', 'filesystem'],
    ['invalid-inode', 'directory'],
  ])('requires real nonsymlink cgroup2 directories: %s', async (kind, check) => {
    const source = fixture(undefined, (operation, path, _count, value) => {
      if (path !== scope) return value;
      if (kind === 'symlink' && operation === 'directory') return { ...(value as object), symlink: true };
      if (kind === 'not-directory' && operation === 'directory') return { ...(value as object), directory: false };
      if (kind === 'canonical-alias' && operation === 'canonical') return '/private-canary';
      if (kind === 'wrong-filesystem' && operation === 'filesystem') return 0x01021994;
      if (kind === 'invalid-inode' && operation === 'directory') return { ...(value as object), ino: 'NaN' };
      return value;
    });
    await rejected(source, check);
  });
  it.each([
    'pid-reused',
    'pid-moved',
    'directory-replaced',
    'namespace-moved',
    'reader-namespace-moved',
    'mount-changed',
  ])('rejects kernel identity changes during observation: %s', async (kind) => {
    const source = fixture(undefined, (operation, path, count, value) => {
      if (count !== 2) return value;
      if (kind === 'pid-reused' && operation === 'read' && path === `${proc}/stat`) return stat('789');
      if (kind === 'pid-moved' && operation === 'read' && path === `${proc}/cgroup`) return '0::/private-canary\n';
      if (kind === 'directory-replaced' && operation === 'directory' && path === scope)
        return { ...(value as object), ino: '999' };
      if (kind === 'namespace-moved' && operation === 'link' && path === `${proc}/ns/cgroup`) return 'cgroup:[999]';
      if (kind === 'reader-namespace-moved' && operation === 'link' && path === '/proc/self/ns/cgroup')
        return 'cgroup:[999]';
      if (kind === 'mount-changed' && operation === 'link' && path === '/proc/self/ns/mnt') return 'mnt:[999]';
      return value;
    });
    await rejected(source, 'stable');
  });
  it('rechecks all three actual limits and rejects a late limit change', async () => {
    const source = fixture(undefined, (operation, path, count, value) =>
      operation === 'read' && path === `${scope}/memory.swap.max` && count === 2 ? 'max\n' : value,
    );
    await rejected(source, 'swap-max');
  });
  it.each([
    [`${proc}/ns/cgroup`, 'cgroup:[100]'],
    [`${proc}/ns/cgroup`, 'private-canary'],
    ['/proc/self/ns/cgroup', 'private-canary'],
    ['/proc/self/ns/mnt', 'private-canary'],
  ])('requires stable, valid private namespace separation: %s', async (path, namespace) => {
    await rejected(
      fixture(undefined, (operation, name, _count, value) =>
        operation === 'link' && name === path ? namespace : value,
      ),
      'namespace',
    );
  });
  it.each([stat('456', pid + 1), stat('456', pid, 'Z'), stat('456', pid, 'X'), stat('0'), '123 (broken) S 0'])(
    'rejects malformed, dead or wrong PID birth: %s',
    async (text) => {
      const source = fixture();
      source.files[`${proc}/stat`] = text;
      await rejected(source, 'pid-stat');
    },
  );
  it('abort before or during observation stops new reads and does not issue a proof', async () => {
    for (const preAbort of [true, false]) {
      const controller = new AbortController(),
        source = fixture(undefined, (_operation, _path, _count, value) => {
          controller.abort();
          return value;
        });
      if (preAbort) controller.abort();
      await expect(readBuilderKernelProof({ id, pid }, controller.signal, source.reader)).rejects.toThrow(
        'LOAD_BUILDER_UNVERIFIED',
      );
      expect(source.calls.length).toBe(preAbort ? 0 : 1);
    }
  });
  it('raw filesystem errors cannot leak paths, nested errors or forged diagnostics', async () => {
    const source = fixture(undefined, () => {
      throw Object.assign(new Error('private-canary', { cause: 'nested-canary' }), {
        path: '/private-canary',
        code: 'EACCES',
      });
    });
    await rejected(source, 'pid-stat');
    expect(
      builderKernelFailure(Object.assign(new Error('LOAD_BUILDER_UNVERIFIED'), { builderKernelCheck: 'limits' })),
    ).toBeUndefined();
  });
  it.each([
    { id: 'private-canary', pid },
    { id, pid: 0 },
    { id, pid: 1.5 },
    { id, pid: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects an invalid inspect identity before kernel reads', async (identity) => {
    const source = fixture();
    await expect(readBuilderKernelProof(identity, signal(), source.reader)).rejects.toThrow('LOAD_BUILDER_UNVERIFIED');
    expect(source.calls).toEqual([]);
  });
  it('a timeout signal received while an operation settles prohibits all subsequent operations', async () => {
    const controller = new AbortController(),
      source = fixture();
    let finish!: (text: string) => void;
    const reader: BuilderKernelReader = {
      ...source.reader,
      read: async () =>
        new Promise<string>((done) => {
          finish = done;
        }),
    };
    const pending = readBuilderKernelProof({ id, pid }, controller.signal, reader);
    controller.abort();
    finish(stat());
    await expect(pending).rejects.toThrow('LOAD_BUILDER_UNVERIFIED');
    expect(source.calls).toEqual([]);
  });
});
