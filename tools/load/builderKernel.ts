import { lstat, readFile, readlink, realpath, statfs } from 'node:fs/promises';
import { LOAD_DOCKER } from './docker';

type Directory = Readonly<{ directory: boolean; symlink: boolean; dev: string; ino: string }>;
export type BuilderKernelReader = Readonly<{
  read(path: string, signal: AbortSignal): Promise<string>;
  directory(path: string): Promise<Directory>;
  canonical(path: string): Promise<string>;
  link(path: string): Promise<string>;
  targetNamespace(pid: number, signal: AbortSignal): Promise<string>;
  filesystem(path: string): Promise<number>;
}>;
const nativeReader: BuilderKernelReader = {
  read: (path, signal) => readFile(path, { encoding: 'utf8', signal }),
  directory: async (path) => {
    const row = await lstat(path, { bigint: true });
    return { directory: row.isDirectory(), symlink: row.isSymbolicLink(), dev: String(row.dev), ino: String(row.ino) };
  },
  canonical: realpath,
  link: readlink,
  targetNamespace: (pid) => readlink(`/proc/${pid}/ns/cgroup`),
  filesystem: async (path) => (await statfs(path)).type,
};
// Reading another UID's namespace handle requires ptrace read permission.
// https://man7.org/linux/man-pages/man7/namespaces.7.html
// The caller owns the bounded sudo child; this adapter permits exactly one validated PID/path.
export function builderNamespaceReader(
  command: (args: readonly string[], signal: AbortSignal) => Promise<string>,
): BuilderKernelReader {
  return Object.freeze({
    ...nativeReader,
    targetNamespace: async (pid: number, signal: AbortSignal) => {
      try {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
        const text = await command(['-n', '/usr/bin/readlink', '--', `/proc/${pid}/ns/cgroup`], signal);
        signal.throwIfAborted();
        if (!/^cgroup:\[[1-9]\d*\]\n?$/.test(text)) throw new Error();
        return text.trimEnd();
      } catch {
        throw new Error('LOAD_BUILDER_UNVERIFIED');
      }
    },
  });
}
type Check =
  | 'identity'
  | 'pid-stat'
  | 'unified-path'
  | 'namespace'
  | 'filesystem'
  | 'directory'
  | 'limits'
  | 'cpu-max'
  | 'memory-max'
  | 'swap-max'
  | 'stable'
  | 'aborted';
const failures = new WeakMap<Error, Check>();
export function builderKernelFailure(error: unknown): Check | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}
type Identity = Readonly<{ id: string; pid: number }>;
export type BuilderKernelProof = Readonly<{
  cgroupText: string;
  observed: Readonly<{
    processStartTime: string;
    descendantDepth: number;
    cpuQuota: 100000;
    cpuPeriod: 100000;
    memoryMax: 2147483648;
    swapMax: 0;
    stable: true;
  }>;
}>;
const proofs = new WeakMap<BuilderKernelProof, Identity & { cgroupText: string }>();
export function builderKernelMatches(proof: unknown, identity: Identity & { cgroupText: string }): boolean {
  if (proof === null || typeof proof !== 'object') return false;
  const row = proofs.get(proof as BuilderKernelProof);
  return row?.id === identity.id && row.pid === identity.pid && row.cgroupText === identity.cgroupText;
}

