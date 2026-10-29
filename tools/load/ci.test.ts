import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BUILDKIT_IMAGE, CI_LIMITS, fixedImageId, publicLoadSummary, runtimeBuildArguments, verifyBuilder } from './ci';
import { userWorkload } from './workload';
import type { LoadRun } from './report';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
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
        CPUQuota: 100000,
        CPUPeriod: 100000,
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
      { CPUQuota: 200000 },
      { Memory: 4294967296 },
      { MemorySwap: -1 },
      { CgroupnsMode: 'host' },
      { CgroupParent: 'unknown.slice' },
    ])
      expect(() => verifyBuilder({ ...row, HostConfig: { ...row.HostConfig, ...patch } }, expected)).toThrow(
        'LOAD_BUILDER_UNVERIFIED',
      );
    expect(() => verifyBuilder({ ...row, Mounts: [] }, expected)).toThrow('LOAD_BUILDER_UNVERIFIED');
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
