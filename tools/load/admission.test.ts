import { describe, expect, it } from 'vitest';
import {
  admissionSite,
  composeBudget,
  evaluateAdmission,
  type AdmissionSample,
  type RunnerProvenance,
} from './admission';

const GiB = 1024 ** 3;
const provenance: RunnerProvenance = {
  platform: 'linux',
  ubuntuVersion: '24.04',
  runnerWorkerAncestor: true,
  githubActions: 'true',
  runnerEnvironment: 'github-hosted',
  runnerOs: 'Linux',
  runId: '123',
};
const site = admissionSite('github-hosted', provenance);
const sample: AdmissionSample = {
  at: 100_000,
  cpuWindowMs: 60_000,
  cores: 4,
  cpuUsedFraction: 0.04,
  memoryTotal: 16 * GiB,
  memoryAvailable: 14 * GiB,
  cgroups: [
    { memoryAvailable: 14 * GiB, cpuCapacity: 4, pressureSome: 0, pressureFull: 0 },
    { memoryAvailable: 14 * GiB, cpuCapacity: 4, pressureSome: 0, pressureFull: 0 },
  ],
  diskAvailable: [20 * GiB, 20 * GiB],
};
const budget = { cpu: 3, memoryBytes: 5 * GiB, diskBytes: 5 * GiB };
const evaluate = (row: AdmissionSample) => evaluateAdmission(site, row, budget, { now: sample.at });

describe('L4 실제 자원 심사 경계', () => {
  it('명시 모드가 없으면 CI 변수와 관계없이 예약 미설정으로 거부한다', () => {
    expect(admissionSite(undefined, provenance)).toMatchObject({ exitCode: 75, reason: 'pool_unconfigured' });
  });
  it('환경쌍이 다르면 site_mismatch, 로컬 환경 위장은 platform_unverified다', () => {
    expect(admissionSite('github-hosted', { ...provenance, githubActions: undefined }).reason).toBe('site_mismatch');
    expect(admissionSite('github-hosted', { ...provenance, runnerWorkerAncestor: false }).reason).toBe(
      'platform_unverified',
    );
    expect(admissionSite('github-hosted', { ...provenance, platform: 'win32' }).reason).toBe('platform_unverified');
  });
  it('여유가 충분한 실제 표본을 허용한다', () => expect(evaluate(sample).accepted).toBe(true));
  it('2코어 호스트와 1분 미만 CPU 표본을 거부한다', () => {
    expect(evaluate({ ...sample, cores: 2 }).reason).toBe('cpu_limit');
    expect(evaluate({ ...sample, cpuWindowMs: 59_999 }).reason).toBe('sample_invalid');
  });
  it('최근 CPU 사용량, 128MiB 시작 예약, 두 파일시스템 예비를 각각 적용한다', () => {
    expect(evaluate({ ...sample, cpuUsedFraction: 0.051 }).reason).toBe('cpu_limit');
    expect(evaluate({ ...sample, memoryAvailable: 8.2 * GiB }).reason).toBe('memory_limit');
    expect(evaluate({ ...sample, diskAvailable: [20 * GiB, 7 * GiB - 1] }).reason).toBe('disk_reserve');
    expect(evaluate({ ...sample, diskAvailable: [7 * GiB, 7 * GiB] }).accepted).toBe(true);
  });
  it.each([{ cpuCapacity: 2.99 }, { memoryAvailable: 5 * GiB - 1 }, { pressureSome: 10 }, { pressureFull: 1 }])(
    '실행기/부모 cgroup 한쪽만 부족해도 거부한다: %j',
    (patch) => {
      expect(evaluate({ ...sample, cgroups: [sample.cgroups[0], { ...sample.cgroups[1], ...patch }] }).reason).toBe(
        'cgroup_headroom',
      );
    },
  );
  it('오래되거나 미래인 표본, 누락/NaN, 잘못된 한도를 허용하지 않는다', () => {
    expect(evaluateAdmission(site, sample, budget, { now: 220_001 }).reason).toBe('sample_invalid');
    expect(evaluate({ ...sample, at: sample.at + 1 }).reason).toBe('sample_invalid');
    expect(evaluate({ ...sample, cpuUsedFraction: NaN }).reason).toBe('sample_invalid');
    expect(evaluateAdmission(site, sample, budget, { now: sample.at, cpuPercent: 101 }).reason).toBe('sample_invalid');
  });
  it('compose 실제 네 서비스 제한 합만 인정하며 누락/추가/예산 차이를 거부한다', () => {
    const source =
      'services:\n  postgres: {cpus: 1, mem_limit: 2g}\n  server: {cpus: 0.5, mem_limit: 1g}\n  engine: {cpus: 0.5, mem_limit: 1g}\n  generator: {cpus: 1, mem_limit: 1g}\n';
    expect(composeBudget(source, 'formal')).toEqual(budget);
    expect(() => composeBudget(source.replace('cpus: 1, mem_limit: 2g', 'mem_limit: 2g'), 'formal')).toThrow(
      'LOAD_COMPOSE_LIMITS_INVALID',
    );
    expect(() => composeBudget(source + '  extra: {cpus: 1, mem_limit: 1g}\n', 'formal')).toThrow();
    expect(() => composeBudget(source.replace('2g', '1g'), 'formal')).toThrow();
    expect(() => composeBudget(source, 'smoke')).toThrow();
  });
});