function processBirth(text: string, pid: number): string {
  const close = text.lastIndexOf(')'),
    fields = text
      .slice(close + 1)
      .trim()
      .split(/\s+/),
    start = fields[19]; // /proc/PID/stat field 22; comm may itself contain ')'.
  if (
    !text.startsWith(`${pid} (`) ||
    close < 0 ||
    !/^[RSDTtIWPK]$/.test(fields[0] ?? '') ||
    start === undefined ||
    !/^[1-9]\d*$/.test(start)
  )
    throw new Error();
  return start;
}
function ownedPath(text: string, id: string) {
  const raw = /^0::(\/[^\r\n]*)\n?$/.exec(text)?.[1];
  if (raw === undefined || raw.length > 4096) throw new Error();
  const parts = raw.slice(1).split('/'),
    scope = `docker-${id}.scope`;
  if (
    parts[0] !== LOAD_DOCKER.cgroupParent ||
    parts[1] !== scope ||
    parts.length > 34 ||
    parts.some(
      (part, index) =>
        !part ||
        part.length > 255 ||
        part === '.' ||
        part === '..' ||
        [...part].some(
          (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === '\\',
        ) ||
        (index > 1 && /^docker-.*\.scope$/.test(part)),
    )
  )
    throw new Error();
  return { path: `/sys/fs/cgroup${raw}`, depth: parts.length - 2, parts };
}

// cgroup v2 limits constrain descendants; their leaf need not be the container scope itself.
// https://docs.kernel.org/admin-guide/cgroup-v2.html#top-down-constraint
// https://docs.kernel.org/admin-guide/cgroup-v2.html#limits
// An owned path alone is insufficient: attest the actual ancestor limits and stable kernel identity.
export async function readBuilderKernelProof(
  input: Identity,
  signal: AbortSignal,
  reader: BuilderKernelReader = nativeReader,
): Promise<BuilderKernelProof> {
  let check: Check = 'identity';
  const step = async <T>(kind: Check, action: () => Promise<T>): Promise<T> => {
    check = 'aborted';
    signal.throwIfAborted();
    check = kind;
    const value = await action();
    check = 'aborted';
    signal.throwIfAborted();
    check = kind;
    return value;
  };
  try {
    const identity = Object.freeze({ id: input.id, pid: input.pid });
    if (!/^[a-f0-9]{64}$/.test(identity.id) || !Number.isSafeInteger(identity.pid) || identity.pid <= 0)
      throw new Error();
    const proc = `/proc/${identity.pid}`,
      birth = await step('pid-stat', async () => processBirth(await reader.read(`${proc}/stat`, signal), identity.pid)),
      cgroupText = await step('unified-path', () => reader.read(`${proc}/cgroup`, signal));
    check = 'unified-path';
    const location = ownedPath(cgroupText, identity.id),
      scope = `${LOAD_DOCKER.cgroupPath}/docker-${identity.id}.scope`;
    const namespaces = async () => {
      const own = await step('namespace', () => reader.link('/proc/self/ns/cgroup')),
        target = await step('namespace', () => reader.targetNamespace(identity.pid, signal)),
        mount = await step('namespace', () => reader.link('/proc/self/ns/mnt'));
      check = 'namespace';
      if (
        !/^cgroup:\[[1-9]\d*\]$/.test(own) ||
        !/^cgroup:\[[1-9]\d*\]$/.test(target) ||
        own === target ||
        !/^mnt:\[[1-9]\d*\]$/.test(mount)
      )
        throw new Error();
      return { own, target, mount };
    };
    const beforeNamespaces = await namespaces();
    const directories = ['/sys/fs/cgroup'];
    for (const part of location.parts) directories.push(`${directories.at(-1)!}/${part}`);
    const sampleDirectories = async () => {
      const result: Directory[] = [];
      for (const path of directories) {
        const row = await step('directory', () => reader.directory(path)),
          canonical = await step('directory', () => reader.canonical(path));
        check = 'directory';
        if (
          !row.directory ||
          row.symlink ||
          canonical !== path ||
          !/^\d+$/.test(row.dev) ||
          !/^[1-9]\d*$/.test(row.ino)
        )
          throw new Error();
        check = 'filesystem';
        if ((await step('filesystem', () => reader.filesystem(path))) !== 0x63677270) throw new Error();
        result.push(row);
      }
      return result;
    };
    const beforeDirectories = await sampleDirectories();
    const limits = async () => {
      const cpu = await step('limits', () => reader.read(`${scope}/cpu.max`, signal)),
        memory = await step('limits', () => reader.read(`${scope}/memory.max`, signal)),
        swap = await step('limits', () => reader.read(`${scope}/memory.swap.max`, signal));
      check = 'cpu-max';
      if (!/^100000 100000\n?$/.test(cpu)) throw new Error();
      check = 'memory-max';
      if (!/^2147483648\n?$/.test(memory)) throw new Error();
      check = 'swap-max';
      if (!/^0\n?$/.test(swap)) throw new Error();
      return { cpu, memory, swap };
    };
    const beforeLimits = await limits(),
      afterDirectories = await sampleDirectories(),
      afterLimits = await limits(),
      afterNamespaces = await namespaces(),
      afterCgroup = await step('unified-path', () => reader.read(`${proc}/cgroup`, signal)),
      afterBirth = await step('pid-stat', async () =>
        processBirth(await reader.read(`${proc}/stat`, signal), identity.pid),
      );
    check = 'stable';
    if (
      birth !== afterBirth ||
      cgroupText !== afterCgroup ||
      JSON.stringify(beforeDirectories) !== JSON.stringify(afterDirectories) ||
      JSON.stringify(beforeLimits) !== JSON.stringify(afterLimits) ||
      JSON.stringify(beforeNamespaces) !== JSON.stringify(afterNamespaces)
    )
      throw new Error();
    const proof: BuilderKernelProof = Object.freeze({
      cgroupText,
      observed: Object.freeze({
        processStartTime: birth,
        descendantDepth: location.depth,
        cpuQuota: 100000,
        cpuPeriod: 100000,
        memoryMax: 2147483648,
        swapMax: 0,
        stable: true,
      }),
    });
    proofs.set(proof, { ...identity, cgroupText });
    return proof;
  } catch {
    const error = new Error('LOAD_BUILDER_UNVERIFIED');
    failures.set(error, check);
    throw error;
  }
}
