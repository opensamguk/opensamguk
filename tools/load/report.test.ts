import { describe, expect, it } from 'vitest';
import { evaluateLoadRun, GENERATOR_SCHEDULING_TOLERANCE_MS, percentile, type LoadRun } from './report';
import { userWorkload } from './workload';

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

// 집계 수학의 순수 고정물이다. 실제 부하·월드·계정 인수 증거가 아니다.
function mathematicalRun(duration = 25, firstDispatchDelay = 0): LoadRun {
  const start = 1_000_000,
    end = start + 900_000;
  const worlds = [1, 2].map((turnTermMinutes, index) => ({
    worldId: id(5000 + index),
    generals: 600,
    humans: 109,
    turnTermMinutes,
  }));
  const metrics: LoadRun['metrics'] = [];
  for (const [index, world] of worlds.entries()) {
    const epoch = start + 1000 - 30_000 * world.turnTermMinutes * 6;
    for (let month = 0; month < (index === 0 ? 15 : 7); month++) {
      const tick = (month + 3) * 10_000;
      const dueAt = epoch + tick * world.turnTermMinutes * 6;
      metrics.push({
        version: 1,
        sampleKind: 'post-commit-upper-bound',
        worldId: world.worldId,
        tick,
        sequence: month + 1,
        kind: 'monthly',
        valid: true,
        dueAt,
        clockEpochAt: epoch,
        commitObservedAt: dueAt + 25,
        lagMs: 25,
      });
    }
    const dueAt = epoch + 30_001 * world.turnTermMinutes * 6;
    metrics.push({
      version: 1,
      sampleKind: 'post-commit-upper-bound',
      worldId: world.worldId,
      tick: 30_001,
      sequence: 100,
      kind: 'turn',
      valid: true,
      dueAt,
      clockEpochAt: epoch,
      commitObservedAt: dueAt + 25,
      lagMs: 25,
    });
  }
  const workloadSeed = 'pure-mathematical-coverage-v2';
  const requests: LoadRun['requests'] = [],
    attempts: LoadRun['attempts'] = [],
    workers: LoadRun['workers'] = [];
  const sse: LoadRun['sse'] = [];
  for (let user = 0; user < 100; user++) {
    const worldIndex = Math.floor(user / 50),
      userIndex = user % 50,
      worldId = worlds[worldIndex]!.worldId,
      userId = id(user + 1);
    const workload = userWorkload(workloadSeed, worldIndex, userIndex);
    let at = start - 120_000 + (user === 0 ? firstDispatchDelay : 0),
      sequence = 0,
      finishedAt = 0;
    while (at < end) {
      const next = workload.next();
      sequence++;
      finishedAt = at + duration;
      requests.push({
        worldId,
        userId,
        sequence,
        ...next,
        phase: at < start ? 'warmup' : 'measure',
        startedAt: at,
        finishedAt,
        durationMs: duration,
        status: 200,
        outcome: 'success',
      });
      attempts.push({ worldId, userId, sequence, ...next, startedAt: at, completedAt: finishedAt });
      at = finishedAt + next.thinkMs;
    }
    workers.push({
      worldId,
      userId,
      worldIndex,
      userIndex,
      startedAt: start - 120_000,
      finishedAt: Math.max(end, finishedAt),
      attempted: sequence,
      completed: sequence,
      terminal: 'window-complete',
    });
    sse.push({ worldId, userId, readyAt: start - 120_001, closedAt: Math.max(end, finishedAt) + 1, failed: false });
  }
  return {
    version: 2,
    mode: 'formal',
    sourceHead: 'a'.repeat(40),
    sourceSha256: 'b'.repeat(64),
    warmupStartedAt: start - 120_000,
    measurementStartedAt: start,
    measurementFinishedAt: end,
    fixtureAccounts: 218,
    workloadSeed,
    workers,
    attempts,
    generatorFailures: [],
    worlds,
    sse,
    requests,
    metrics,
    databaseWitnesses: metrics.map(({ worldId, sequence, tick, kind }) => ({ worldId, sequence, tick, kind })),
    databaseCoverage: worlds.map((world) => ({
      worldId: world.worldId,
      clockEpochAt: metrics.find((row) => row.worldId === world.worldId)!.clockEpochAt!,
      observedAt: end + 20_000,
      cutoffAt: end,
      pendingDueTurns: 0,
      pendingDueMonthly: 0,
      committedActionCount: metrics.filter((row) => row.worldId === world.worldId).length,
      lastSequence: 100,
    })),
    environment: {
      admissionAccepted: true,
      admissionSha256: 'c'.repeat(64),
      maxGeneratorCpuFraction: 0.5,
      maxExternalHostCpuFraction: 0.5,
      oomCount: 0,
      sourceUnchanged: true,
      complete: true,
      observations: Array.from({ length: 181 }, (_, index) => ({
        at: start + index * 5000,
        generatorCpuFraction: 0.5,
        externalHostCpuFraction: 0.5,
        oomCount: 0,
      })),
    },
  };
}

