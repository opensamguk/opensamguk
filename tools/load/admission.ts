import { parse } from 'yaml';

const MiB = 1024 ** 2;
export const LOAD_LIMITS = Object.freeze({ setupMs: 180_000, bodyMs: 1_200_000, cleanupMs: 300_000 });
export type LoadBudget = Readonly<{ cpu: number; memoryBytes: number; diskBytes: number }>;
export type AdmissionReason =
  | 'site_mismatch'
  | 'pool_unconfigured'
  | 'platform_unverified'
  | 'sample_invalid'
  | 'cpu_limit'
  | 'memory_limit'
  | 'cgroup_headroom'
  | 'disk_reserve'
  | 'compose_limits_invalid';
export type CgroupSample = Readonly<{
  memoryAvailable: number;
  cpuCapacity: number;
  pressureSome: number;
  pressureFull: number;
}>;
export type AdmissionSample = Readonly<{
  at: number;
  cpuWindowMs: number;
  cores: number;
  cpuUsedFraction: number;
  memoryTotal: number;
  memoryAvailable: number;
  cgroups: readonly [CgroupSample, CgroupSample];
  diskAvailable: readonly [number, number];
}>;
export type RunnerProvenance = Readonly<{
  platform: string;
  ubuntuVersion: string;
  runnerWorkerAncestor: boolean;
  githubActions: string | undefined;
  runnerEnvironment: string | undefined;
  runnerOs: string | undefined;
  runId: string | undefined;
}>;
export type Admission = Readonly<{
  accepted: boolean;
  exitCode: 0 | 75;
  reason: AdmissionReason | null;
  site: 'github-hosted' | 'shared';
}>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LOAD_COMPOSE_LIMITS_INVALID');
  return value as Record<string, unknown>;
}

function memoryBytes(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string') throw new Error('LOAD_COMPOSE_LIMITS_INVALID');
  const match = /^(\d+)([kmg])?b?$/i.exec(value);
  if (!match) throw new Error('LOAD_COMPOSE_LIMITS_INVALID');
  const multiplier = { k: 1024, m: MiB, g: 1024 ** 3 }[match[2]?.toLowerCase() ?? ''] ?? 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('LOAD_COMPOSE_LIMITS_INVALID');
  return bytes;
}

// 실제 실행할 compose 값을 합산한다. 누락된 서비스나 무제한 값을 기본값으로 채우지 않는다.
export function composeBudget(source: string, mode: 'formal' | 'smoke'): LoadBudget {
  const services = object(object(parse(source)).services);
  const expected = ['postgres', 'server', 'engine', 'generator'];
  if (Object.keys(services).sort().join(',') !== [...expected].sort().join(','))
    throw new Error('LOAD_COMPOSE_LIMITS_INVALID');
  let cpu = 0,
    memory = 0;
  for (const name of expected) {
    const service = object(services[name]);
    if (typeof service.cpus !== 'number' || !Number.isFinite(service.cpus) || service.cpus <= 0)
      throw new Error('LOAD_COMPOSE_LIMITS_INVALID');
    cpu += service.cpus;
    memory += memoryBytes(service.mem_limit);
  }
  const expectedCpu = mode === 'formal' ? 3 : 1.25;
  const expectedMemory = (mode === 'formal' ? 5 : 2.5) * 1024 ** 3;
  if (cpu !== expectedCpu || memory !== expectedMemory) throw new Error('LOAD_COMPOSE_LIMITS_INVALID');
  return { cpu, memoryBytes: memory, diskBytes: (mode === 'formal' ? 5 : 3) * 1024 ** 3 };
}

export function admissionSite(requested: string | undefined, evidence: RunnerProvenance): Admission {
  if (requested === undefined) return { accepted: false, exitCode: 75, reason: 'pool_unconfigured', site: 'shared' };
  const rejected = (reason: AdmissionReason): Admission => ({
    accepted: false,
    exitCode: 75,
    reason,
    site: 'github-hosted',
  });
  if (
    requested !== 'github-hosted' ||
    evidence.githubActions !== 'true' ||
    evidence.runnerEnvironment !== 'github-hosted'
  )
    return rejected('site_mismatch');
  // 환경변수만 꾸민 로컬 Linux를 공개 실행기의 증거로 인정하지 않는다.
  if (
    evidence.platform !== 'linux' ||
    evidence.ubuntuVersion !== '24.04' ||
    evidence.runnerOs !== 'Linux' ||
    !/^\d+$/.test(evidence.runId ?? '') ||
    !evidence.runnerWorkerAncestor
  )
    return rejected('platform_unverified');
  return { accepted: true, exitCode: 0, reason: null, site: 'github-hosted' };
}

export function evaluateAdmission(
  site: Admission,
  sample: AdmissionSample,
  budget: LoadBudget,
  options: { now: number; cpuPercent?: number; memoryPercent?: number; diskReserveMiB?: number },
): Admission {
  if (!site.accepted) return site;
  const reject = (reason: AdmissionReason): Admission => ({ ...site, accepted: false, exitCode: 75, reason });
  const cpuPercent = options.cpuPercent ?? 80;
  const memoryPercent = options.memoryPercent ?? 80;
  const reserve = (options.diskReserveMiB ?? 2048) * MiB;
  const values = [
    sample.at,
    sample.cpuWindowMs,
    sample.cores,
    sample.cpuUsedFraction,
    sample.memoryTotal,
    sample.memoryAvailable,
    budget.cpu,
    budget.memoryBytes,
    budget.diskBytes,
    options.now,
    cpuPercent,
    memoryPercent,
    reserve,
    ...sample.diskAvailable,
    ...sample.cgroups.flatMap((row) => [row.cpuCapacity, row.memoryAvailable, row.pressureSome, row.pressureFull]),
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    sample.cpuWindowMs < 60_000 ||
    sample.cpuWindowMs > 120_000 ||
    options.now < sample.at ||
    options.now - sample.at > 120_000 ||
    sample.cores < 1 ||
    sample.memoryTotal === 0 ||
    sample.memoryAvailable > sample.memoryTotal ||
    sample.cpuUsedFraction > 1 ||
    cpuPercent < 1 ||
    cpuPercent > 100 ||
    memoryPercent < 1 ||
    memoryPercent > 100 ||
    budget.cpu === 0 ||
    budget.memoryBytes === 0 ||
    budget.diskBytes === 0
  )
    return reject('sample_invalid');
  if (budget.cpu > sample.cores || (cpuPercent / 100 - sample.cpuUsedFraction) * sample.cores < budget.cpu)
    return reject('cpu_limit');
  if (sample.memoryAvailable - sample.memoryTotal * (1 - memoryPercent / 100) - 128 * MiB < budget.memoryBytes)
    return reject('memory_limit');
  if (
    sample.cgroups.some(
      (group) =>
        group.memoryAvailable < budget.memoryBytes ||
        group.cpuCapacity < budget.cpu ||
        group.pressureSome >= 10 ||
        group.pressureFull >= 1,
    )
  )
    return reject('cgroup_headroom');
  if (sample.diskAvailable.some((available) => available - reserve < budget.diskBytes)) return reject('disk_reserve');
  return site;
}
