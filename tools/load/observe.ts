import { readFile, readlink, statfs } from 'node:fs/promises';
import { posix, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AdmissionSample, CgroupSample, RunnerProvenance } from './admission';

export type CpuCounter = Readonly<{ total: number; idle: number }>;
export function parseCpuCounter(text: string): CpuCounter {
  const row = /^cpu\s+(.+)$/m.exec(text)?.[1]?.trim().split(/\s+/).slice(0, 8).map(Number);
  if (!row || row.length !== 8 || row.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error('LOAD_CPU_SAMPLE_INVALID');
  return { total: row.reduce((sum, value) => sum + value, 0), idle: row[3]! + row[4]! };
}
export function cpuFraction(before: CpuCounter, after: CpuCounter): number {
  const total = after.total - before.total,
    idle = after.idle - before.idle;
  if (total <= 0 || idle < 0 || idle > total) throw new Error('LOAD_CPU_SAMPLE_INVALID');
  return (total - idle) / total;
}
export function parseMemory(text: string): { total: number; available: number } {
  const amount = (key: string) => {
    const raw = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text)?.[1];
    const value = Number(raw) * 1024;
    if (raw === undefined || !Number.isSafeInteger(value) || value < 0 || (key === 'MemTotal' && value === 0))
      throw new Error('LOAD_MEMORY_SAMPLE_INVALID');
    return value;
  };
  const total = amount('MemTotal'),
    available = amount('MemAvailable');
  if (available > total) throw new Error('LOAD_MEMORY_SAMPLE_INVALID');
  return { total, available };
}
export function parseCgroup(
  files: { memoryMax: string; memoryCurrent: string; cpuMax: string; pressure: string },
  host: { memoryAvailable: number; cores: number },
): CgroupSample {
  const natural = (text: string) => {
    if (!/^\d+$/.test(text.trim())) throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
    const value = Number(text.trim());
    if (!Number.isSafeInteger(value)) throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
    return value;
  };
  const current = natural(files.memoryCurrent);
  const memoryAvailable =
    files.memoryMax.trim() === 'max' ? host.memoryAvailable : Math.max(0, natural(files.memoryMax) - current);
  const cpu = files.cpuMax.trim().split(/\s+/);
  if (cpu.length !== 2) throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
  const period = natural(cpu[1]!);
  if (period === 0) throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
  const cpuCapacity = cpu[0] === 'max' ? host.cores : natural(cpu[0]!) / period;
  const pressure = (kind: string) => {
    const raw = new RegExp(`^${kind} avg10=([0-9]+(?:\\.[0-9]+)?) `, 'm').exec(files.pressure)?.[1];
    if (raw === undefined || !Number.isFinite(Number(raw))) throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
    return Number(raw);
  };
  return { memoryAvailable, cpuCapacity, pressureSome: pressure('some'), pressureFull: pressure('full') };
}

export function selfCgroupPath(text: string): string {
  const path = /^0::(\/[^\r\n]*)$/m.exec(text)?.[1];
  if (!path || path.split('/').includes('..')) throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
  const absolute = posix.resolve('/sys/fs/cgroup', `.${path}`);
  if (absolute !== '/sys/fs/cgroup' && !absolute.startsWith('/sys/fs/cgroup/'))
    throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
  return absolute;
}

async function runnerAncestor(): Promise<boolean> {
  let pid = process.ppid;
  const visited = new Set<number>();
  for (let depth = 0; pid > 1 && depth < 32 && !visited.has(pid); depth++) {
    visited.add(pid);
    const [stat, executable] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readlink(`/proc/${pid}/exe`)]);
    // 커널이 보고한 실제 실행 파일과 조상 관계를 사용한다. CI 변수로 대체하지 않는다.
    if (/\/bin\/Runner\.Worker$/.test(executable)) return true;
    const parent = /^\d+ \(.+\) \S (\d+) /.exec(stat)?.[1];
    if (!parent) return false;
    pid = Number(parent);
  }
  return false;
}

export async function readRunnerProvenance(): Promise<RunnerProvenance> {
  let version = '',
    worker = false;
  if (process.platform === 'linux') {
    try {
      const release = await readFile('/etc/os-release', 'utf8');
      if (/^ID=ubuntu$/m.test(release)) version = /^VERSION_ID="?([^"\r\n]+)"?$/m.exec(release)?.[1] ?? '';
      worker = await runnerAncestor();
    } catch {
      /* 확인하지 못한 플랫폼은 거부한다. 원본 경로나 오류를 출력하지 않는다. */
    }
  }
  return {
    platform: process.platform,
    ubuntuVersion: version,
    runnerWorkerAncestor: worker,
    githubActions: process.env.GITHUB_ACTIONS,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
    runnerOs: process.env.RUNNER_OS,
    runId: process.env.GITHUB_RUN_ID,
  };
}

export function cgroupAncestorPaths(path: string): string[] {
  if (
    (path !== '/sys/fs/cgroup' && !path.startsWith('/sys/fs/cgroup/')) ||
    path !== posix.normalize(path) ||
    path.split('/').some((part) => part === '.' || part === '..') ||
    path.split('/').length > 64
  )
    throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
  const paths: string[] = [];
  let cursor = path;
  while (cursor !== '/sys/fs/cgroup') {
    if (!cursor.startsWith('/sys/fs/cgroup/')) throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
    paths.push(cursor);
    cursor = posix.dirname(cursor);
  }
  paths.push(cursor);
  return paths;
}

