import { z } from 'zod';
import { LOAD_CONTRACT } from './contract';
import { userWorkload, WORKLOAD_WEIGHTS } from './workload';
import { TICKS_PER_MONTH } from '../../packages/rules/src/index';

const uuid = z.uuid();
const finite = z.number().finite();
const natural = z.number().int().nonnegative();
const phase = z.enum(['warmup', 'measure']);
const procedure = z.enum([
  'home.get',
  'world.summary',
  'world.map',
  'world.list',
  'city.get',
  'nation.get',
  'turns.get',
  'turns.set',
  'message.list',
  'message.send',
  'ranking.generals',
  'ranking.nations',
]);

export const requestSampleSchema = z.strictObject({
  sequence: natural.positive(),
  worldId: uuid,
  userId: uuid,
  procedure,
  phase,
  startedAt: finite,
  finishedAt: finite,
  durationMs: finite.nonnegative(),
  thinkMs: z.number().int().min(1000).max(3000),
  status: natural.max(599),
  outcome: z.enum(['success', 'stale', 'http-error', 'network-error', 'protocol-error']),
});
export type RequestSample = z.infer<typeof requestSampleSchema>;

// L2 CommitMetric 공개 DTO를 읽는다. engine의 실행 코드는 import하지 않는다.
export const commitMetricSchema = z.strictObject({
  version: z.literal(1),
  sampleKind: z.literal('post-commit-upper-bound'),
  worldId: uuid,
  tick: natural,
  sequence: natural.positive(),
  kind: z.enum(['turn', 'monthly']),
  valid: z.boolean(),
  dueAt: finite.nullable(),
  clockEpochAt: finite.nullable(),
  commitObservedAt: finite.nullable(),
  lagMs: finite.nonnegative().nullable(),
  invalidReason: z.enum(['clock', 'database-clock']).optional(),
});
export type LoadCommitMetric = z.infer<typeof commitMetricSchema>;
const witness = z.strictObject({
  worldId: uuid,
  sequence: natural.positive(),
  tick: natural,
  kind: z.enum(['turn', 'monthly']),
});

