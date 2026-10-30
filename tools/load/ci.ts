import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { admissionSite, evaluateAdmission } from './admission';
import { BUILD_BUDGET, requireDispatch } from './bootstrap.mjs';
import { bindLocalDocker, LOAD_DOCKER } from './docker';
import { commandSettled, OwnedCommands, sourceSnapshot, writeEvidence } from './lifecycle';
import { readRunnerProvenance, sampleAdmission, selfCgroupPath } from './observe';
import { evaluateLoadRun, loadRunSchema } from './report';
import { requireImageSource } from './run';

// 공식 release/registry manifest: https://github.com/moby/buildkit/releases/tag/v0.34.1
// index sha256은 registry의 Docker-Content-Digest와 실제 응답 body SHA256을 대조했다.
export const BUILDKIT_IMAGE =
  'moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c';
export const LOAD_POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
export const CI_LIMITS = Object.freeze({
  admissionMs: 660000,
  imagePreparationAndBuildMs: 900000,
  builderCleanupMs: 120000,
  driverMs: 2160000,
  summaryMs: 120000,
});
const diagnosticPhases = new Set([
  'options',
  'bootstrap-evidence',
  'source-bind',
  'runner-provenance',
  'daemon-bind',
  'daemon-information',
  'build-admission',
  'builder-baseline',
  'pull-buildkit',
  'verify-buildkit',
  'pull-postgres',
  'verify-postgres',
  'builder-create',
  'builder-bootstrap',
  'builder-runtime',
  'builder-evidence',
  'post-builder-admission',
  'runtime-build',
  'runtime-image',
  'builder-cleanup',
  'source-after-build',
  'load-driver',
  'driver-evidence',
  'source-after-driver',
  'driver-lifecycle',
  'public-summary',
]);
const diagnosticCodes = new Set([
  'LOAD_CI_OPTIONS_INVALID',
  'LOAD_BOOTSTRAP_SCOPE_UNVERIFIED',
  'LOAD_CI_SOURCE_CHANGED',
  'LOAD_DISPATCH_SOURCE_INVALID',
  'LOAD_CI_PLATFORM_UNVERIFIED',
  'LOAD_CI_DAEMON_UNVERIFIED',
  'LOAD_BUILD_ADMISSION_DEADLINE',
  'LOAD_BUILD_ADMISSION_REFUSED',
  'LOAD_BUILDER_BASELINE_NOT_EMPTY',
  'LOAD_IMAGE_PREPARATION_DEADLINE',
  'LOAD_FIXED_IMAGE_UNVERIFIED',
  'LOAD_BUILDER_UNVERIFIED',
  'LOAD_IMAGE_SOURCE_INVALID',
  'LOAD_CI_BUILD_FAILED',
  'LOAD_CI_FINAL_UNVERIFIED',
  'LOAD_CI_FINAL_FAILED',
  'LOAD_PUBLIC_SUMMARY_UNVERIFIED',
  'LOAD_COMMAND_OPTIONS_INVALID',
  'LOAD_NATIVE_CHILD_UNSETTLED',
  'LOAD_NATIVE_COMMAND_FAILED',
]);
let diagnosticPhase = 'options';
export function ciFailureDiagnostic(phase: unknown, error: unknown) {
  return {
    phase: typeof phase === 'string' && diagnosticPhases.has(phase) ? phase : 'unknown',
    code:
      error instanceof Error && diagnosticCodes.has(error.message)
        ? error.message
        : error instanceof z.ZodError
          ? 'SCHEMA_INVALID'
          : error instanceof Error && 'code' in error && error.code === 'ENOENT'
            ? 'RESOURCE_MISSING'
            : error instanceof Error && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))
              ? 'RESOURCE_DENIED'
              : 'UNCLASSIFIED',
  };
}
function reportFailure(error: unknown) {
  process.stderr.write(
    JSON.stringify({ event: 'LOAD_CI_DIAGNOSTIC', ...ciFailureDiagnostic(diagnosticPhase, error) }) + '\n',
  );
}
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  head = z.string().regex(/^[a-f0-9]{40}$/);
const sourceSchema = z.strictObject({ head, sha256: hash, files: z.number().int().positive() });
const commandSchema = z.looseObject({
  actualClose: z.literal(true),
  stdoutEnded: z.literal(true),
  stderrEnded: z.literal(true),
  exitCode: z.literal(0),
  failed: z.literal(false),
});
const lifecycleSchema = z.looseObject({
  complete: z.literal(true),
  performancePassed: z.literal(true),
  executionSucceeded: z.literal(true),
  sourceUnchanged: z.literal(true),
  ownershipMatches: z.literal(true),
  databaseOidMatches: z.literal(true),
  connections: z.literal(0),
  deleted: z.literal(true),
  kept: z.literal(false),
  cleanupFailures: z.array(z.never()),
  commands: z.array(commandSchema).nonempty(),
  pending: z.literal(0),
  stickyUnsettled: z.literal(false),
});
const builderSchema = z.looseObject({
  Id: hash,
  Name: z.string(),
  Image: z.string(),
  State: z.looseObject({ Running: z.literal(true), Pid: z.number().int().positive(), OOMKilled: z.literal(false) }),
  HostConfig: z.looseObject({
    // Docker JSON uses Cpu*, unlike the Go field names and systemd CPUQuota.
    // https://docs.docker.com/reference/api/engine/version/v1.56/
    CpuQuota: z.literal(100000),
    CpuPeriod: z.literal(100000),
    Memory: z.literal(2147483648),
    MemorySwap: z.literal(2147483648),
    CgroupParent: z.string(),
    CgroupnsMode: z.literal('private'),
    RestartPolicy: z.looseObject({ Name: z.literal('no') }),
  }),
  Mounts: z.array(z.looseObject({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
});

export function verifyBuilder(raw: unknown, expected: { name: string; imageId: string; cgroupText: string }) {
  const parsed = builderSchema.safeParse(raw);
  if (!parsed.success || !/^opensamguk-load-build-[a-f0-9]{32}$/.test(expected.name))
    throw new Error('LOAD_BUILDER_UNVERIFIED');
  const row = parsed.data,
    containerName = `buildx_buildkit_${expected.name}0`,
    volume = `${containerName}_state`;
  // Buildx의 systemd driver는 CgroupParent를 비워 둔다. 빈 값을 기본 parent의 증거로 쓰지 않고
  // 실제 로컬 커널 경로를 확인하여 system.slice로 해석된 경우만 허용한다.
  if (
    row.Name !== `/${containerName}` ||
    row.Image !== expected.imageId ||
    !['', LOAD_DOCKER.cgroupParent].includes(row.HostConfig.CgroupParent) ||
    selfCgroupPath(expected.cgroupText) !== `${LOAD_DOCKER.cgroupPath}/docker-${row.Id}.scope` ||
    row.Mounts.length !== 1 ||
    row.Mounts[0]?.Type !== 'volume' ||
    row.Mounts[0].Name !== volume ||
    row.Mounts[0].Destination !== '/var/lib/buildkit'
  )
    throw new Error('LOAD_BUILDER_UNVERIFIED');
  return {
    id: row.Id,
    pid: row.State.Pid,
    volume,
    containerName,
    actualParent: LOAD_DOCKER.cgroupPath,
    configuredParent: row.HostConfig.CgroupParent,
  };
}

export function fixedImageId(raw: unknown, pin: string): string {
  const parsed = z
    .array(
      z.looseObject({
        Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        Os: z.literal('linux'),
        Architecture: z.literal('amd64'),
        RepoDigests: z.array(z.string()),
      }),
    )
    .length(1)
    .safeParse(raw);
  const row = parsed.success ? parsed.data[0] : undefined;
  const digest = pin.slice(pin.indexOf('@') + 1);
  if (!row || !row.RepoDigests.some((value) => value.endsWith(`@${digest}`)))
    throw new Error('LOAD_FIXED_IMAGE_UNVERIFIED');
  return row.Id;
}

export function runtimeBuildArguments(builder: string, iidFile: string, source: z.infer<typeof sourceSchema>) {
  if (!/^opensamguk-load-build-[a-f0-9]{32}$/.test(builder)) throw new Error('LOAD_BUILDER_UNVERIFIED');
  sourceSchema.parse(source);
  return [
    'buildx',
    'build',
    '--builder',
    builder,
    '--load',
    '--target',
    'runtime',
    '--file',
    'deploy/Dockerfile',
    '--provenance=false',
    '--iidfile',
    iidFile,
    '--build-arg',
    `SOURCE_REVISION=${source.head}`,
    '--build-arg',
    `SOURCE_TREE_SHA256=${source.sha256}`,
    '.',
  ];
}

export function publicLoadSummary(raw: unknown, lifecycle: unknown) {
  const run = loadRunSchema.safeParse(raw),
    closure = lifecycleSchema.safeParse(lifecycle);
  if (!run.success || !closure.success) throw new Error('LOAD_PUBLIC_SUMMARY_UNVERIFIED');
  const result = evaluateLoadRun(run.data);
  if (result.verdict !== (run.data.mode === 'formal' ? 'PASS' : 'SMOKE_ONLY'))
    throw new Error('LOAD_PUBLIC_SUMMARY_UNVERIFIED');
  // 새로운 원문·식별자 필드는 이 반환 객체로 복사되지 않는다. 공개 artifact 업로드는 하지 않는다.
  return {
    version: 1,
    mode: run.data.mode,
    verdict: result.verdict,
    sourceHead: run.data.sourceHead,
    sourceSha256: run.data.sourceSha256,
    worlds: run.data.worlds.length,
    fixtureAccounts: run.data.fixtureAccounts,
    concurrentSse: run.data.sse.length,
    warmupSeconds: (run.data.measurementStartedAt - run.data.warmupStartedAt) / 1000,
    measurementSeconds: (run.data.measurementFinishedAt - run.data.measurementStartedAt) / 1000,
    measuredRequests: result.measuredRequests,
    p95Ms: result.p95Ms,
    maxCommitUpperBoundMs: result.maxCommitUpperBoundMs,
    errors5xx: result.errors5xx,
    unexpected4xx: result.unexpected4xx,
    cleanupVerified: true,
  };
}

async function main() {
  if (process.argv.length !== 2 || !['formal', 'smoke'].includes(process.env.LOAD_MODE ?? ''))
    throw new Error('LOAD_CI_OPTIONS_INVALID');
  const mode = process.env.LOAD_MODE!,
    root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const commands = new OwnedCommands(root),
    controller = new AbortController(),
    signal = controller.signal;
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // 심사11분 + pull/build15분 + 정리2분 + 기존 driver36분 + 요약2분.
  const hard = setTimeout(
    () => {
      process.stderr.write('LOAD_CI_UNSETTLED_MANUAL_REVIEW_REQUIRED\n');
      process.exit(1);
    },
    Object.values(CI_LIMITS).reduce((sum, value) => sum + value, 0),
  );
  diagnosticPhase = 'bootstrap-evidence';
  const bootstrap = z
    .strictObject({
      version: z.literal(1),
      runId: z.string().regex(/^[a-f0-9]{32}$/),
      source: sourceSchema,
      budget: z.unknown(),
      docker: z.unknown(),
      scopeVerified: z.literal(true),
    })
    .parse(JSON.parse(await readFile(resolve(root, '.load-reports/bootstrap.json'), 'utf8')));
  const bootstrapLifecycle = z
    .looseObject({
      failure: z.literal(false),
      scopeClosed: z.literal(true),
      receipts: z.array(commandSchema).nonempty(),
      pending: z.literal(0),
      cleanupFailures: z.array(z.never()),
    })
    .parse(
      JSON.parse(
        await readFile(resolve(root, '.load-reports', `bootstrap-${bootstrap.runId}`, 'lifecycle.json'), 'utf8'),
      ),
    );
  if (!bootstrapLifecycle.scopeClosed) throw new Error('LOAD_BOOTSTRAP_SCOPE_UNVERIFIED');
  diagnosticPhase = 'source-bind';
  const before = await sourceSnapshot(commands, signal);
  requireDispatch({
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    expectedSha: process.env.LOAD_EXPECTED_SHA,
    dispatchSha: process.env.GITHUB_SHA,
    head: before.head,
  });
  if (before.head !== bootstrap.source.head || before.sha256 !== bootstrap.source.sha256)
    throw new Error('LOAD_CI_SOURCE_CHANGED');
  diagnosticPhase = 'runner-provenance';
  const site = admissionSite('github-hosted', await readRunnerProvenance());
  if (!site.accepted) throw new Error('LOAD_CI_PLATFORM_UNVERIFIED');
  const raw = (
    args: readonly string[],
    label: string,
    ownSignal: AbortSignal,
    timeoutMs: number,
    env?: NodeJS.ProcessEnv,
  ) => commands.run('docker', args, { label, signal: ownSignal, timeoutMs, ...(env ? { env } : {}) });
  diagnosticPhase = 'daemon-bind';
  const docker = await bindLocalDocker(raw, signal);
  const builder = `opensamguk-load-build-${bootstrap.runId}`,
    containerName = `buildx_buildkit_${builder}0`,
    volumeName = `${containerName}_state`;
  const output = resolve(root, '.load-reports', `build-${bootstrap.runId}`);
  await mkdir(output, { mode: 0o700 });
  const dockerConfig = resolve(output, 'docker');
  await mkdir(dockerConfig, { mode: 0o700 });
  const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
  const native = (args: readonly string[], label: string, ownSignal = signal, timeoutMs = 10000) =>
    docker.run(args, label, ownSignal, timeoutMs, env);
  diagnosticPhase = 'daemon-information';
  const info = z
    .looseObject({
      root: z.string().startsWith('/'),
      os: z.literal('linux'),
      driver: z.literal('systemd'),
      version: z.literal('2'),
      security: z.array(z.string()),
    })
    .parse(
      JSON.parse(
        await native(
          [
            'info',
            '--format',
            '{"root":{{json .DockerRootDir}},"os":{{json .OSType}},"driver":{{json .CgroupDriver}},"version":{{json .CgroupVersion}},"security":{{json .SecurityOptions}}}',
          ],
          'build-daemon-information',
        ),
      ),
    );
  if (info.security.some((value) => value.includes('rootless'))) throw new Error('LOAD_CI_DAEMON_UNVERIFIED');
  const admit = async (deadline: number, repeat: boolean, ownSignal = signal) => {
    const local = new AbortController();
    const boundedSignal = AbortSignal.any([ownSignal, local.signal]);
    const timer = setTimeout(() => local.abort(), Math.max(1, deadline - Date.now() - 10000));
    const guard = setTimeout(
      () => {
        process.stderr.write('LOAD_ADMISSION_UNSETTLED\n');
        process.exit(1);
      },
      Math.max(1, deadline - Date.now()),
    );
    try {
      do {
        boundedSignal.throwIfAborted();
        if (Date.now() + 60000 > deadline) throw new Error('LOAD_BUILD_ADMISSION_DEADLINE');
        const sample = await sampleAdmission({
          dockerDataPath: info.root,
          reportPath: output,
          dockerCgroupPath: docker.binding.cgroupPath,
          signal: boundedSignal,
        });
        const admission = evaluateAdmission(site, sample, BUILD_BUDGET, { now: Date.now() });
        await writeEvidence(resolve(output, `admission-${sample.at}.json`), {
          sample,
          admission,
          budget: BUILD_BUDGET,
          docker: docker.binding,
        });
        if (admission.accepted) return;
        if (!repeat) break;
      } while (Date.now() < deadline);
      throw new Error('LOAD_BUILD_ADMISSION_REFUSED');
    } finally {
      clearTimeout(timer);
      clearTimeout(guard);
    }
  };
  let createAttempted = false,
    builderProof: ReturnType<typeof verifyBuilder> | undefined,
    builderClosed = false,
    builderDeleted = false,
    failure = false,
    imageId: string | undefined,
    buildPhaseStartedAt: number | undefined;
  const cleanupFailures: string[] = [];
  try {
    diagnosticPhase = 'build-admission';
    await admit(Date.now() + CI_LIMITS.admissionMs, true);
    diagnosticPhase = 'builder-baseline';
    const listedContainers = (
      await native(['ps', '-aq', '--no-trunc', '--filter', `name=^/${containerName}$`], 'builder-baseline')
    ).trim();
    const listedVolumes = (await native(['volume', 'ls', '-q'], 'builder-volume-baseline')).trim().split(/\s+/);
    if (listedContainers || listedVolumes.includes(volumeName)) throw new Error('LOAD_BUILDER_BASELINE_NOT_EMPTY');
    buildPhaseStartedAt = Date.now();
    const deadline = buildPhaseStartedAt + CI_LIMITS.imagePreparationAndBuildMs;
    const phaseGuard = setTimeout(() => {
      process.stderr.write('LOAD_BUILD_AND_CLEANUP_UNSETTLED\n');
      process.exit(1);
    }, CI_LIMITS.imagePreparationAndBuildMs + CI_LIMITS.builderCleanupMs);
    const phase = new AbortController(),
      phaseTimer = setTimeout(() => phase.abort(), CI_LIMITS.imagePreparationAndBuildMs);
    const phaseSignal = AbortSignal.any([signal, phase.signal]);
    const invoke = (args: readonly string[], label: string, max = 120000) => {
      phaseSignal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('LOAD_IMAGE_PREPARATION_DEADLINE');
      return native(args, label, phaseSignal, Math.min(max, remaining));
    };
    try {
      // daemon pull/unpack은 scope/builder cap 밖의 준비 IO이며 cap됐다고 기록하지 않는다.
      // 고정 digest의 pull·검증·실제 재심사·build 모두 원래15분 안에서 마친다.
      diagnosticPhase = 'pull-buildkit';
      await invoke(['pull', BUILDKIT_IMAGE], 'pull-fixed-buildkit');
      diagnosticPhase = 'verify-buildkit';
      const buildkitId = fixedImageId(
        JSON.parse(await invoke(['image', 'inspect', BUILDKIT_IMAGE], 'buildkit-image-proof', 10000)),
        BUILDKIT_IMAGE,
      );
      diagnosticPhase = 'pull-postgres';
      await invoke(['pull', LOAD_POSTGRES_IMAGE], 'pull-fixed-postgres');
      diagnosticPhase = 'verify-postgres';
      fixedImageId(
        JSON.parse(await invoke(['image', 'inspect', LOAD_POSTGRES_IMAGE], 'postgres-image-proof', 10000)),
        LOAD_POSTGRES_IMAGE,
      );
      createAttempted = true;
      diagnosticPhase = 'builder-create';
      await invoke(
        [
          'buildx',
          'create',
          '--name',
          builder,
          '--driver',
          'docker-container',
          '--driver-opt',
          `image=${BUILDKIT_IMAGE},memory=2147483648,memory-swap=2147483648,cpu-quota=100000,cpu-period=100000,restart-policy=no`,
          docker.binding.endpoint,
        ],
        'create-owned-builder',
        30000,
      );
      diagnosticPhase = 'builder-bootstrap';
      await invoke(['buildx', 'inspect', builder, '--bootstrap'], 'bootstrap-owned-builder', 120000);
      diagnosticPhase = 'builder-runtime';
      const rows: unknown = JSON.parse(await invoke(['inspect', containerName], 'builder-runtime-proof', 10000));
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('LOAD_BUILDER_UNVERIFIED');
      const pid = z.looseObject({ State: z.looseObject({ Pid: z.number().int().positive() }) }).parse(rows[0])
        .State.Pid;
      builderProof = verifyBuilder(rows[0], {
        name: builder,
        imageId: buildkitId,
        cgroupText: await readFile(`/proc/${pid}/cgroup`, 'utf8'),
      });
      diagnosticPhase = 'builder-evidence';
      await writeEvidence(resolve(output, 'builder.json'), {
        ...builderProof,
        budget: BUILD_BUDGET,
        daemonPreparationIoOutsideBuilderCaps: true,
        image: BUILDKIT_IMAGE,
      });
      diagnosticPhase = 'post-builder-admission';
      await admit(deadline, false, phaseSignal);
      phaseSignal.throwIfAborted();
      const iid = resolve(output, 'runtime-image-id');
      diagnosticPhase = 'runtime-build';
      await invoke(
        runtimeBuildArguments(builder, iid, before),
        'build-source-runtime',
        Math.max(1, deadline - Date.now()),
      );
      diagnosticPhase = 'runtime-image';
      imageId = (await readFile(iid, 'utf8')).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('LOAD_IMAGE_SOURCE_INVALID');
      requireImageSource(
        JSON.parse(await invoke(['image', 'inspect', imageId], 'runtime-image-proof', 10000)),
        before.head,
        before.sha256,
      );
    } finally {
      clearTimeout(phaseTimer);
      // 실제 정리는 아래 독립 단계에서 진행한다. 그 단계의 같은 절대 기한을 유지한다.
      clearTimeout(phaseGuard);
    }
  } catch (error) {
    reportFailure(error);
    failure = true;
  } finally {
    diagnosticPhase = 'builder-cleanup';
    const cleanup = async () => {
      const cleanupMs = Math.max(
        1,
        Math.min(
          CI_LIMITS.builderCleanupMs,
          (buildPhaseStartedAt ?? Date.now()) +
            CI_LIMITS.imagePreparationAndBuildMs +
            CI_LIMITS.builderCleanupMs -
            Date.now(),
        ),
      );
      const clean = new AbortController(),
        timer = setTimeout(() => clean.abort(), Math.max(1, cleanupMs - 10000));
      const guard = setTimeout(() => {
        process.stderr.write('LOAD_BUILDER_CLEANUP_UNSETTLED\n');
        process.exit(1);
      }, cleanupMs);
      try {
        if (createAttempted) {
          // 생성 결과/ID가 불명이면 삭제하지 않는다. 원자료를 보존하고 수동 확인으로 넘긴다.
          if (!builderProof) throw new Error('LOAD_BUILDER_IDENTITY_UNCONFIRMED');
          const fresh: unknown = JSON.parse(
            await native(['inspect', builderProof.id], 'builder-cleanup-identity', clean.signal),
          );
          const current = z
            .array(z.looseObject({ Id: z.literal(builderProof.id), Name: z.literal(`/${containerName}`) }))
            .length(1)
            .safeParse(fresh);
          if (!current.success) throw new Error('LOAD_BUILDER_IDENTITY_UNCONFIRMED');
          await native(['stop', '--time', '20', builderProof.id], 'stop-owned-builder', clean.signal, 30000);
          const stopped = z
            .array(
              z.looseObject({
                Id: z.literal(builderProof.id),
                State: z.looseObject({
                  Running: z.literal(false),
                  Pid: z.literal(0),
                  ExitCode: z.literal(0),
                  OOMKilled: z.literal(false),
                }),
              }),
            )
            .length(1)
            .safeParse(JSON.parse(await native(['inspect', builderProof.id], 'builder-actual-exit', clean.signal)));
          if (!stopped.success) throw new Error('LOAD_BUILDER_EXIT_UNCONFIRMED');
          if (
            commands.pending.size ||
            commands.stickyUnsettled ||
            commands.receipts.some((row) => !commandSettled(row))
          )
            throw new Error('LOAD_BUILDER_CHILD_UNSETTLED');
          builderClosed = true;
          // 실패한 빌드의 자기 state volume은 정상 정지 뒤에도 보존한다.
          if (!failure) {
            await native(['buildx', 'rm', builder], 'remove-owned-builder', clean.signal, 30000);
            if (
              (
                await native(
                  ['ps', '-aq', '--no-trunc', '--filter', `name=^/${containerName}$`],
                  'builder-post-container',
                  clean.signal,
                )
              ).trim() ||
              (await native(['volume', 'ls', '-q'], 'builder-post-volume', clean.signal))
                .trim()
                .split(/\s+/)
                .includes(volumeName)
            )
              throw new Error('LOAD_BUILDER_REMAINS');
            builderDeleted = true;
          }
        }
        builderClosed = true;
      } catch {
        cleanupFailures.push('BUILDER_CLEANUP_UNCONFIRMED');
      } finally {
        try {
          await writeEvidence(resolve(output, 'lifecycle.json'), {
            failure,
            builderClosed,
            builderDeleted,
            createAttempted,
            builderProof: builderProof ?? null,
            commands: commands.receipts,
            pending: commands.pending.size,
            stickyUnsettled: commands.stickyUnsettled,
            cleanupFailures,
          });
        } catch {
          cleanupFailures.push('BUILD_LIFECYCLE_WRITE_FAILED');
        }
        clearTimeout(timer);
        clearTimeout(guard);
      }
    };
    await cleanup();
  }
  if (
    failure ||
    !imageId ||
    !builderClosed ||
    !builderDeleted ||
    cleanupFailures.length ||
    commands.pending.size ||
    commands.stickyUnsettled
  )
    throw new Error('LOAD_CI_BUILD_FAILED');
  diagnosticPhase = 'source-after-build';
  const afterBuild = await sourceSnapshot(commands, signal);
  if (before.head !== afterBuild.head || before.sha256 !== afterBuild.sha256) throw new Error('LOAD_CI_SOURCE_CHANGED');
  const driverFailures: Error[] = [];
  let summary: ReturnType<typeof publicLoadSummary> | undefined;
  try {
    diagnosticPhase = 'load-driver';
    await commands.run(
      process.execPath,
      [
        '--import',
        'tsx',
        'tools/load/run.ts',
        '--mode',
        mode,
        '--site',
        'github-hosted',
        '--wait',
        '10',
        '--run',
        bootstrap.runId,
        '--image',
        imageId,
        '--source-head',
        before.head,
        '--source-sha256',
        before.sha256,
      ],
      { label: 'actual-load-driver', signal, timeoutMs: CI_LIMITS.driverMs, env },
    );
    diagnosticPhase = 'driver-evidence';
    const reportPath = resolve(root, '.load-reports', bootstrap.runId);
    const rawRun: unknown = JSON.parse(await readFile(resolve(reportPath, 'run.json'), 'utf8'));
    const lifecycle: unknown = JSON.parse(await readFile(resolve(reportPath, 'lifecycle.json'), 'utf8'));
    summary = publicLoadSummary(rawRun, lifecycle);
    if (summary.sourceHead !== before.head || summary.sourceSha256 !== before.sha256)
      throw new Error('LOAD_CI_SOURCE_CHANGED');
    diagnosticPhase = 'source-after-driver';
    const after = await sourceSnapshot(commands, signal);
    if (
      after.head !== before.head ||
      after.sha256 !== before.sha256 ||
      commands.pending.size ||
      commands.stickyUnsettled ||
      commands.receipts.some((row) => !commandSettled(row) || row.failed || row.exitCode !== 0)
    )
      throw new Error('LOAD_CI_FINAL_UNVERIFIED');
  } catch (error) {
    reportFailure(error);
    driverFailures.push(new Error('LOAD_DRIVER_OR_FINAL_EVIDENCE_FAILED'));
  }
  try {
    diagnosticPhase = 'driver-lifecycle';
    await writeEvidence(resolve(output, 'driver-lifecycle.json'), {
      driverVerified: driverFailures.length === 0,
      source: before,
      commands: commands.receipts,
      pending: commands.pending.size,
      stickyUnsettled: commands.stickyUnsettled,
      failureCount: driverFailures.length,
    });
  } catch {
    driverFailures.push(new Error('LOAD_DRIVER_LIFECYCLE_WRITE_FAILED'));
  }
  if (!driverFailures.length && summary) {
    try {
      diagnosticPhase = 'public-summary';
      await writeEvidence(resolve(output, 'public-summary.json'), summary);
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
          { encoding: 'utf8' },
        );
      process.stdout.write(`${summary.verdict}\n`);
    } catch {
      driverFailures.push(new Error('LOAD_PUBLIC_SUMMARY_WRITE_FAILED'));
    }
  }
  clearTimeout(hard);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (driverFailures.length) throw new AggregateError(driverFailures, 'LOAD_CI_FINAL_FAILED');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    reportFailure(error);
    process.stderr.write('LOAD_CI_FAILED\n');
    process.exit(1);
  });
}
