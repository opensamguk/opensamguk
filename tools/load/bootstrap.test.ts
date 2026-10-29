import { describe, expect, it } from 'vitest';
import { admissionSite, evaluateAdmission, type AdmissionSample } from './admission';
import { LOAD_DOCKER } from './docker';
import {
  assertBootstrapScope,
  BOOTSTRAP_DOCKER,
  BOOTSTRAP_LIMIT_MS,
  bootstrapReason,
  bootstrapDiagnostic,
  parseBootstrapDiagnostic,
  BUILD_BUDGET,
  requireDispatch,
  findWorkerAncestor,
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
  function ancestors(rows: Record<number, { parent: number; exe: string | Error; uid?: string; statusPid?: number }>) {
    const visited: number[] = [];
    return {
      visited,
      stat: async (pid: number) => {
        visited.push(pid);
        return `${pid} (ancestor (name)) S ${rows[pid]!.parent} 0 0`;
      },
      exe: async (pid: number) => {
        const value = rows[pid]!.exe;
        if (value instanceof Error) throw value;
        return value;
      },
      status: async (pid: number) => `Pid:\t${rows[pid]!.statusPid ?? pid}\nUid:\t${rows[pid]!.uid ?? '0 0 0 0'}\n`,
    };
  }
  it.each(['EACCES', 'EPERM'])('root 중간 조상의 %s만 넘고 실제 Runner.Worker 실행 파일을 확인한다', async (code) => {
    const denied = Object.assign(new Error('private-canary'), { code });
    const reader = ancestors({
      4: { parent: 3, exe: denied },
      3: { parent: 2, exe: '/usr/bin/sudo' },
      2: { parent: 1, exe: '/home/runner/actions-runner/bin/Runner.Worker', uid: '1001 1001 1001 1001' },
    });
    await expect(findWorkerAncestor(4, reader, 1001)).resolves.toBe(true);
    expect(reader.visited).toEqual([4, 3, 2]);
    await expect(findWorkerAncestor(4, ancestors({ 4: { parent: 1, exe: denied } }), 1001)).resolves.toBe(false);
  });
  it.each(['EACCES', 'EPERM'])(
    '현재 실행 UID와 root로만 구성된 조상의 %s도 실제 Worker 증명을 요구한다',
    async (code) => {
      const denied = Object.assign(new Error('private-canary'), { code });
      for (const uid of ['1001 1001 1001 1001', '0 1001 0 1001', '1001 0 1001 0']) {
        const reader = ancestors({
          4: { parent: 2, exe: denied, uid },
          2: { parent: 1, exe: '/home/runner/actions-runner/bin/Runner.Worker' },
        });
        await expect(findWorkerAncestor(4, reader, 1001)).resolves.toBe(true);
        expect(reader.visited).toEqual([4, 2]);
        await expect(findWorkerAncestor(4, ancestors({ 4: { parent: 1, exe: denied, uid } }), 1001)).resolves.toBe(
          false,
        );
        await expect(findWorkerAncestor(4, ancestors({ 4: { parent: 2, exe: denied, uid } }), 2001)).rejects.toBe(
          denied,
        );
      }
    },
  );
  it('신뢰할 실행 UID가 없으면 환경이나 실제 Worker 경로로 대신하지 않는다', async () => {
    const reader = ancestors({ 4: { parent: 1, exe: '/bin/Runner.Worker' } });
    for (const uid of [0, -1, NaN, Infinity, 1001.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(findWorkerAncestor(4, reader, uid)).resolves.toBe(false);
    expect(reader.visited).toEqual([]);
  });
  it.each(['2001 2001 2001 2001', '0 2001 0 0', '0 0 0 2001', '0 0 0'])(
    'root·현재 실행 UID 외의 값이나 잘못된 UID %s를 거부한다',
    async (uid) => {
      const denied = Object.assign(new Error('private-canary'), { code: 'EACCES' });
      await expect(findWorkerAncestor(4, ancestors({ 4: { parent: 2, exe: denied, uid } }), 1001)).rejects.toBe(denied);
      await expect(
        findWorkerAncestor(4, ancestors({ 4: { parent: 2, exe: denied, statusPid: 5 } }), 1001),
      ).rejects.toBe(denied);
    },
  );
  it.each(['ENOENT', 'EIO'])('root라도 exe의 %s 오류는 건너뛰지 않는다', async (code) => {
    const failure = Object.assign(new Error('private-canary'), { code });
    await expect(findWorkerAncestor(4, ancestors({ 4: { parent: 2, exe: failure } }), 1001)).rejects.toBe(failure);
  });
  it('status 읽기 실패·PID 불일치·depth·cycle·가짜 worker 경로는 통과하지 못한다', async () => {
    const denied = Object.assign(new Error('private-canary'), { code: 'EPERM' });
    const reader = ancestors({ 4: { parent: 2, exe: denied } });
    const failure = Object.assign(new Error('private-canary'), { code: 'ENOENT' });
    await expect(
      findWorkerAncestor(
        4,
        {
          ...reader,
          status: async () => {
            throw failure;
          },
        },
        1001,
      ),
    ).rejects.toBe(failure);
    await expect(findWorkerAncestor(4, { ...reader, stat: async () => '5 (x) S 2 0' }, 1001)).resolves.toBe(false);
    const deep = ancestors(
      Object.fromEntries(
        Array.from({ length: 34 }, (_, i) => [
          i + 2,
          {
            parent: i + 3,
            exe: i === 32 ? '/bin/Runner.Worker' : '/usr/bin/sudo',
          },
        ]),
      ),
    );
    await expect(findWorkerAncestor(2, deep, 1001)).resolves.toBe(false);
    expect(deep.visited).toHaveLength(32);
    await expect(findWorkerAncestor(3, deep, 1001)).resolves.toBe(true);
    const cycle = ancestors({ 4: { parent: 3, exe: '/usr/bin/sudo' }, 3: { parent: 4, exe: '/usr/bin/sudo' } });
    await expect(findWorkerAncestor(4, cycle, 1001)).resolves.toBe(false);
    expect(cycle.visited).toEqual([4, 3]);
    await expect(
      findWorkerAncestor(4, ancestors({ 4: { parent: 1, exe: '/bin/Runner.Worker.fake' } }), 1001),
    ).resolves.toBe(false);
  });
  it('잘못된 PID·PPID·stat 오류는 exe 증명이나 root 상태로 대신하지 않는다', async () => {
    const reader = ancestors({ 4: { parent: 2, exe: '/bin/Runner.Worker' } });
    for (const pid of [1, 0, -1, 4.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])
      await expect(findWorkerAncestor(pid, reader, 1001)).resolves.toBe(false);
    expect(reader.visited).toEqual([]);
    for (const stat of ['bad-stat', '4 (x) S 9007199254740992 0', '4 (x) S -1 0'])
      await expect(findWorkerAncestor(4, { ...reader, stat: async () => stat }, 1001)).resolves.toBe(false);
    const failure = Object.assign(new Error('private-canary'), { code: 'EACCES' });
    await expect(
      findWorkerAncestor(
        4,
        {
          ...reader,
          stat: async () => {
            throw failure;
          },
        },
        1001,
      ),
    ).rejects.toBe(failure);
  });
  it.each([
    ['stat', 'LOAD_BOOTSTRAP_ANCESTOR_STAT_READ_FAILED'],
    ['exe', 'LOAD_BOOTSTRAP_ANCESTOR_EXE_READ_FAILED'],
    ['status', 'LOAD_BOOTSTRAP_ANCESTOR_STATUS_READ_FAILED'],
    ['pid', 'LOAD_BOOTSTRAP_ANCESTOR_EXE_DENIED_STATUS_PID_INVALID'],
    ['uid', 'LOAD_BOOTSTRAP_ANCESTOR_EXE_DENIED_STATUS_UID_INVALID'],
    ['nonroot', 'LOAD_BOOTSTRAP_ANCESTOR_EXE_DENIED_FOREIGN_UID'],
  ])('조상 %s 실패는 원래 오류·errno를 유지하고 고정 연산 코드만 공개한다', async (operation, code) => {
    const canary = 'private-canary postgres://user:password@host/db /proc/987/exe';
    const failure = Object.assign(new Error(canary), { code: operation === 'exe' ? 'EIO' : 'EACCES', path: canary });
    const denied = Object.assign(new Error(canary), { code: 'EPERM' });
    const reader = ancestors({ 4: { parent: 2, exe: operation === 'exe' ? failure : denied } });
    if (operation === 'stat')
      reader.stat = async () => {
        throw failure;
      };
    if (operation === 'status')
      reader.status = async () => {
        throw failure;
      };
    if (operation === 'pid') reader.status = async () => 'Pid: 5\nUid: 0 0 0 0\n';
    if (operation === 'uid') reader.status = async () => 'Pid: 4\nUid: 0 0 0\n';
    if (operation === 'nonroot') reader.status = async () => 'Pid: 4\nUid: 0 2001 0 0\n';
    const expected = ['stat', 'exe', 'status'].includes(operation) ? failure : denied;
    const keys = Object.keys(expected);
    await expect(findWorkerAncestor(4, reader, 1001)).rejects.toBe(expected);
    expect(expected.code).toBe(expected === failure ? (operation === 'exe' ? 'EIO' : 'EACCES') : 'EPERM');
    expect(expected.message).toBe(canary);
    expect(Object.keys(expected)).toEqual(keys);
    const result = bootstrapDiagnostic('platform', expected);
    expect(result).toEqual({ phase: 'platform', code, admissionReason: null });
    expect(JSON.stringify(result)).not.toContain('private-canary');
  });
  it.each([
    'LOAD_BOOTSTRAP_OS_RELEASE_READ_FAILED',
    'LOAD_BOOTSTRAP_ANCESTOR_STAT_READ_FAILED',
    'LOAD_BOOTSTRAP_ANCESTOR_EXE_READ_FAILED',
    'LOAD_BOOTSTRAP_ANCESTOR_STATUS_READ_FAILED',
    'LOAD_BOOTSTRAP_ANCESTOR_EXE_DENIED_STATUS_PID_INVALID',
    'LOAD_BOOTSTRAP_ANCESTOR_EXE_DENIED_STATUS_UID_INVALID',
    'LOAD_BOOTSTRAP_ANCESTOR_EXE_DENIED_NONROOT',
    'LOAD_BOOTSTRAP_ANCESTOR_EXE_DENIED_FOREIGN_UID',
  ])('자식의 %s 고정 코드만 허용하고 연산 원자료는 거부한다', (code) => {
    const result = { phase: 'platform', code, admissionReason: null };
    expect(bootstrapDiagnostic('platform', new Error(code))).toEqual(result);
    const value = {
      ...result,
      event: 'LOAD_BOOTSTRAP_DIAGNOSTIC',
      innerDiagnostic: null,
      scopeAttempted: false,
      scopeClosed: false,
      pending: 0,
      cleanupFailed: false,
    };
    expect(parseBootstrapDiagnostic(JSON.stringify(value))).toEqual(result);
    for (const patch of [
      { code: code + ': private-canary' },
      { operation: 'private-canary' },
      { path: '/proc/987/exe' },
      { uid: 0 },
      { pid: 987 },
      { errno: 'EACCES' },
    ])
      expect(parseBootstrapDiagnostic(JSON.stringify({ ...value, ...patch }))).toBeNull();
  });
  it('자식 진단은 고정 필드만 재구성하며 다른 stderr와 확장 필드를 버린다', () => {
    const value = {
      event: 'LOAD_BOOTSTRAP_DIAGNOSTIC',
      innerDiagnostic: null,
      phase: 'install-scope',
      code: 'LOAD_INSTALL_SCOPE_UNVERIFIED',
      admissionReason: null,
      scopeAttempted: false,
      scopeClosed: false,
      pending: 0,
      cleanupFailed: false,
    };
    expect(parseBootstrapDiagnostic(JSON.stringify(value))).toEqual({
      phase: 'install-scope',
      code: 'LOAD_INSTALL_SCOPE_UNVERIFIED',
      admissionReason: null,
    });
    expect(parseBootstrapDiagnostic(JSON.stringify({ ...value, code: 'RESOURCE_DENIED' }))).toEqual({
      phase: 'install-scope',
      code: 'RESOURCE_DENIED',
      admissionReason: null,
    });
    for (const patch of [
      { message: 'private-canary' },
      { innerDiagnostic: { message: 'private-canary' } },
      { phase: 'private-canary' },
      { code: 'private-canary' },
      { code: 'EACCES' },
      { code: 'EPERM' },
      { admissionReason: 'private-canary' },
      { scopeClosed: 1 },
      { pending: -1 },
      { pending: 'private-canary' },
    ])
      expect(parseBootstrapDiagnostic(JSON.stringify({ ...value, ...patch }))).toBeNull();
    for (const line of [null, 'private-canary', 'x'.repeat(4097), '{}', '[]'])
      expect(parseBootstrapDiagnostic(line)).toBeNull();
  });
  it('공개 실패 진단은 고정 단계·코드·심사 사유만 남긴다', () => {
    expect(
      bootstrapDiagnostic('admission-decision', new Error('LOAD_BOOTSTRAP_ADMISSION_REFUSED'), 'memory_limit'),
    ).toEqual({
      phase: 'admission-decision',
      code: 'LOAD_BOOTSTRAP_ADMISSION_REFUSED',
      admissionReason: 'memory_limit',
    });
    const canary = 'private-canary postgres://user:password@host/db /private/path';
    for (const value of [new Error(canary), { message: canary, code: canary }, canary, null, undefined]) {
      const result = bootstrapDiagnostic(canary, value, canary);
      expect(result).toEqual({ phase: 'unknown', code: 'UNCLASSIFIED', admissionReason: null });
      expect(JSON.stringify(result)).not.toContain('private-canary');
    }
    expect(bootstrapDiagnostic('admission-cgroups', Object.assign(new Error(canary), { code: 'ENOENT' }))).toEqual({
      phase: 'admission-cgroups',
      code: 'RESOURCE_MISSING',
      admissionReason: null,
    });
    for (const code of ['EACCES', 'EPERM']) {
      const result = bootstrapDiagnostic(
        'platform',
        Object.assign(new Error(canary), { code, path: canary, syscall: 'readlink' }),
        canary,
      );
      expect(result).toEqual({ phase: 'platform', code: 'RESOURCE_DENIED', admissionReason: null });
      expect(JSON.stringify(result)).not.toContain('private-canary');
      expect(
        bootstrapDiagnostic('source', Object.assign(new Error('LOAD_BOOTSTRAP_SOURCE_INVALID'), { code })),
      ).toEqual({ phase: 'source', code: 'LOAD_BOOTSTRAP_SOURCE_INVALID', admissionReason: null });
    }
    expect(bootstrapDiagnostic('platform', Object.assign(new Error(canary), { code: 'EIO' }))).toEqual({
      phase: 'platform',
      code: 'UNCLASSIFIED',
      admissionReason: null,
    });
  });
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