describe('L3 리포트 순수 집계', () => {
  it('모든측정과근거가있는수학고정물만PASS로집계한다', () => {
    const run = mathematicalRun();
    expect(evaluateLoadRun(run)).toMatchObject({
      verdict: 'PASS',
      p95Ms: 25,
      maxCommitUpperBoundMs: 25,
      measuredRequests: run.requests.filter((row) => row.phase === 'measure').length,
    });
  });
  it('p95는nearest-rank이고빈표본은값이없다', () => {
    expect(
      percentile(
        Array.from({ length: 100 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(95);
    expect(percentile([], 0.95)).toBeNull();
    expect(() => percentile([NaN], 0.95)).toThrow();
  });
  it.each([300, 301])('API p95%sms는실패다', (duration) => {
    const run = mathematicalRun(duration);
    expect(evaluateLoadRun(run)).toMatchObject({ verdict: 'FAIL', failed: ['API_P95_LIMIT'] });
  });
  it('10000ms 상계는실패이며정확commit이라고표시하지않는다', () => {
    const run = mathematicalRun(),
      metric = run.metrics[0]!;
    metric.lagMs = 10000;
    metric.commitObservedAt = metric.dueAt! + 10000;
    expect(evaluateLoadRun(run)).toMatchObject({ verdict: 'FAIL', failed: ['COMMIT_LAG_LIMIT'] });
  });
  it.each(['metric', 'witness', 'invalid', 'epoch', 'due', 'duplicate', 'monthly'] as const)(
    '%s누락·상충을버리지않고INVALID로남긴다',
    (kind) => {
      const run = mathematicalRun();
      if (kind === 'metric') run.metrics.pop();
      if (kind === 'witness') run.databaseWitnesses.pop();
      if (kind === 'invalid') run.metrics[0]!.valid = false;
      if (kind === 'epoch') run.metrics[0]!.clockEpochAt! += 1;
      if (kind === 'due') run.metrics[0]!.dueAt! += 1;
      if (kind === 'duplicate') run.metrics.push({ ...run.metrics[0]! });
      if (kind === 'monthly') {
        const gone = run.metrics.shift()!;
        run.databaseWitnesses = run.databaseWitnesses.filter(
          (row) => row.worldId !== gone.worldId || row.sequence !== gone.sequence,
        );
      }
      expect(evaluateLoadRun(run).verdict).toBe('INVALID');
    },
  );
  it.each(['sse', 'user', 'short', 'source', 'cpu', 'oom', 'admission', 'empty'] as const)(
    '%s부족을합격으로계산하지않는다',
    (kind) => {
      const run = mathematicalRun();
      if (kind === 'sse') run.sse[0]!.closedAt = run.measurementStartedAt + 100;
      if (kind === 'user') for (const sample of run.requests) sample.userId = id(1);
      if (kind === 'short') run.measurementFinishedAt--;
      if (kind === 'source') run.environment.sourceUnchanged = false;
      if (kind === 'cpu') run.environment.maxGeneratorCpuFraction = 0.701;
      if (kind === 'oom') run.environment.oomCount++;
      if (kind === 'admission') run.environment.admissionAccepted = false;
      if (kind === 'empty') run.requests = [];
      expect(evaluateLoadRun(run).verdict).toBe('INVALID');
    },
  );
  it('5xx와정확0.1%의4xx는지연이낮아도실패다', () => {
    const run = mathematicalRun();
    const measured = run.requests.filter((row) => row.phase === 'measure');
    measured[0]!.status = 500;
    measured[0]!.outcome = 'http-error';
    expect(evaluateLoadRun(run).verdict).toBe('FAIL');
    for (const row of measured.slice(0, Math.ceil(measured.length * 0.001))) {
      row.status = 429;
      row.outcome = 'http-error';
    }
    expect(evaluateLoadRun(run)).toMatchObject({ verdict: 'FAIL', failed: ['HTTP_4XX_RATIO'] });
  });
  it('측정중시작한요청의늦은본문완료를원분포에서버리지않는다', () => {
    const run = mathematicalRun();
    const worker = run.workers[0]!,
      sample = run.requests.filter((row) => row.userId === worker.userId).at(-1)!;
    sample.finishedAt = run.measurementFinishedAt + 100;
    sample.durationMs = sample.finishedAt - sample.startedAt;
    run.attempts.find((row) => row.userId === worker.userId && row.sequence === sample.sequence)!.completedAt =
      sample.finishedAt;
    worker.finishedAt = sample.finishedAt;
    expect(evaluateLoadRun(run)).toMatchObject({
      verdict: 'PASS',
      measuredRequests: run.requests.filter((row) => row.phase === 'measure').length,
    });
  });
  it('smoke와잘못된raw는정식PASS가아니다', () => {
    const run = mathematicalRun();
    run.mode = 'smoke';
    run.workers = run.workers.filter((row) => row.userIndex < 5);
    const users = new Set(run.workers.map((row) => row.userId));
    run.sse = run.sse.filter((row) => users.has(row.userId));
    run.requests = run.requests.filter((row) => users.has(row.userId));
    run.attempts = run.attempts.filter((row) => users.has(row.userId));
    expect(evaluateLoadRun(run).verdict).toBe('SMOKE_ONLY');
    expect(evaluateLoadRun({})).toMatchObject({ verdict: 'INVALID', invalid: ['RAW_SCHEMA'] });
  });
  it.each(['latency', 'outcome', 'resources', 'generator', 'think'] as const)(
    '%s원자료상충을합격으로바꾸지않는다',
    (kind) => {
      const run = mathematicalRun();
      if (kind === 'latency') run.requests[0]!.durationMs = 0;
      if (kind === 'outcome') run.requests[0]!.outcome = 'http-error';
      if (kind === 'resources') run.environment.observations = [];
      if (kind === 'generator') run.generatorFailures.push('GENERATOR_TASK_REJECTED');
      if (kind === 'think') run.requests[0]!.thinkMs = 999;
      expect(evaluateLoadRun(run).verdict).toBe('INVALID');
    },
  );

  it('측정끝뒤commit된측정구간도래작업의11000ms지연을버리지않는다', () => {
    const run = mathematicalRun(),
      base = run.metrics[0]!,
      interval = 6;
    const tick = Math.floor((run.measurementFinishedAt - 1 - base.clockEpochAt!) / interval);
    const dueAt = base.clockEpochAt! + tick * interval;
    const metric = {
      ...base,
      sequence: 101,
      kind: 'turn' as const,
      tick,
      dueAt,
      commitObservedAt: dueAt + 11000,
      lagMs: 11000,
    };
    run.metrics.push(metric);
    run.databaseWitnesses.push({ worldId: metric.worldId, sequence: metric.sequence, tick, kind: 'turn' });
    run.databaseCoverage[0]!.committedActionCount++;
    run.databaseCoverage[0]!.lastSequence = 101;
    expect(evaluateLoadRun(run)).toMatchObject({
      verdict: 'FAIL',
      maxCommitUpperBoundMs: 11000,
      failed: ['COMMIT_LAG_LIMIT'],
    });
  });
  it.each(['turn', 'monthly', 'missing', 'count', 'early-snapshot'] as const)(
    '최종DB%s꼬리가미확정이면INVALID다',
    (kind) => {
      const run = mathematicalRun();
      if (kind === 'turn') run.databaseCoverage[0]!.pendingDueTurns = 1;
      if (kind === 'monthly') run.databaseCoverage[0]!.pendingDueMonthly = 1;
      if (kind === 'missing') run.databaseCoverage.pop();
      if (kind === 'count') run.databaseCoverage[0]!.committedActionCount--;
      if (kind === 'early-snapshot') run.databaseCoverage[0]!.observedAt = run.measurementFinishedAt - 1;
      expect(evaluateLoadRun(run)).toMatchObject({
        verdict: 'INVALID',
        invalid: expect.arrayContaining(['DUE_ACTION_TAIL_UNCONFIRMED']),
      });
    },
  );
  it.each(['tail', 'middle', 'prefix', 'procedure', 'uncompleted', 'seed'] as const)(
    '사용자별%s누락·교체를원자료에서찾는다',
    (kind) => {
      const run = mathematicalRun(),
        worker = run.workers[0]!;
      const rows = run.requests.filter((row) => row.userId === worker.userId);
      const gone = kind === 'tail' ? rows.slice(-50) : [rows[kind === 'prefix' ? 0 : 100]!];
      if (kind === 'tail' || kind === 'middle' || kind === 'prefix') {
        const ids = new Set(gone.map((row) => row.sequence));
        run.requests = run.requests.filter((row) => row.userId !== worker.userId || !ids.has(row.sequence));
        run.attempts = run.attempts.filter((row) => row.userId !== worker.userId || !ids.has(row.sequence));
        worker.attempted -= gone.length;
        worker.completed -= gone.length;
      }
      if (kind === 'procedure') {
        const row = rows[100]!,
          attempt = run.attempts.find((item) => item.userId === row.userId && item.sequence === row.sequence)!;
        row.procedure = row.procedure === 'home.get' ? 'world.map' : 'home.get';
        attempt.procedure = row.procedure;
      }
      if (kind === 'uncompleted') run.attempts[0]!.completedAt = null;
      if (kind === 'seed') run.workloadSeed = 'replaced';
      expect(evaluateLoadRun(run).verdict).toBe('INVALID');
    },
  );
  it('생성기1000ms지터경계는성능FAIL과별도INVALID로판정한다', () => {
    expect(evaluateLoadRun(mathematicalRun(25, GENERATOR_SCHEDULING_TOLERANCE_MS)).verdict).toBe('PASS');
    expect(evaluateLoadRun(mathematicalRun(25, GENERATOR_SCHEDULING_TOLERANCE_MS + 0.01))).toMatchObject({
      verdict: 'INVALID',
      invalid: expect.arrayContaining(['GENERATOR_SCHEDULING_GAP']),
      failed: [],
    });
  });
  it('느린응답때문에요청수가줄어도임의RPS하한을쓰지않는다', () => {
    expect(evaluateLoadRun(mathematicalRun(2000))).toMatchObject({
      verdict: 'FAIL',
      invalid: [],
      failed: ['API_P95_LIMIT'],
    });
  });
  it('900초중처음100초만남긴가짜완료원자료를거부한다', () => {
    const run = mathematicalRun();
    run.requests = run.requests.filter((row) => row.startedAt < run.measurementStartedAt + 100_000);
    run.attempts = run.attempts.filter((row) => row.startedAt < run.measurementStartedAt + 100_000);
    for (const worker of run.workers) {
      worker.attempted = run.attempts.filter((row) => row.userId === worker.userId).length;
      worker.completed = worker.attempted;
    }
    expect(evaluateLoadRun(run)).toMatchObject({
      verdict: 'INVALID',
      invalid: expect.arrayContaining(['REQUEST_TAIL_INCOMPLETE']),
    });
  });
});
