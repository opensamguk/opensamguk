import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  BUILDKIT_IMAGE,
  CI_LIMITS,
  ciFailureDiagnostic,
  builderCleanupCheckFields,
  builderCleanupDiagnostic,
  builderCleanupExitDiagnostic,
  builderCgroupDiagnostic,
  fixedImageId,
  publicLoadSummary,
  runtimeBuildArguments,
  verifyBuilder,
} from './ci';
import { userWorkload } from './workload';
import type { LoadRun } from './report';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
describe('fixed CI failure diagnostics', () => {
  it.each(['LOAD_NATIVE_COMMAND_FAILED', 'LOAD_NATIVE_CHILD_UNSETTLED', 'LOAD_BUILDER_UNVERIFIED'])(
    'native failure remains a fixed code without copying private properties: %s',
    (code) => {
      const error = Object.assign(new Error(code), { stderr: 'private-canary', command: '/private/canary' });
      expect(ciFailureDiagnostic('builder-create', error)).toEqual({ phase: 'builder-create', code });
      expect(JSON.stringify(ciFailureDiagnostic('builder-create', error))).not.toContain('canary');
    },
  );
  it('raw messages, stack, paths, causes and arbitrary phase values never enter output', () => {
    const error = Object.assign(new Error('private-canary', { cause: new Error('nested-canary') }), {
      code: 'EPRIVATE_CANARY',
      path: '/private/canary',
    });
    expect(ciFailureDiagnostic('private-phase-canary', error)).toEqual({ phase: 'unknown', code: 'UNCLASSIFIED' });
    expect(ciFailureDiagnostic({}, 'private-canary')).toEqual({ phase: 'unknown', code: 'UNCLASSIFIED' });
  });
  it('schema diagnostics discard invalid input values', () => {
    const parsed = z.literal('fixed').safeParse('private-canary');
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(ciFailureDiagnostic('bootstrap-evidence', parsed.error)).toEqual({
        phase: 'bootstrap-evidence',
        code: 'SCHEMA_INVALID',
      });
  });
  it.each([
    ['ENOENT', 'RESOURCE_MISSING'],
    ['EACCES', 'RESOURCE_DENIED'],
    ['EPERM', 'RESOURCE_DENIED'],
  ])('filesystem errors preserve only a fixed category: %s', (code, expected) => {
    const error = Object.assign(new Error('/private/canary'), { code, path: '/private/canary' });
    expect(ciFailureDiagnostic('builder-evidence', error)).toEqual({ phase: 'builder-evidence', code: expected });
  });
});
describe('fixed builder cleanup diagnostics', () => {
  it.each([
    [0, 'zero'],
    [1, 'one'],
    [143, 'term143'],
    [137, 'kill137'],
    [2, 'other'],
    [-1, 'other'],
  ])('classifies stopped exit %s without returning the raw number', (code, expected) => {
    const raw = [{ State: { ExitCode: code, privateCanary: '/private/canary' }, Id: 'private-canary' }];
    const diagnostic = builderCleanupDiagnostic(
      'exit-check',
      new Error('LOAD_BUILDER_EXIT_UNCONFIRMED'),
      ['exit-code'],
      raw,
    );
    expect(diagnostic.builderExit).toEqual({ exitCodeClass: expected, exitCodeValid: true });
    expect(diagnostic.code).toBe('LOAD_BUILDER_EXIT_UNCONFIRMED');
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|canary|"ExitCode"/);
    // A diagnostic class never changes the original stopped-state success predicate.
    expect(
      z
        .array(z.object({ State: z.object({ ExitCode: z.literal(0) }) }))
        .length(1)
        .safeParse(raw).success,
    ).toBe(code === 0);
  });
  it.each(
    [
      undefined,
      null,
      [],
      [{ State: {} }],
      [{ State: null }],
      [{ State: { ExitCode: 'private-canary' } }],
      [{ State: { ExitCode: NaN } }],
      [{ State: { ExitCode: Infinity } }],
      [{ State: { ExitCode: 1.5 } }],
      [{ State: { ExitCode: 0 } }, { State: { ExitCode: 1 } }],
    ].map((raw) => ({ raw })),
  )('marks a malformed exit input as other without exposing it: %#', ({ raw }) => {
    expect(builderCleanupExitDiagnostic(raw)).toEqual({ exitCodeClass: 'other', exitCodeValid: false });
  });
  it('does not copy raw exit data or accept spoofed diagnostic properties from errors', () => {
    const error = Object.assign(new Error('LOAD_BUILDER_EXIT_UNCONFIRMED'), {
      builderExit: { exitCodeClass: 'private-canary' },
      State: { ExitCode: 'private-canary' },
    });
    const raw = [{ State: { ExitCode: 1 }, Env: ['private-canary'], Path: '/private/canary' }];
    expect(builderCleanupDiagnostic('exit-check', error, ['exit-code'], raw).builderExit).toEqual({
      exitCodeClass: 'one',
      exitCodeValid: true,
    });
    expect(builderCleanupDiagnostic('stop', error, [], raw)).not.toHaveProperty('builderExit');
    expect(JSON.stringify(builderCleanupDiagnostic('exit-check', error, ['exit-code'], raw))).not.toContain('canary');
  });
  it.each([
    'proof',
    'identity-inspect',
    'identity-check',
    'stop',
    'exit-inspect',
    'exit-check',
    'child-settlement',
    'remove',
    'post-container',
    'post-volume',
    'post-check',
    'lifecycle-write',
  ])('identifies the existing cleanup stage without exposing command data: %s', (stage) => {
    const error = Object.assign(new Error('LOAD_NATIVE_COMMAND_FAILED'), {
      stderr: 'private-canary',
      command: '/private/canary',
      id: 'private-canary',
    });
    expect(builderCleanupDiagnostic(stage, error)).toEqual({
      phase: 'builder-cleanup',
      code: 'LOAD_NATIVE_COMMAND_FAILED',
      cleanupStage: stage,
      cleanupFields: [],
    });
  });
  it.each([
    ['LOAD_BUILDER_IDENTITY_UNCONFIRMED', 'identity-check'],
    ['LOAD_BUILDER_EXIT_UNCONFIRMED', 'exit-check'],
    ['LOAD_BUILDER_CHILD_UNSETTLED', 'child-settlement'],
    ['LOAD_BUILDER_REMAINS', 'post-check'],
  ])('retains only the fixed original rejection code: %s', (code, stage) => {
    expect(builderCleanupDiagnostic(stage, new Error(code)).code).toBe(code);
  });
  it('distinguishes all stopped-state predicates while dropping invalid values and issue messages', () => {
    const parsed = z
      .array(
        z.looseObject({
          Id: z.literal('expected'),
          State: z.looseObject({
            Running: z.literal(false),
            Pid: z.literal(0),
            ExitCode: z.literal(0),
            OOMKilled: z.literal(false),
          }),
        }),
      )
      .length(1)
      .safeParse([
        {
          Id: 'private-canary',
          State: {
            Running: true,
            Pid: 123456,
            ExitCode: 137,
            OOMKilled: true,
            privatePath: '/private/canary',
          },
        },
      ]);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('EXPECTED_SCHEMA_REJECTION');
    const diagnostic = builderCleanupDiagnostic(
      'exit-check',
      new Error('LOAD_BUILDER_EXIT_UNCONFIRMED'),
      builderCleanupCheckFields(parsed.error),
    );
    expect(diagnostic.cleanupFields).toEqual(['id', 'running', 'pid', 'exit-code', 'oom-killed']);
    expect(JSON.stringify(diagnostic)).not.toMatch(/canary|123456|137|privatePath/);
  });
  it('does not confuse unknown schema keys, array shape, or private fields with known checks', () => {
    const parsed = z
      .array(z.object({ privateCanaryKey: z.literal('expected') }))
      .length(1)
      .safeParse([{ privateCanaryKey: '/private/canary' }, {}]);
    if (parsed.success) throw new Error('EXPECTED_SCHEMA_REJECTION');
    expect(
      builderCleanupDiagnostic('private-canary', new Error('raw-private-canary'), [
        ...builderCleanupCheckFields(parsed.error),
        '/private/canary',
        'pending-command',
        'pending-command',
      ]),
    ).toEqual({
      phase: 'builder-cleanup',
      code: 'UNCLASSIFIED',
      cleanupStage: 'unknown',
      cleanupFields: ['shape', 'pending-command'],
    });
  });
  it('separates settlement and postcondition checks using only fixed fields', () => {
    expect(
      builderCleanupDiagnostic('child-settlement', new Error('LOAD_BUILDER_CHILD_UNSETTLED'), [
        'sticky-unsettled',
        'command-close',
        'pending-command',
      ]).cleanupFields,
    ).toEqual(['pending-command', 'sticky-unsettled', 'command-close']);
    expect(
      builderCleanupDiagnostic('post-check', new Error('LOAD_BUILDER_REMAINS'), [
        'remaining-volume',
        'remaining-container',
      ]).cleanupFields,
    ).toEqual(['remaining-container', 'remaining-volume']);
  });
  it('ignores forged diagnostic getters, nested errors and raw filesystem paths', () => {
    const error = Object.assign(new Error('raw-private-canary', { cause: new Error('nested-canary') }), {
      code: 'EACCES',
      path: '/private/canary',
      stack: 'private-canary',
    });
    Object.defineProperty(error, 'cleanupFields', {
      get() {
        throw new Error('getter-canary');
      },
    });
    const diagnostic = builderCleanupDiagnostic('lifecycle-write', error, [{ value: 'private-canary' }]);
    expect(diagnostic).toEqual({
      phase: 'builder-cleanup',
      code: 'RESOURCE_DENIED',
      cleanupStage: 'lifecycle-write',
      cleanupFields: [],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('canary');
  });
});
// 공개 요약 경계의 수학 고정물이다. 실제 부하·계정·월드 인수로 세지 않는다.
function mathematicalSmoke(): LoadRun {
  const end = 15001,
    seed = 'public-summary-pure-only';
  const run: LoadRun = {
    version: 2,
    mode: 'smoke',
    sourceHead: 'a'.repeat(40),
    sourceSha256: 'b'.repeat(64),
    warmupStartedAt: 1000,
    measurementStartedAt: 1001,
    measurementFinishedAt: end,
    fixtureAccounts: 218,
    workloadSeed: seed,
    worlds: [],
    workers: [],
    attempts: [],
    requests: [],
    sse: [],
    metrics: [],
    databaseWitnesses: [],
    databaseCoverage: [],
    generatorFailures: [],
    environment: {
      admissionAccepted: true,
      admissionSha256: 'c'.repeat(64),
      maxGeneratorCpuFraction: 0.1,
      maxExternalHostCpuFraction: 0.1,
      oomCount: 0,
      sourceUnchanged: true,
      complete: true,
      observations: [1001, 6001, 11001, end].map((at) => ({
        at,
        generatorCpuFraction: 0.1,
        externalHostCpuFraction: 0.1,
        oomCount: 0,
      })),
    },
  };
  for (let index = 0; index < 2; index++) {
    const worldId = id(index + 1),
      userId = id(index + 10),
      workload = userWorkload(seed, index, 0);
    let at = 1000,
      sequence = 0,
      finishedAt = 0;
    while (at < end) {
      const next = workload.next();
      sequence++;
      finishedAt = at + 1;
      run.requests.push({
        worldId,
        userId,
        sequence,
        ...next,
        phase: at < 1001 ? 'warmup' : 'measure',
        startedAt: at,
        finishedAt,
        durationMs: 1,
        status: 200,
        outcome: 'success',
      });
      run.attempts.push({ worldId, userId, sequence, ...next, startedAt: at, completedAt: finishedAt });
      at = finishedAt + next.thinkMs;
    }
    run.worlds.push({ worldId, generals: 600, humans: 109, turnTermMinutes: index + 1 });
    run.workers.push({
      worldId,
      userId,
      worldIndex: index,
      userIndex: 0,
      startedAt: 1000,
      finishedAt: Math.max(end, finishedAt),
      attempted: sequence,
      completed: sequence,
      terminal: 'window-complete',
    });
    run.sse.push({ worldId, userId, readyAt: 999, closedAt: Math.max(end, finishedAt) + 1, failed: false });
    const dueAt = 1000 + 6 * (index + 1);
    run.metrics.push({
      version: 1,
      sampleKind: 'post-commit-upper-bound',
      worldId,
      tick: 1,
      sequence: 1,
      kind: 'turn',
      valid: true,
      dueAt,
      clockEpochAt: 1000,
      commitObservedAt: dueAt + 1,
      lagMs: 1,
    });
    run.databaseWitnesses.push({ worldId, sequence: 1, tick: 1, kind: 'turn' });
    run.databaseCoverage.push({
      worldId,
      clockEpochAt: 1000,
      observedAt: end + 100,
      cutoffAt: end,
      pendingDueTurns: 0,
      pendingDueMonthly: 0,
      committedActionCount: 1,
      lastSequence: 1,
    });
  }
  return run;
}
const closure = {
  complete: true,
  performancePassed: true,
  executionSucceeded: true,
  sourceUnchanged: true,
  ownershipMatches: true,
  databaseOidMatches: true,
  connections: 0,
  deleted: true,
  kept: false,
  cleanupFailures: [],
  commands: [{ actualClose: true, stdoutEnded: true, stderrEnded: true, exitCode: 0, failed: false }],
  pending: 0,
  stickyUnsettled: false,
};

describe('L5 수동 build/공개 요약 경계', () => {
  it('고정 image의 실제 digest·플랫폼·ID가 모두 있어야 한다', () => {
    const row = {
      Id: `sha256:${'a'.repeat(64)}`,
      Os: 'linux',
      Architecture: 'amd64',
      RepoDigests: [`moby/buildkit@${BUILDKIT_IMAGE.split('@')[1]}`],
    };
    expect(fixedImageId([row], BUILDKIT_IMAGE)).toBe(row.Id);
    for (const patch of [{ RepoDigests: [] }, { Os: 'windows' }, { Architecture: 'arm64' }, { Id: 'latest' }])
      expect(() => fixedImageId([{ ...row, ...patch }], BUILDKIT_IMAGE)).toThrow(/^LOAD_FIXED_IMAGE_UNVERIFIED$/);
  });
  it('buildx의 빈 parent를 신뢰하지 않고 실제 커널 parent와 CPU1·2GiB를 확인한다', () => {
    const name = `opensamguk-load-build-${'a'.repeat(32)}`,
      containerName = `buildx_buildkit_${name}0`;
    const row = {
      Id: 'b'.repeat(64),
      Name: `/${containerName}`,
      Image: 'buildkit-image',
      State: { Running: true, Pid: 123, OOMKilled: false },
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
    };
    const expected = { name, imageId: row.Image, cgroupText: `0::/system.slice/docker-${row.Id}.scope\n` };
    expect(verifyBuilder(row, expected).configuredParent).toBe('');
    expect(() => verifyBuilder(row, { ...expected, cgroupText: `0::/narrow.slice/docker-${row.Id}.scope\n` })).toThrow(
      'LOAD_BUILDER_UNVERIFIED',
    );
    for (const patch of [
      { CpuQuota: 200000 },
      { CpuPeriod: 200000 },
      { Memory: 4294967296 },
      { MemorySwap: -1 },
      { CgroupnsMode: 'host' },
      { CgroupParent: 'unknown.slice' },
    ])
      expect(() => verifyBuilder({ ...row, HostConfig: { ...row.HostConfig, ...patch } }, expected)).toThrow(
        'LOAD_BUILDER_UNVERIFIED',
      );
    expect(() => verifyBuilder({ ...row, Mounts: [] }, expected)).toThrow('LOAD_BUILDER_UNVERIFIED');
    // Correct limits under invented Go-style keys cannot prove Docker JSON limits.
    for (const key of ['CpuQuota', 'CpuPeriod'] as const) {
      const host: Record<string, unknown> = { ...row.HostConfig, CPUQuota: 100000, CPUPeriod: 100000 };
      delete host[key];
      expect(() => verifyBuilder({ ...row, HostConfig: host }, expected)).toThrow('LOAD_BUILDER_UNVERIFIED');
    }
  });
  it('runtime image는 같은 checkout의 정확 source labels와 자체 builder로 만든다', () => {
    const args = runtimeBuildArguments(`opensamguk-load-build-${'a'.repeat(32)}`, '/private/id', {
      head: 'b'.repeat(40),
      sha256: 'c'.repeat(64),
      files: 1,
    });
    expect(args).toContain('SOURCE_REVISION=' + 'b'.repeat(40));
    expect(args).toContain('SOURCE_TREE_SHA256=' + 'c'.repeat(64));
    expect(args).toContain('runtime');
    expect(args).not.toContain('--push');
    expect(CI_LIMITS.driverMs).toBe((11 + 20 + 5) * 60000);
  });
  it('수학적으로 유효한 원자료도 실제 정리가 없으면 공개 성공 요약을 만들지 않는다', () => {
    const raw = mathematicalSmoke();
    const summary = publicLoadSummary(raw, { ...closure, secretCanary: 'private-canary' });
    expect(summary.verdict).toBe('SMOKE_ONLY');
    const text = JSON.stringify(summary);
    for (const forbidden of [
      raw.worlds[0]!.worldId,
      raw.sse[0]!.userId,
      'private-canary',
      'commands',
      'databaseName',
      'knownOid',
    ])
      expect(text.includes(forbidden)).toBe(false);
    for (const patch of [
      { executionSucceeded: false },
      { deleted: false },
      { connections: 1 },
      { pending: 1 },
      { stickyUnsettled: true },
      { commands: [] },
      { cleanupFailures: ['FAIL'] },
    ])
      expect(() => publicLoadSummary(raw, { ...closure, ...patch })).toThrow(/^LOAD_PUBLIC_SUMMARY_UNVERIFIED$/);
    expect(() => publicLoadSummary({ ...raw, secretCanary: 'private-canary' }, closure)).toThrow(
      /^LOAD_PUBLIC_SUMMARY_UNVERIFIED$/,
    );
    expect(() =>
      publicLoadSummary({ ...raw, generatorFailures: ['LOAD_GENERATOR_INTERRUPTED_OR_FAILED'] }, closure),
    ).toThrow(/^LOAD_PUBLIC_SUMMARY_UNVERIFIED$/);
  });
  it.each(['load-m3.yml', 'load-smoke.yml'])(
    '수동 workflow만 정확 source/읽기 권한으로 연결하며 원자료를 업로드하지 않는다: %s',
    async (name) => {
      const text = await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
      const document: unknown = parse(text);
      expect(document).toMatchObject({
        on: { workflow_dispatch: { inputs: { expected_sha: { required: true, type: 'string' } } } },
        permissions: { contents: 'read' },
        jobs: { load: { 'runs-on': 'ubuntu-24.04', 'timeout-minutes': 75 } },
      });
      const events = zObject(document).on;
      expect(Object.keys(zObject(events))).toEqual(['workflow_dispatch']);
      expect(text).not.toMatch(/upload-artifact|secrets\.|workflow_call|pull_request_target/);
      expect(text).toContain('persist-credentials: false');
      expect(text).toContain('node tools/load/bootstrap.mjs');
      expect(text).toContain('node --import tsx tools/load/ci.ts');
    },
  );
});
function zObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKFLOW_SHAPE_INVALID');
  return value as Record<string, unknown>;
}

