import { describe, expect, it } from 'vitest';
import { admissionSite, evaluateAdmission, type AdmissionSample } from './admission';
import { LOAD_DOCKER } from './docker';
import {
  assertBootstrapScope,
  BOOTSTRAP_DOCKER,
  BOOTSTRAP_LIMIT_MS,
  bootstrapReason,
  BUILD_BUDGET,
  requireDispatch,
} from './bootstrap.mjs';

const GiB = 1024 ** 3;
const group = { memoryAvailable: 14 * GiB, cpuCapacity: 4, pressureSome: 0, pressureFull: 0 };
const sample: AdmissionSample = {
  at: 100000,
  cpuWindowMs: 60000,
  cores: 4,
  cpuUsedFraction: 0.04,
  memoryTotal: 16 * GiB,
  memoryAvailable: 14 * GiB,
  cgroups: [group, group],
  diskAvailable: [20 * GiB, 20 * GiB],
};
const site = admissionSite('github-hosted', {
  platform: 'linux',
  ubuntuVersion: '24.04',
  runnerWorkerAncestor: true,
  githubActions: 'true',
  runnerEnvironment: 'github-hosted',
  runnerOs: 'Linux',
  runId: '123',
});

describe('L5 의존성 설치 전 bootstrap 경계', () => {
  it('bootstrap와 동결된 심사 모델/daemon DTO의 임계값·실패 경로가 같다', () => {
    expect(BOOTSTRAP_DOCKER).toEqual(LOAD_DOCKER);
    expect(BOOTSTRAP_LIMIT_MS).toBe(300000);
    expect(BUILD_BUDGET).toEqual({ cpu: 1, memoryBytes: 2 * GiB, diskBytes: 4 * GiB });
    const patches: Partial<AdmissionSample>[] = [
      {},
      { cpuWindowMs: 59999 },
      { cpuWindowMs: 120001 },
      { at: 100001 },
      { at: -20001 },
      { cores: 0 },
      { cpuUsedFraction: NaN },
      { cpuUsedFraction: 1.01 },
      { cpuUsedFraction: 0.55 },
      { cpuUsedFraction: 0.55001 },
      { memoryTotal: 0 },
      { memoryAvailable: 3 * GiB },
      { memoryAvailable: 17 * GiB },
      { diskAvailable: [6 * GiB, 20 * GiB] },
      { diskAvailable: [6 * GiB - 1, 20 * GiB] },
      { cgroups: [group, { ...group, cpuCapacity: 1 }] },
      { cgroups: [group, { ...group, cpuCapacity: 0.999 }] },
      { cgroups: [{ ...group, memoryAvailable: 2 * GiB - 1 }, group] },
      { cgroups: [{ ...group, pressureSome: 10 }, group] },
      { cgroups: [group, { ...group, pressureFull: 1 }] },
    ];
    for (const patch of patches) {
      const value = { ...sample, ...patch };
      for (const options of [
        { now: 100000 },
        { now: 100000, cpuPercent: 101 },
        { now: 100000, memoryPercent: 0 },
        { now: 100000, diskReserveMiB: 8192 },
      ])
        expect(bootstrapReason(value, options)).toBe(evaluateAdmission(site, value, BUILD_BUDGET, options).reason);
    }
  });
  it('환경변수만으로 임의 fork나 다른 dispatch 소스를 실행하지 못한다', () => {
    const value = {
      repository: 'opensamguk/opensamguk',
      event: 'workflow_dispatch',
      expectedSha: 'a'.repeat(40),
      dispatchSha: 'a'.repeat(40),
      head: 'a'.repeat(40),
    };
    expect(() => requireDispatch(value)).not.toThrow();
    for (const patch of [
      { repository: 'untrusted/fork' },
      { event: 'push' },
      { head: 'b'.repeat(40) },
      { expectedSha: 'private-canary' },
      { dispatchSha: undefined },
    ])
      expect(() => requireDispatch({ ...value, ...patch })).toThrow(/^LOAD_DISPATCH_SOURCE_INVALID$/);
  });
  it('scope에서 실제 조상·비root·CPU·메모리·swap·고유경로 중 하나라도 불명이면 설치를 거부한다', () => {
    const runId = 'a'.repeat(32);
    const value = {
      runId,
      uid: 1001,
      runnerWorkerAncestor: true,
      cgroupText: `0::/system.slice/opensamguk-load-install-${runId}.scope\n`,
      cpuMax: '100000 100000',
      memoryMax: '2147483648',
      swapMax: '0',
    };
    expect(() => assertBootstrapScope(value)).not.toThrow();
    for (const patch of [
      { uid: 0 },
      { runnerWorkerAncestor: false },
      { cpuMax: 'max 100000' },
      { cpuMax: '200000 100000' },
      { memoryMax: 'max' },
      { memoryMax: '1073741824' },
      { swapMax: 'max' },
      { cgroupText: '0::/other.slice\n' },
      { runId: 'private-canary' },
    ])
      expect(() => assertBootstrapScope({ ...value, ...patch })).toThrow(/^LOAD_INSTALL_SCOPE_UNVERIFIED$/);
  });
});
