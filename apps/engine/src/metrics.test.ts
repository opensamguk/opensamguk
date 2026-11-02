import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import { commitMetric, engineMetricSink, observeCommittedStep, type CommitMetricCandidate } from './metrics';

const base: CommitMetricCandidate = {
  worldId: 'metric-world',
  tick: 10_000,
  sequence: 7,
  kind: 'monthly',
  clockMode: 'REALTIME',
  clockTick: 5000,
  clockAnchorAt: 1_030_000,
  turnTermMinutes: 1,
  explicitAdvance: false,
};

describe('실제 commit 뒤의 보수적 지연 측정', () => {
  it('1분 월드의 월정산과 2분 월드의 장수 턴을 원래 시계에서 역산한다', () => {
    expect(commitMetric(base, 1_060_100)).toMatchObject({
      valid: true,
      sampleKind: 'post-commit-upper-bound',
      dueAt: 1_060_000,
      clockEpochAt: 1_000_000,
      lagMs: 100,
    });
    expect(commitMetric({ ...base, kind: 'turn', turnTermMinutes: 2 }, 1_090_500)).toMatchObject({
      kind: 'turn',
      valid: true,
      dueAt: 1_090_000,
      lagMs: 500,
    });
  });

  it('밀린 턴은 현재 checkpoint보다 이른 도래 시각과 전체 지연을 남긴다', () => {
    expect(commitMetric({ ...base, tick: 4000 }, 1_030_001)).toMatchObject({ dueAt: 1_024_000, lagMs: 6001 });
  });

  it('checkpoint 이동은 epoch를 보존하고 재개로 바뀐 epoch는 구별한다', () => {
    const first = commitMetric(base, 1_060_001);
    expect(commitMetric({ ...base, clockTick: 6000, clockAnchorAt: 1_036_000 }, 1_060_001)).toEqual(first);
    expect(commitMetric({ ...base, clockAnchorAt: 1_040_000 }, 1_070_001).clockEpochAt).toBe(1_010_000);
  });

  it.each([
    { clockMode: 'ACCELERATED' as const },
    { explicitAdvance: true },
    { clockAnchorAt: null },
    { turnTermMinutes: 0 },
    { tick: -1 },
    { sequence: 0 },
  ])('실제 시계의 지연으로 판단할 수 없는 입력을 무효로 남긴다: %j', (patch) => {
    expect(commitMetric({ ...base, ...patch }, 1_060_001)).toMatchObject({
      valid: false,
      invalidReason: 'clock',
      lagMs: null,
    });
  });

  it('DB 표본 누락·비정상 시각·미래 tick은 0ms 성공으로 바꾸지 않는다', () => {
    for (const at of [null, NaN, Infinity, 1_059_999])
      expect(commitMetric(base, at)).toMatchObject({ valid: false, invalidReason: 'database-clock', lagMs: null });
  });

  it('기본 OFF와 잘못된 파일 경로를 구별한다', () => {
    expect(engineMetricSink({})).toBeUndefined();
    expect(engineMetricSink({ ENGINE_METRICS_PATH: '' })).toBeUndefined();
    expect(() => engineMetricSink({ ENGINE_METRICS_PATH: 'metrics.jsonl' })).toThrow('절대 파일 경로');
  });

  it('관측 DB 오류는 연결 정보를 남기지 않고 무효 표본을 보존한다', async () => {
    const samples: unknown[] = [];
    const unavailable = {
      $transaction: async () => {
        throw new Error('postgresql://private:credential@example.invalid/game');
      },
    } as unknown as PrismaClient;
    await observeCommittedStep(unavailable, base, async (sample) => void samples.push(sample));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ valid: false, invalidReason: 'database-clock', commitObservedAt: null });
    expect(JSON.stringify(samples)).not.toContain('credential');
  });

  it('표본 저장 실패를 측정 성공으로 숨기지 않는다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'engine-metrics-missing-'));
    try {
      const sink = engineMetricSink({ ENGINE_METRICS_PATH: join(directory, 'absent', 'samples.jsonl') })!;
      await expect(sink(commitMetric(base, 1_060_001))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('동일 tick의 다른 작업과 무효 표본도 버리지 않고 JSONL에 기록한다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'engine-metrics-'));
    try {
      const path = join(directory, 'samples.jsonl');
      const sink = engineMetricSink({ ENGINE_METRICS_PATH: path })!;
      const samples = [
        commitMetric(base, 1_060_001),
        commitMetric({ ...base, kind: 'turn', sequence: 8 }, 1_060_002),
        commitMetric({ ...base, sequence: 9 }, null),
      ];
      for (const sample of samples) await sink(sample);
      expect(
        (await readFile(path, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(samples);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