export const loadRunSchema = z.strictObject({
  version: z.literal(2),
  mode: z.enum(['formal', 'smoke']),
  sourceHead: z.string().regex(/^[a-f0-9]{40}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  warmupStartedAt: finite,
  measurementStartedAt: finite,
  measurementFinishedAt: finite,
  fixtureAccounts: natural,
  workloadSeed: z.string().min(1).max(256),
  workers: z.array(
    z.strictObject({
      worldId: uuid,
      userId: uuid,
      worldIndex: natural,
      userIndex: natural,
      startedAt: finite,
      finishedAt: finite.nullable(),
      attempted: natural,
      completed: natural,
      terminal: z.enum(['window-complete', 'aborted', 'failed']),
    }),
  ),
  attempts: z.array(
    z.strictObject({
      worldId: uuid,
      userId: uuid,
      sequence: natural.positive(),
      procedure,
      thinkMs: z.number().int().min(1000).max(3000),
      startedAt: finite,
      completedAt: finite.nullable(),
    }),
  ),
  generatorFailures: z.array(
    z.enum([
      'SSE_EARLY_END',
      'SSE_READ_FAILED',
      'SSE_CANCEL_FAILED',
      'SSE_PUMP_CLEANUP_FAILED',
      'LOAD_GENERATOR_INTERRUPTED_OR_FAILED',
      'GENERATOR_TASK_REJECTED',
    ]),
  ),
  worlds: z.array(
    z.strictObject({ worldId: uuid, generals: natural, humans: natural, turnTermMinutes: natural.positive() }),
  ),
  sse: z.array(
    z.strictObject({
      worldId: uuid,
      userId: uuid,
      readyAt: finite.nullable(),
      closedAt: finite.nullable(),
      failed: z.boolean(),
    }),
  ),
  requests: z.array(requestSampleSchema),
  metrics: z.array(commitMetricSchema),
  databaseWitnesses: z.array(witness),
  // L4가 metric 파일과 독립된 최종 DB 읽기로 구성한다. 아직 도래 작업이 남으면 합격하지 않는다.
  databaseCoverage: z.array(
    z.strictObject({
      worldId: uuid,
      clockEpochAt: finite,
      observedAt: finite,
      cutoffAt: finite,
      pendingDueTurns: natural,
      pendingDueMonthly: natural,
      committedActionCount: natural,
      lastSequence: natural,
    }),
  ),
  environment: z.strictObject({
    admissionAccepted: z.boolean(),
    admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    maxGeneratorCpuFraction: finite.nonnegative(),
    maxExternalHostCpuFraction: finite.nonnegative(),
    oomCount: natural,
    sourceUnchanged: z.boolean(),
    complete: z.boolean(),
    observations: z.array(
      z.strictObject({
        at: finite,
        generatorCpuFraction: finite.nonnegative(),
        externalHostCpuFraction: finite.nonnegative(),
        oomCount: natural,
      }),
    ),
  }),
});
export type LoadRun = z.infer<typeof loadRunSchema>;
// 서버 지연 합격값과 별개인 생성기 원자료 유효성 경계다.
export const GENERATOR_SCHEDULING_TOLERANCE_MS = 1000;

function requestCoverage(run: LoadRun, sseKeys: ReadonlySet<string>): string[] {
  const invalid: string[] = [];
  const workerKeys = new Set<string>();
  const userSlots = new Set<string>();
  const requestKeys = new Set<string>();
  const attemptKeys = new Set<string>();
  const keyOf = (row: { worldId: string; userId: string }) => `${row.worldId}:${row.userId}`;
  const requestsByUser = new Map<string, LoadRun['requests']>();
  const attemptsByUser = new Map<string, LoadRun['attempts']>();
  for (const row of run.requests) {
    const key = keyOf(row),
      rows = requestsByUser.get(key) ?? [];
    rows.push(row);
    requestsByUser.set(key, rows);
  }
  for (const row of run.attempts) {
    const key = keyOf(row),
      rows = attemptsByUser.get(key) ?? [];
    rows.push(row);
    attemptsByUser.set(key, rows);
  }
  for (const worker of run.workers) {
    const key = keyOf(worker),
      slot = `${worker.worldIndex}:${worker.userIndex}`;
    if (
      workerKeys.has(key) ||
      userSlots.has(slot) ||
      !sseKeys.has(key) ||
      run.worlds[worker.worldIndex]?.worldId !== worker.worldId ||
      worker.userIndex >= (run.mode === 'formal' ? 50 : 5)
    )
      invalid.push('WORKER_IDENTITY_CONFLICT');
    workerKeys.add(key);
    userSlots.add(slot);
    const attempts = (attemptsByUser.get(key) ?? []).sort((a, b) => a.sequence - b.sequence);
    const requests = (requestsByUser.get(key) ?? []).sort((a, b) => a.sequence - b.sequence);
    if (
      worker.terminal !== 'window-complete' ||
      worker.finishedAt === null ||
      worker.finishedAt < run.measurementFinishedAt ||
      worker.startedAt < run.warmupStartedAt ||
      worker.startedAt - run.warmupStartedAt > GENERATOR_SCHEDULING_TOLERANCE_MS ||
      worker.attempted !== attempts.length ||
      worker.completed !== requests.length ||
      attempts.length !== requests.length ||
      !attempts.length
    )
      invalid.push('WORKER_INCOMPLETE');
    const workload = userWorkload(run.workloadSeed, worker.worldIndex, worker.userIndex);
    for (const [index, attempt] of attempts.entries()) {
      const request = requests[index],
        expected = workload.next();
      const actionKey = `${key}:${attempt.sequence}`;
      if (attemptKeys.has(actionKey) || attempt.sequence !== index + 1) invalid.push('ATTEMPT_SEQUENCE_MISSING');
      attemptKeys.add(actionKey);
      if (attempt.procedure !== expected.procedure || attempt.thinkMs !== expected.thinkMs)
        invalid.push('WORKLOAD_SEQUENCE_CONFLICT');
      if (
        !request ||
        request.sequence !== attempt.sequence ||
        request.procedure !== attempt.procedure ||
        request.thinkMs !== attempt.thinkMs ||
        request.startedAt !== attempt.startedAt ||
        attempt.completedAt === null ||
        attempt.completedAt !== request.finishedAt
      )
        invalid.push('REQUEST_ATTEMPT_COMPLETION_CONFLICT');
      if (request) requestKeys.add(`${key}:${request.sequence}`);
      const earliest =
        index === 0
          ? worker.startedAt
          : requests[index - 1] === undefined
            ? NaN
            : requests[index - 1]!.finishedAt + requests[index - 1]!.thinkMs;
      if (
        !Number.isFinite(earliest) ||
        attempt.startedAt < earliest - 0.01 ||
        attempt.startedAt - earliest > GENERATOR_SCHEDULING_TOLERANCE_MS
      )
        invalid.push('GENERATOR_SCHEDULING_GAP');
    }
    const last = requests.at(-1);
    if (
      !last ||
      last.finishedAt + last.thinkMs < run.measurementFinishedAt - GENERATOR_SCHEDULING_TOLERANCE_MS ||
      worker.finishedAt === null ||
      worker.finishedAt < last.finishedAt ||
      worker.finishedAt - Math.max(run.measurementFinishedAt, last.finishedAt) > GENERATOR_SCHEDULING_TOLERANCE_MS
    )
      invalid.push('REQUEST_TAIL_INCOMPLETE');
  }
  if (
    workerKeys.size !== sseKeys.size ||
    [...sseKeys].some((key) => !workerKeys.has(key)) ||
    requestKeys.size !== run.requests.length ||
    attemptKeys.size !== run.attempts.length
  )
    invalid.push('REQUEST_JOURNAL_COVERAGE_MISSING');
  return invalid;
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (
    !Number.isFinite(fraction) ||
    fraction <= 0 ||
    fraction > 1 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error('LOAD_PERCENTILE_INPUT_INVALID');
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function actionKey(action: z.infer<typeof witness>) {
  return `${action.worldId}:${action.sequence}`;
}

export function evaluateLoadRun(raw: unknown) {
  const parsed = loadRunSchema.safeParse(raw);
  if (!parsed.success) return { verdict: 'INVALID' as const, invalid: ['RAW_SCHEMA'], failed: [] as string[] };
  const run = parsed.data;
  const invalid: string[] = [];
  const failed: string[] = [];
  const worldIds = new Set(run.worlds.map((world) => world.worldId));
  if (run.generatorFailures.length) invalid.push('GENERATOR_INCOMPLETE');
  const inMeasure = (time: number) => time >= run.measurementStartedAt && time < run.measurementFinishedAt;
  if (worldIds.size !== 2 || run.worlds.length !== 2) invalid.push('TWO_DISTINCT_WORLDS_REQUIRED');
  if (!run.environment.complete || !run.environment.sourceUnchanged || !run.environment.admissionAccepted)
    invalid.push('ENVIRONMENT_OR_SOURCE_UNCONFIRMED');
  if (
    run.environment.maxGeneratorCpuFraction > 0.7 ||
    run.environment.maxExternalHostCpuFraction > 0.9 ||
    run.environment.oomCount !== 0
  )
    invalid.push('RESOURCE_CONTAMINATION');
  if (run.measurementFinishedAt <= run.measurementStartedAt || run.measurementStartedAt <= run.warmupStartedAt)
    invalid.push('TIME_WINDOW_INVALID');
  const observations = run.environment.observations;
  if (
    !observations.length ||
    observations[0]!.at > run.measurementStartedAt ||
    observations.at(-1)!.at < run.measurementFinishedAt ||
    observations.some(
      (row, index) =>
        index > 0 && (row.at <= observations[index - 1]!.at || row.at - observations[index - 1]!.at > 10000),
    ) ||
    run.environment.maxGeneratorCpuFraction !== Math.max(...observations.map((row) => row.generatorCpuFraction)) ||
    run.environment.maxExternalHostCpuFraction !==
      Math.max(...observations.map((row) => row.externalHostCpuFraction)) ||
    observations.some((row) => row.oomCount > run.environment.oomCount)
  )
    invalid.push('RESOURCE_OBSERVATIONS_INCOMPLETE');
  if (run.mode === 'formal') {
    if (
      run.fixtureAccounts !== 218 ||
      run.worlds.some((world) => world.generals < 600 || world.humans !== 109) ||
      run.worlds[0]?.turnTermMinutes !== 1 ||
      run.worlds[1]?.turnTermMinutes !== 2
    )
      invalid.push('FORMAL_FIXTURE_REQUIRED');
    if (
      run.measurementStartedAt - run.warmupStartedAt < LOAD_CONTRACT.warmupMs ||
      run.measurementFinishedAt - run.measurementStartedAt < LOAD_CONTRACT.measurementMs
    )
      invalid.push('FORMAL_DURATION_INCOMPLETE');
  }
  const sseKeys = new Set<string>();
  for (const connection of run.sse) {
    const key = `${connection.worldId}:${connection.userId}`;
    if (sseKeys.has(key) || !worldIds.has(connection.worldId)) invalid.push('SSE_IDENTITY_DUPLICATE_OR_FOREIGN');
    sseKeys.add(key);
    if (
      connection.failed ||
      connection.readyAt === null ||
      connection.readyAt > run.measurementStartedAt ||
      connection.closedAt === null ||
      connection.closedAt < run.measurementFinishedAt
    )
      invalid.push('SSE_NOT_CONTINUOUS');
  }
  if (
    run.mode === 'formal' &&
    (run.sse.length !== 100 ||
      run.worlds.some((world) => run.sse.filter((connection) => connection.worldId === world.worldId).length !== 50))
  )
    invalid.push('SSE_100_REQUIRED');
  const measured = run.requests.filter((sample) => sample.phase === 'measure');
  for (const sample of run.requests) {
    if (
      !worldIds.has(sample.worldId) ||
      sample.finishedAt < sample.startedAt ||
      Math.abs(sample.finishedAt - sample.startedAt - sample.durationMs) > 0.01 ||
      (sample.phase === 'measure' && !inMeasure(sample.startedAt)) ||
      (sample.phase === 'warmup' &&
        (sample.startedAt < run.warmupStartedAt || sample.startedAt >= run.measurementStartedAt))
    )
      invalid.push('REQUEST_WINDOW_OR_WORLD_INVALID');
    if ((sample.outcome === 'success' || sample.outcome === 'stale') && (sample.status < 200 || sample.status >= 300))
      invalid.push('REQUEST_OUTCOME_CONFLICT');
    if (
      (sample.outcome === 'http-error' && sample.status < 400) ||
      (sample.outcome === 'network-error' && sample.status !== 0)
    )
      invalid.push('REQUEST_OUTCOME_CONFLICT');
    if (sample.outcome === 'network-error' || sample.outcome === 'protocol-error')
      failed.push('REQUEST_TRANSPORT_OR_PROTOCOL');
  }
  if (!measured.length || run.worlds.some((world) => !measured.some((sample) => sample.worldId === world.worldId)))
    invalid.push('REQUESTS_MISSING');
  const measuredUsers = new Set(measured.map((sample) => `${sample.worldId}:${sample.userId}`));
  if (
    [...measuredUsers].some((key) => !sseKeys.has(key)) ||
    (run.mode === 'formal' && [...sseKeys].some((key) => !measuredUsers.has(key)))
  )
    invalid.push('REQUEST_USER_COVERAGE_MISSING');
  if (
    run.mode === 'formal' &&
    WORKLOAD_WEIGHTS.some((entry) => !measured.some((sample) => sample.procedure === entry.procedure))
  )
    invalid.push('WORKLOAD_PROCEDURE_MISSING');
  invalid.push(...requestCoverage(run, sseKeys));
  const witnessMap = new Map<string, z.infer<typeof witness>>();
  for (const action of run.databaseWitnesses) {
    const key = actionKey(action);
    if (!worldIds.has(action.worldId) || witnessMap.has(key)) invalid.push('DATABASE_WITNESS_DUPLICATE_OR_FOREIGN');
    witnessMap.set(key, action);
  }
  const metricKeys = new Set<string>();
  const epochs = new Map<string, number>();
  for (const metric of run.metrics) {
    const key = actionKey(metric);
    const action = witnessMap.get(key);
    if (metricKeys.has(key) || !action || action.tick !== metric.tick || action.kind !== metric.kind)
      invalid.push('COMMIT_COVERAGE_CONFLICT');
    metricKeys.add(key);
    if (
      !metric.valid ||
      metric.invalidReason ||
      metric.dueAt === null ||
      metric.clockEpochAt === null ||
      metric.commitObservedAt === null ||
      metric.lagMs === null ||
      metric.commitObservedAt < metric.dueAt ||
      metric.lagMs !== metric.commitObservedAt - metric.dueAt
    )
      invalid.push('COMMIT_METRIC_INVALID');
    if (metric.clockEpochAt !== null) {
      if (epochs.has(metric.worldId) && epochs.get(metric.worldId) !== metric.clockEpochAt)
        invalid.push('CLOCK_EPOCH_CHANGED');
      epochs.set(metric.worldId, metric.clockEpochAt);
      const world = run.worlds.find((candidate) => candidate.worldId === metric.worldId);
      if (
        !world ||
        metric.dueAt !== metric.clockEpochAt + (metric.tick * world.turnTermMinutes * 60_000) / TICKS_PER_MONTH
      )
        invalid.push('DUE_AT_CLOCK_CONFLICT');
    }
  }
  if (!witnessMap.size || witnessMap.size !== metricKeys.size) invalid.push('COMMIT_SAMPLE_MISSING');
  const coverageWorlds = new Set<string>();
  for (const coverage of run.databaseCoverage) {
    const witnesses = run.databaseWitnesses.filter((row) => row.worldId === coverage.worldId);
    const metrics = run.metrics.filter((row) => row.worldId === coverage.worldId);
    if (
      coverageWorlds.has(coverage.worldId) ||
      !worldIds.has(coverage.worldId) ||
      coverage.cutoffAt !== run.measurementFinishedAt ||
      coverage.observedAt < coverage.cutoffAt ||
      coverage.clockEpochAt !== epochs.get(coverage.worldId) ||
      coverage.pendingDueTurns !== 0 ||
      coverage.pendingDueMonthly !== 0 ||
      coverage.committedActionCount !== witnesses.length ||
      witnesses.some((row) => row.sequence > coverage.lastSequence) ||
      metrics.some((row) => row.commitObservedAt === null || row.commitObservedAt > coverage.observedAt)
    )
      invalid.push('DUE_ACTION_TAIL_UNCONFIRMED');
    coverageWorlds.add(coverage.worldId);
  }
  if (coverageWorlds.size !== worldIds.size) invalid.push('DUE_ACTION_TAIL_UNCONFIRMED');
  const measuredMetrics = run.metrics.filter((metric) => metric.dueAt !== null && inMeasure(metric.dueAt));
  for (const [index, world] of run.worlds.entries()) {
    const metrics = measuredMetrics.filter((metric) => metric.worldId === world.worldId);
    if (!metrics.some((metric) => metric.kind === 'turn')) invalid.push('TURN_METRIC_MISSING');
    const minimumMonths = index === 0 ? 15 : 7;
    if (run.mode === 'formal' && metrics.filter((metric) => metric.kind === 'monthly').length < minimumMonths)
      invalid.push('MONTHLY_SETTLEMENTS_MISSING');
  }
  const p95Ms = percentile(
    measured.map((sample) => sample.durationMs),
    0.95,
  );
  const lags = measuredMetrics.flatMap((metric) => (metric.lagMs === null ? [] : [metric.lagMs]));
  const maxCommitUpperBoundMs = lags.length ? Math.max(...lags) : null;
  const errors5xx = measured.filter((sample) => sample.status >= 500).length;
  const unexpected4xx = measured.filter((sample) => sample.status >= 400 && sample.status < 500).length;
  if (p95Ms !== null && p95Ms >= 300) failed.push('API_P95_LIMIT');
  if (maxCommitUpperBoundMs !== null && maxCommitUpperBoundMs >= 10000) failed.push('COMMIT_LAG_LIMIT');
  if (errors5xx) failed.push('HTTP_5XX');
  if (measured.length && unexpected4xx / measured.length >= 0.001) failed.push('HTTP_4XX_RATIO');
  const verdict = invalid.length
    ? ('INVALID' as const)
    : failed.length
      ? ('FAIL' as const)
      : run.mode === 'smoke'
        ? ('SMOKE_ONLY' as const)
        : ('PASS' as const);
  return {
    verdict,
    invalid: [...new Set(invalid)],
    failed: [...new Set(failed)],
    measuredRequests: measured.length,
    p95Ms,
    maxCommitUpperBoundMs,
    errors5xx,
    unexpected4xx,
    stale: measured.filter((sample) => sample.outcome === 'stale').length,
    procedures: WORKLOAD_WEIGHTS.map((entry) => {
      const samples = measured.filter((sample) => sample.procedure === entry.procedure);
      return {
        procedure: entry.procedure,
        expectedFraction: entry.weight / 1000,
        count: samples.length,
        p50Ms: percentile(
          samples.map((sample) => sample.durationMs),
          0.5,
        ),
        p95Ms: percentile(
          samples.map((sample) => sample.durationMs),
          0.95,
        ),
        p99Ms: percentile(
          samples.map((sample) => sample.durationMs),
          0.99,
        ),
      };
    }),
  };
}