function diagnosticBuilderFixture() {
  const name = `opensamguk-load-build-${'a'.repeat(32)}`,
    containerName = `buildx_buildkit_${name}0`;
  return {
    row: {
      Id: 'b'.repeat(64),
      Name: `/${containerName}`,
      Image: 'buildkit-image',
      State: { Running: true, Pid: 123, OOMKilled: false },
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
    expected: { name, imageId: 'buildkit-image', cgroupText: `0::/system.slice/docker-${'b'.repeat(64)}.scope\n` },
  };
}
type DiagnosticBuilder = ReturnType<typeof diagnosticBuilderFixture>['row'];
function builderDiagnostic(raw: unknown, expected = diagnosticBuilderFixture().expected) {
  try {
    verifyBuilder(raw, expected);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).toBe('LOAD_BUILDER_UNVERIFIED');
    return ciFailureDiagnostic('builder-runtime', error);
  }
  throw new Error('Expected builder rejection');
}

describe('builder mismatch diagnostics retain only fixed fields', () => {
  const schemaCases: [string, string, (row: DiagnosticBuilder) => unknown][] = [
    ['root', 'schema-other', () => 'private-canary'],
    ['id', 'schema-id', (row) => ({ ...row, Id: 'private-canary' })],
    ['name', 'schema-name', (row) => ({ ...row, Name: null })],
    ['image', 'schema-image', (row) => ({ ...row, Image: null })],
    ['state', 'schema-state', (row) => ({ ...row, State: null })],
    ['running', 'schema-running', (row) => ({ ...row, State: { ...row.State, Running: false } })],
    ['pid', 'schema-pid', (row) => ({ ...row, State: { ...row.State, Pid: 0 } })],
    ['oom', 'schema-oom-killed', (row) => ({ ...row, State: { ...row.State, OOMKilled: true } })],
    ['host', 'schema-host-config', (row) => ({ ...row, HostConfig: null })],
    ['quota', 'schema-cpu-quota', (row) => ({ ...row, HostConfig: { ...row.HostConfig, CpuQuota: 200000 } })],
    ['period', 'schema-cpu-period', (row) => ({ ...row, HostConfig: { ...row.HostConfig, CpuPeriod: 200000 } })],
    ['memory', 'schema-memory', (row) => ({ ...row, HostConfig: { ...row.HostConfig, Memory: 1 } })],
    ['swap', 'schema-memory-swap', (row) => ({ ...row, HostConfig: { ...row.HostConfig, MemorySwap: -1 } })],
    ['parent', 'schema-cgroup-parent', (row) => ({ ...row, HostConfig: { ...row.HostConfig, CgroupParent: null } })],
    [
      'namespace',
      'schema-cgroup-namespace',
      (row) => ({ ...row, HostConfig: { ...row.HostConfig, CgroupnsMode: 'host' } }),
    ],
    ['restart', 'schema-restart-policy', (row) => ({ ...row, HostConfig: { ...row.HostConfig, RestartPolicy: null } })],
    [
      'restart name',
      'schema-restart-name',
      (row) => ({ ...row, HostConfig: { ...row.HostConfig, RestartPolicy: { Name: 'always' } } }),
    ],
    ['mounts', 'schema-mounts', (row) => ({ ...row, Mounts: null })],
    ['mount row', 'schema-mount-row', (row) => ({ ...row, Mounts: [null] })],
    ['mount type', 'schema-mount-type', (row) => ({ ...row, Mounts: [{ ...row.Mounts[0], Type: null }] })],
    ['mount name', 'schema-mount-name', (row) => ({ ...row, Mounts: [{ ...row.Mounts[0], Name: null }] })],
    [
      'mount destination',
      'schema-mount-destination',
      (row) => ({ ...row, Mounts: [{ ...row.Mounts[0], Destination: null }] }),
    ],
  ];
  it.each(schemaCases)('identifies schema %s without copying invalid values', (_name, field, change) => {
    const { row } = diagnosticBuilderFixture();
    expect(builderDiagnostic(change(row))).toEqual({
      phase: 'builder-runtime',
      code: 'LOAD_BUILDER_UNVERIFIED',
      builderFields: [field],
    });
  });
  const runtimeCases: [string, string, (row: DiagnosticBuilder) => DiagnosticBuilder][] = [
    ['name', 'actual-name', (row) => ({ ...row, Name: '/private-canary' })],
    ['image', 'actual-image', (row) => ({ ...row, Image: 'private-canary' })],
    [
      'parent',
      'configured-parent',
      (row) => ({ ...row, HostConfig: { ...row.HostConfig, CgroupParent: 'private-canary' } }),
    ],
    ['count', 'mount-count', (row) => ({ ...row, Mounts: [...row.Mounts, ...row.Mounts] })],
    ['type', 'mount-type', (row) => ({ ...row, Mounts: [{ ...row.Mounts[0]!, Type: 'bind' }] })],
    ['volume', 'mount-name', (row) => ({ ...row, Mounts: [{ ...row.Mounts[0]!, Name: 'private-canary' }] })],
    [
      'destination',
      'mount-destination',
      (row) => ({ ...row, Mounts: [{ ...row.Mounts[0]!, Destination: '/private-canary' }] }),
    ],
  ];
  it.each(runtimeCases)('identifies actual %s mismatch without exposing values', (_name, field, change) => {
    expect(builderDiagnostic(change(diagnosticBuilderFixture().row))).toEqual({
      phase: 'builder-runtime',
      code: 'LOAD_BUILDER_UNVERIFIED',
      builderFields: [field],
    });
  });
  it('identifies expected name and kernel mismatch; malformed kernel input retains its original error', () => {
    const { row, expected } = diagnosticBuilderFixture();
    expect(builderDiagnostic(row, { ...expected, name: 'private-canary' }).builderFields).toEqual(['expected-name']);
    expect(builderDiagnostic(row, { ...expected, cgroupText: '0::/private-canary\n' }).builderFields).toEqual([
      'kernel-cgroup',
    ]);
    try {
      verifyBuilder(row, { ...expected, cgroupText: 'private-canary' });
      throw new Error('Expected kernel rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toBe('LOAD_CGROUP_SAMPLE_INVALID');
      expect(ciFailureDiagnostic('builder-runtime', error)).toEqual({
        phase: 'builder-runtime',
        code: 'UNCLASSIFIED',
        builderFields: ['kernel-cgroup'],
        builderCgroup: builderCgroupDiagnostic('private-canary', row.Id, row.HostConfig.CgroupParent),
      });
    }
  });
  it('reports every known mismatch once and ignores arbitrary private properties and forged diagnostics', () => {
    const { row, expected } = diagnosticBuilderFixture();
    try {
      verifyBuilder(
        {
          ...row,
          Name: '/private-canary',
          Image: 'private-canary',
          HostConfig: { ...row.HostConfig, CgroupParent: 'private-canary' },
          Mounts: [],
        },
        { ...expected, cgroupText: '0::/private-canary\n' },
      );
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      Object.assign(error, {
        builderFields: ['private-canary'],
        stderr: 'private-canary',
        cause: new Error('private-canary'),
      });
      const diagnostic = ciFailureDiagnostic('builder-runtime', error);
      expect(diagnostic.builderFields).toEqual([
        'actual-name',
        'actual-image',
        'configured-parent',
        'kernel-cgroup',
        'mount-count',
        'mount-type',
        'mount-name',
        'mount-destination',
      ]);
      expect(JSON.stringify(diagnostic)).not.toContain('canary');
      Object.assign(diagnostic.builderFields!, { 0: 'private-canary' });
      expect(JSON.stringify(ciFailureDiagnostic('builder-runtime', error))).not.toContain('canary');
    }
    const forged = Object.assign(new Error('LOAD_BUILDER_UNVERIFIED'), { builderFields: ['private-canary'] });
    expect(ciFailureDiagnostic('builder-runtime', forged)).toEqual({
      phase: 'builder-runtime',
      code: 'LOAD_BUILDER_UNVERIFIED',
    });
  });
  it('reports simultaneous schema failures and discards unknown nested private keys', () => {
    const { row } = diagnosticBuilderFixture();
    expect(
      builderDiagnostic({
        ...row,
        Id: 'private-canary',
        HostConfig: { ...row.HostConfig, CpuQuota: -1, CpuPeriod: -1, 'private-canary': 'private-canary' },
      }),
    ).toEqual({
      phase: 'builder-runtime',
      code: 'LOAD_BUILDER_UNVERIFIED',
      builderFields: ['schema-id', 'schema-cpu-quota', 'schema-cpu-period'],
    });
    expect(
      verifyBuilder(
        { ...row, 'private-canary': { 'private-canary': 'private-canary' } },
        diagnosticBuilderFixture().expected,
      ).pid,
    ).toBe(123);
  });
});

describe('kernel cgroup location diagnostics never relax the builder guard', () => {
  const containerId = 'b'.repeat(64),
    scope = `docker-${containerId}.scope`;
  it.each([
    [`0::/system.slice/${scope}\n`, 'exact-owned-scope', true, false, false],
    [`0::/system.slice/${scope}/init.scope\n`, 'owned-scope-descendant', true, false, true],
    [`0::/system.slice/${scope}/private-canary\n`, 'owned-scope-descendant', true, false, false],
    [`0::/system.slice/docker-${'c'.repeat(64)}.scope\n`, 'system-slice-other', false, true, false],
    [`0::/system.slice/${scope}-private-canary/init.scope\n`, 'system-slice-other', false, false, true],
    [`0::/private-canary/${scope}\n`, 'other-parent', true, false, false],
    ['0::/\n', 'hierarchy-root', false, false, false],
  ] as const)(
    'classifies only fixed location and exact owned scope components: %s',
    (text, location, ownedScope, foreignDockerScope, initScopeLeaf) => {
      const diagnostic = builderCgroupDiagnostic(text, containerId, '');
      expect(diagnostic).toEqual({
        location,
        configuredParent: 'empty',
        singleUnifiedEntry: true,
        traversal: false,
        ownedScope,
        foreignDockerScope,
        initScopeLeaf,
        deletedSuffix: false,
        procPathContainsMountPrefix: false,
      });
      const encoded = JSON.stringify(diagnostic);
      for (const privateValue of ['canary', containerId, 'system.slice/', 'docker-', '0::'])
        expect(encoded).not.toContain(privateValue);
      const { row, expected } = diagnosticBuilderFixture();
      if (location === 'exact-owned-scope') expect(verifyBuilder(row, { ...expected, cgroupText: text }).pid).toBe(123);
      else expect(() => verifyBuilder(row, { ...expected, cgroupText: text })).toThrow(/^LOAD_BUILDER_UNVERIFIED$/);
    },
  );
  it('distinguishes malformed/traversal/deleted/mount-prefixed evidence without exporting input', () => {
    expect(builderCgroupDiagnostic('private-canary', containerId, 'private-canary')).toMatchObject({
      location: 'invalid',
      configuredParent: 'other',
      singleUnifiedEntry: false,
    });
    expect(builderCgroupDiagnostic(`0::/system.slice/../${scope}\n`, containerId, '')).toMatchObject({
      location: 'invalid',
      traversal: true,
    });
    expect(builderCgroupDiagnostic(`0::/system.slice/${scope} (deleted)\n`, containerId, 'system.slice')).toMatchObject(
      { location: 'system-slice-other', configuredParent: 'system-slice', deletedSuffix: true, ownedScope: false },
    );
    expect(builderCgroupDiagnostic(`0::/sys/fs/cgroup/system.slice/${scope}\n`, containerId, '')).toMatchObject({
      location: 'other-parent',
      procPathContainsMountPrefix: true,
    });
    expect(builderCgroupDiagnostic(`0::/system.slice/${scope}\n0::/private-canary\n`, containerId, '')).toMatchObject({
      singleUnifiedEntry: false,
    });
    expect(builderCgroupDiagnostic(`0::/system.slice/${scope}\n`, 'private-canary', '')).toMatchObject({
      location: 'invalid',
      ownedScope: false,
    });
  });
  it('attaches only a fixed classification to the original failure; copied error properties cannot override it', () => {
    const { row, expected } = diagnosticBuilderFixture();
    const text = `0::/system.slice/${scope}/private-canary\n`;
    try {
      verifyBuilder(row, { ...expected, cgroupText: text });
      throw new Error('Expected original rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toBe('LOAD_BUILDER_UNVERIFIED');
      Object.assign(error, { builderCgroup: { raw: 'private-canary' }, path: text, raw: row });
      const diagnostic = ciFailureDiagnostic('builder-runtime', error);
      expect(diagnostic.builderFields).toEqual(['kernel-cgroup']);
      expect(diagnostic.builderCgroup?.location).toBe('owned-scope-descendant');
      expect(JSON.stringify(diagnostic)).not.toContain('canary');
      expect(JSON.stringify(diagnostic)).not.toContain(containerId);
    }
  });
});