export async function sampleCgroupAncestors(
  path: string,
  host: { memoryAvailable: number; cores: number },
  read: (name: string) => Promise<string> = (name) => readFile(name, 'utf8'),
): Promise<{ sample: CgroupSample; ancestors: Array<CgroupSample & { path: string }> }> {
  const ancestors: Array<CgroupSample & { path: string }> = [];
  for (const group of cgroupAncestorPaths(path)) {
    if (group !== '/sys/fs/cgroup') ancestors.push({ path: group, ...(await oneGroupSample(group, host, read)) });
  }
  // cgroup 루트에는 quota 파일이 없을 수 있다. 루트는 실제 호스트 값과 전역 PSI로 제한한다.
  const pressure = await read('/proc/pressure/memory');
  ancestors.push({
    path: '/sys/fs/cgroup',
    ...parseCgroup({ memoryMax: 'max', memoryCurrent: '0', cpuMax: 'max 100000', pressure }, host),
  });
  return {
    ancestors,
    sample: {
      memoryAvailable: Math.min(...ancestors.map((row) => row.memoryAvailable)),
      cpuCapacity: Math.min(...ancestors.map((row) => row.cpuCapacity)),
      pressureSome: Math.max(...ancestors.map((row) => row.pressureSome)),
      pressureFull: Math.max(...ancestors.map((row) => row.pressureFull)),
    },
  };
}

async function oneGroupSample(
  path: string,
  host: { memoryAvailable: number; cores: number },
  read: (name: string) => Promise<string>,
): Promise<CgroupSample> {
  const [memoryMax, memoryCurrent, cpuMax, pressure] = await Promise.all(
    ['memory.max', 'memory.current', 'cpu.max', 'memory.pressure'].map((file) => read(`${path}/${file}`)),
  );
  if ([memoryMax, memoryCurrent, cpuMax, pressure].some((value) => value === undefined))
    throw new Error('LOAD_CGROUP_SAMPLE_INVALID');
  return parseCgroup(
    { memoryMax: memoryMax!, memoryCurrent: memoryCurrent!, cpuMax: cpuMax!, pressure: pressure! },
    host,
  );
}

export async function sampleAdmission(options: {
  dockerDataPath: string;
  reportPath: string;
  dockerCgroupPath: string;
  signal: AbortSignal;
}): Promise<
  AdmissionSample & {
    cgroupAncestors: readonly [Array<CgroupSample & { path: string }>, Array<CgroupSample & { path: string }>];
  }
> {
  if (
    process.platform !== 'linux' ||
    !isAbsolute(options.dockerDataPath) ||
    !isAbsolute(options.reportPath) ||
    !options.dockerCgroupPath.startsWith('/sys/fs/cgroup/')
  )
    throw new Error('LOAD_PLATFORM_UNVERIFIED');
  options.signal.throwIfAborted();
  const startedAt = Date.now(),
    before = parseCpuCounter(await readFile('/proc/stat', 'utf8'));
  await delay(60_000, undefined, { signal: options.signal });
  const [cpu, memoryText, cgroupText, dockerDisk, reportDisk, cpuInfo] = await Promise.all([
    readFile('/proc/stat', 'utf8'),
    readFile('/proc/meminfo', 'utf8'),
    readFile('/proc/self/cgroup', 'utf8'),
    statfs(options.dockerDataPath),
    statfs(options.reportPath),
    readFile('/proc/cpuinfo', 'utf8'),
  ]);
  options.signal.throwIfAborted();
  const memory = parseMemory(memoryText),
    cores = cpuInfo.match(/^processor\s*:/gm)?.length ?? 0;
  const host = { memoryAvailable: memory.available, cores };
  const cgroups = await Promise.all([
    sampleCgroupAncestors(selfCgroupPath(cgroupText), host),
    sampleCgroupAncestors(options.dockerCgroupPath, host),
  ]);
  return {
    at: Date.now(),
    cpuWindowMs: Date.now() - startedAt,
    cores,
    cpuUsedFraction: cpuFraction(before, parseCpuCounter(cpu)),
    memoryTotal: memory.total,
    memoryAvailable: memory.available,
    cgroups: [cgroups[0]!.sample, cgroups[1]!.sample],
    cgroupAncestors: [cgroups[0]!.ancestors, cgroups[1]!.ancestors],
    diskAvailable: [dockerDisk.bavail * dockerDisk.bsize, reportDisk.bavail * reportDisk.bsize],
  };
}

export function observationFromCounters(input: {
  at: number;
  before: CpuCounter;
  after: CpuCounter;
  hostCores: number;
  containerCpuPercent: readonly number[];
  generatorCpuPercent: number;
  generatorCpuLimit: number;
  oomCounts: readonly number[];
}) {
  const all = [
    input.at,
    input.hostCores,
    input.generatorCpuPercent,
    input.generatorCpuLimit,
    ...input.containerCpuPercent,
    ...input.oomCounts,
  ];
  if (
    all.some((value) => !Number.isFinite(value) || value < 0) ||
    input.hostCores === 0 ||
    input.generatorCpuLimit === 0
  )
    throw new Error('LOAD_RUNTIME_SAMPLE_INVALID');
  const host = cpuFraction(input.before, input.after);
  const ownedHost = input.containerCpuPercent.reduce((sum, value) => sum + value, 0) / (100 * input.hostCores);
  return {
    at: input.at,
    generatorCpuFraction: input.generatorCpuPercent / (100 * input.generatorCpuLimit),
    externalHostCpuFraction: Math.max(0, host - ownedHost),
    oomCount: input.oomCounts.reduce((sum, value) => sum + value, 0),
  };
}
