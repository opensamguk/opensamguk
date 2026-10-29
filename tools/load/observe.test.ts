import { describe, expect, it } from 'vitest';
import {
  cpuFraction,
  cgroupAncestorPaths,
  observationFromCounters,
  parseCgroup,
  parseCpuCounter,
  parseMemory,
  selfCgroupPath,
  sampleCgroupAncestors,
} from './observe';
import { admissionSite, evaluateAdmission } from './admission';

describe('L4 Linux 표본을 원문 비밀 없이 검증한다', () => {
  it('CPU guest를 중복 집계하지 않고 idle+iowait을 뺀다', () => {
    expect(parseCpuCounter('cpu  1 2 3 40 10 4 5 6 999 999\n')).toEqual({ total: 71, idle: 50 });
    expect(cpuFraction({ total: 10, idle: 5 }, { total: 110, idle: 95 })).toBe(0.1);
    expect(() => cpuFraction({ total: 10, idle: 5 }, { total: 10, idle: 5 })).toThrow();
    expect(() => parseCpuCounter('cpu 1 2 3')).toThrow();
  });
  it('MemAvailable은 MemFree 대체값 없이 필수다', () => {
    expect(parseMemory('MemTotal: 100 kB\nMemAvailable: 50 kB\n')).toEqual({ total: 102400, available: 51200 });
    expect(() => parseMemory('MemTotal: 100 kB\nMemFree: 50 kB\n')).toThrow();
  });
  it('무제한 cgroup도 실제 호스트 한도, PSI 경계, 유한 quota를 보존한다', () => {
    const files = {
      memoryMax: 'max',
      memoryCurrent: '100',
      cpuMax: 'max 100000',
      pressure: 'some avg10=0.00 avg60=0.00\nfull avg10=0.25 avg60=0.00\n',
    };
    expect(parseCgroup(files, { memoryAvailable: 500, cores: 4 })).toEqual({
      memoryAvailable: 500,
      cpuCapacity: 4,
      pressureSome: 0,
      pressureFull: 0.25,
    });
    expect(
      parseCgroup({ ...files, memoryMax: '200', cpuMax: '50000 100000' }, { memoryAvailable: 500, cores: 4 })
        .cpuCapacity,
    ).toBe(0.5);
    expect(() => parseCgroup({ ...files, cpuMax: 'max 0' }, { memoryAvailable: 500, cores: 4 })).toThrow();
    expect(() => parseCgroup({ ...files, pressure: '' }, { memoryAvailable: 500, cores: 4 })).toThrow();
  });
  it('cgroup 경로 역참조나 v1 자료를 허용하지 않는다', () => {
    expect(selfCgroupPath('0::/user.slice/worker\n')).toBe('/sys/fs/cgroup/user.slice/worker');
    expect(() => selfCgroupPath('0::/../../other\n')).toThrow();
    expect(() => selfCgroupPath('1:memory:/worker\n')).toThrow();
  });
  it('nested parent의 모든 조상을 수집하며 1CPU 상위 제한을 4CPU 호스트로 덮지 않는다', async () => {
    const paths: string[] = [];
    const evidence = await sampleCgroupAncestors(
      '/sys/fs/cgroup/system.slice/narrow.slice',
      { cores: 4, memoryAvailable: 14 * 1024 ** 3 },
      async (name) => {
        paths.push(name);
        if (name.endsWith('memory.current')) return '0';
        if (name.endsWith('memory.max')) return 'max';
        if (name.endsWith('cpu.max'))
          return name === '/sys/fs/cgroup/system.slice/cpu.max' ? '100000 100000' : 'max 100000';
        return 'some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n';
      },
    );
    expect(evidence.ancestors.map((row) => row.path)).toEqual([
      '/sys/fs/cgroup/system.slice/narrow.slice',
      '/sys/fs/cgroup/system.slice',
      '/sys/fs/cgroup',
    ]);
    expect(paths).toContain('/sys/fs/cgroup/system.slice/cpu.max');
    expect(evidence.sample.cpuCapacity).toBe(1);
    const site = admissionSite('github-hosted', {
      platform: 'linux',
      ubuntuVersion: '24.04',
      runnerWorkerAncestor: true,
      githubActions: 'true',
      runnerEnvironment: 'github-hosted',
      runnerOs: 'Linux',
      runId: '123',
    });
    expect(
      evaluateAdmission(
        site,
        {
          at: 100000,
          cpuWindowMs: 60000,
          cores: 4,
          cpuUsedFraction: 0,
          memoryTotal: 16 * 1024 ** 3,
          memoryAvailable: 14 * 1024 ** 3,
          cgroups: [evidence.sample, evidence.sample],
          diskAvailable: [20 * 1024 ** 3, 20 * 1024 ** 3],
        },
        { cpu: 3, memoryBytes: 5 * 1024 ** 3, diskBytes: 5 * 1024 ** 3 },
        { now: 100000 },
      ).reason,
    ).toBe('cgroup_headroom');
    expect(cgroupAncestorPaths('/sys/fs/cgroup')).toEqual(['/sys/fs/cgroup']);
    expect(() => cgroupAncestorPaths('/sys/fs/cgroup/system.slice/../other')).toThrow();
    await expect(
      sampleCgroupAncestors('/sys/fs/cgroup/unknown.slice', { cores: 4, memoryAvailable: 1 }, async () => {
        throw new Error('unreadable');
      }),
    ).rejects.toThrow();
  });
  it('Docker CPU %를 코어/생성기 quota로 정규화하고 OOM을 누락하지 않는다', () => {
    const sample = observationFromCounters({
      at: 1,
      before: { total: 0, idle: 0 },
      after: { total: 100, idle: 5 },
      hostCores: 4,
      containerCpuPercent: [10, 20, 20, 50],
      generatorCpuPercent: 50,
      generatorCpuLimit: 1,
      oomCounts: [0, 0, 1, 0],
    });
    expect(sample.generatorCpuFraction).toBe(0.5);
    expect(sample.externalHostCpuFraction).toBe(0.7);
    expect(sample.oomCount).toBe(1);
    expect(() =>
      observationFromCounters({
        at: 1,
        before: { total: 0, idle: 0 },
        after: { total: 100, idle: 5 },
        hostCores: 0,
        containerCpuPercent: [],
        generatorCpuPercent: 0,
        generatorCpuLimit: 1,
        oomCounts: [],
      }),
    ).toThrow();
  });
});
