import { appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { PrismaClient } from '@opensamguk/db';
import { TICKS_PER_MONTH } from '@opensamguk/rules';

export interface CommitMetricCandidate {
  worldId: string;
  tick: number;
  sequence: number;
  kind: 'turn' | 'monthly';
  clockMode: 'REALTIME' | 'ACCELERATED';
  clockTick: number;
  clockAnchorAt: number | null;
  turnTermMinutes: number;
  explicitAdvance: boolean;
}

export interface CommitMetric {
  version: 1;
  sampleKind: 'post-commit-upper-bound';
  worldId: string;
  tick: number;
  sequence: number;
  kind: 'turn' | 'monthly';
  valid: boolean;
  dueAt: number | null;
  clockEpochAt: number | null;
  commitObservedAt: number | null;
  lagMs: number | null;
  invalidReason?: 'clock' | 'database-clock';
}

export type CommitMetricSink = (metric: CommitMetric) => Promise<void>;

// 성공한 게임 트랜잭션 뒤에 읽은 DB 시각은 실제 commit 시각의 상한이다.
export function commitMetric(candidate: CommitMetricCandidate, observedAt: number | null): CommitMetric {
  const { worldId, tick, sequence, kind, clockTick, clockAnchorAt, turnTermMinutes } = candidate;
  const base = {
    version: 1 as const,
    sampleKind: 'post-commit-upper-bound' as const,
    worldId,
    tick,
    sequence,
    kind,
  };
  if (
    candidate.clockMode !== 'REALTIME' ||
    candidate.explicitAdvance ||
    !Number.isSafeInteger(clockTick) ||
    clockTick < 0 ||
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    clockAnchorAt === null ||
    !Number.isSafeInteger(clockAnchorAt) ||
    !Number.isSafeInteger(turnTermMinutes) ||
    turnTermMinutes < 1
  )
    return {
      ...base,
      valid: false,
      dueAt: null,
      clockEpochAt: null,
      commitObservedAt: observedAt,
      lagMs: null,
      invalidReason: 'clock',
    };
  const millisecondsPerTick = (turnTermMinutes * 60_000) / TICKS_PER_MONTH;
  const clockEpochAt = clockAnchorAt - clockTick * millisecondsPerTick;
  const dueAt = clockAnchorAt + (tick - clockTick) * millisecondsPerTick;
  if (
    observedAt === null ||
    !Number.isSafeInteger(observedAt) ||
    !Number.isFinite(dueAt) ||
    !Number.isFinite(clockEpochAt) ||
    observedAt < dueAt
  )
    return {
      ...base,
      valid: false,
      dueAt,
      clockEpochAt,
      commitObservedAt: observedAt,
      lagMs: null,
      invalidReason: 'database-clock',
    };
  return { ...base, valid: true, dueAt, clockEpochAt, commitObservedAt: observedAt, lagMs: observedAt - dueAt };
}

export function engineMetricSink(env: NodeJS.ProcessEnv = process.env): CommitMetricSink | undefined {
  const path = env.ENGINE_METRICS_PATH;
  if (!path) return undefined;
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('ENGINE_METRICS_PATH는 절대 파일 경로여야 합니다.');
  // append를 기다리므로 종료 시 남은 쓰기 작업이나 별도 타이머가 없다.
  return async (metric) => appendFile(path, JSON.stringify(metric) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export async function observeCommittedStep(
  db: PrismaClient,
  candidate: CommitMetricCandidate,
  sink: CommitMetricSink,
): Promise<void> {
  let observedAt: number | null = null;
  try {
    // 게임 TX 밖의 별도 읽기다. now()/transaction_timestamp()로 commit 시각을 대체하지 않는다.
    observedAt = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', '1500', true)`;
        // JS Date의 밀리초 절삭이 상한을 낮추지 않게 DB에서 올림한다.
        const rows = await tx.$queryRaw<{ observedAt: number }[]>`
          SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS "observedAt"`;
        return rows.length === 1 ? rows[0]!.observedAt : null;
      },
      { timeout: 2000, maxWait: 1000 },
    );
  } catch {
    // 원본 DB 오류를 파일·로그에 남기지 않고 누락 대신 무효 표본을 보존한다.
  }
  await sink(commitMetric(candidate, observedAt));
}
