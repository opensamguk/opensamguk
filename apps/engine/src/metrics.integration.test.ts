import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import type { WorldInit } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { acquireLease, releaseLease, type Lease } from './lease';
import { TurnLoop } from './turnLoop';
import type { CommitMetric, CommitMetricSink } from './metrics';
import { controlClock } from './world/clock';
import { readWorldState, saveInitialWorld } from './world/persistence';
import { exportReplay, replayArchive } from './replay';

// 측정 어댑터의 실제 TX 경계 검사다. 정식 시나리오·600장수 부하 인수는 별도로 실행한다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('지연 측정 전용 테스트 DB가 필요합니다.');
const parsed = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
  !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(parsed.pathname) ||
  parsed.searchParams.has('host') ||
  parsed.searchParams.has('port')
)
  throw new Error('loopback 전용 테스트 DB를 확인하세요.');
const db = createDb(url);
const owned: string[] = [];
const leases: Lease[] = [];
let failed = false;
let uncertain = false;
let cleanupDeadline = Infinity;
const activeSignal = new AsyncLocalStorage<AbortSignal>();
const controllers: AbortController[] = [];
const pending = new Set<Promise<unknown>>();

async function bounded<T>(work: () => PromiseLike<T>, budgetMs: number): Promise<T> {
  const promise = Promise.resolve().then(work);
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          uncertain = true;
          failed = true;
          reject(new Error('측정 계약 작업의 종료를 확인하지 못했습니다.'));
        }, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function query<T>(work: () => PromiseLike<T>): Promise<T> {
  const signal = activeSignal.getStore();
  signal?.throwIfAborted();
  const remaining = Math.min(10_000, cleanupDeadline - Date.now());
  if (remaining <= 0) throw new Error('측정 계약 정리 시간 만료');
  const result = await bounded(work, remaining);
  signal?.throwIfAborted();
  return result;
}

afterAll(async () => {
  const errors: unknown[] = [];
  cleanupDeadline = Date.now() + 18_000;
  for (const controller of controllers) controller.abort();
  try {
    if (pending.size)
      try {
        const remaining = [...pending];
        await bounded(() => Promise.allSettled(remaining), 8000);
      } catch (error) {
        errors.push(error);
      }
    if (!pending.size) {
      for (const lease of leases) {
        if (pending.size || uncertain) {
          errors.push(new Error('미정착 작업 뒤의 추가 실행권 변경을 중단하고 자기 DB를 보존합니다.'));
          break;
        }
        try {
          await query(() => releaseLease(db, lease));
        } catch (error) {
          failed = true;
          errors.push(error);
        }
      }
      if (!failed && !uncertain)
        try {
          await query(() => db.world.deleteMany({ where: { id: { in: owned } } }));
        } catch (error) {
          errors.push(error);
        }
    } else errors.push(new Error('실행 중인 작업과 자기 DB를 보존합니다.'));
  } finally {
    // 원 hook30초 안에서 공유18초 정리와 독립10초 연결 종료를 따로 예약한다.
    try {
      await bounded(() => db.$disconnect(), 10_000);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, '측정 계약 정리 실패; 기존 오류와 DB 보존');
});

function metricInitialState(source: WorldInit): WorldInit {
  const initial = structuredClone(source);
  const secondTurn = initial.generals.find((general) => general.id === 3);
  if (!secondTurn || secondTurn.nextTurnTick !== 500 || secondTurn.activeFromYear !== initial.startYear + 1)
    throw new Error('측정 전용 두 번째 턴 fixture의 초기 계약이 다릅니다.');
  // 공용 월정산 fixture의 미래 등장 장수를 이 측정 시험에서만 첫해 500tick에 실행한다.
  secondTurn.activeFromYear = initial.startYear;
  return initial;
}

async function fixture() {
  const initial = metricInitialState(await monthlyFixture());
  activeSignal.getStore()?.throwIfAborted();
  const { worldId } = await query(async () => {
    const result = await saveInitialWorld(db, initial, {
      replayFormat: 'legacy',
      name: 'AC-M3-07 commit 지연 계약',
      turnTermMinutes: 60,
      endYear: null,
    });
    owned.push(result.worldId);
    return result;
  });
  await query(() => controlClock(db, worldId, 'start'));
  // 실제 REALTIME poll이 한 달의 밀린 작업을 처리하도록 자기 fixture 시계만 배치한다.
  await query(
    () => db.$executeRaw`UPDATE "World" SET "clockAnchorAt" =
      (clock_timestamp() AT TIME ZONE 'UTC') - interval '3600.01 seconds' WHERE id = ${worldId}`,
  );
  const lease = await query(async () => {
    const result = await acquireLease(db, worldId);
    if (result) leases.push(result);
    return result;
  });
  if (!lease) throw new Error('측정 fixture 실행권 획득 실패');
  return { worldId, lease };
}

async function drain(loop: TurnLoop) {
  for (let batch = 0; batch < 10; batch++) if (!(await query(() => loop.poll(activeSignal.getStore()))).more) return;
  throw new Error('측정 fixture가 10 batch 안에 끝나지 않았습니다.');
}

function checkedCase(run: () => Promise<void>) {
  return async ({ signal: runnerSignal }: TestContext) => {
    const controller = new AbortController();
    controllers.push(controller);
    const signal = AbortSignal.any([runnerSignal, controller.signal]);
    const aborted = () => {
      failed = true;
    };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      signal.throwIfAborted();
      if (pending.size) {
        const previous = [...pending];
        await bounded(() => Promise.allSettled(previous), 8000);
      }
      if (failed || uncertain || pending.size) throw new Error('이전 시험의 실패·미정착 상태와 DB를 보존합니다.');
      await activeSignal.run(signal, () => bounded(run, 30_000));
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      signal.removeEventListener('abort', aborted);
    }
  };
}

describe('AC-M3-07 실제 PostgreSQL commit 관측 계약', () => {
  it(
    '장수 턴·월정산·같은 tick은 성공한 commit 뒤에 sequence별로 한 번 기록한다',
    checkedCase(async () => {
      const { worldId, lease } = await fixture();
      const samples: CommitMetric[] = [];
      const sink: CommitMetricSink = async (sample) => {
        const committed = await query(() => db.world.findUniqueOrThrow({ where: { id: worldId } }));
        expect(committed.actionSequence).toBeGreaterThanOrEqual(sample.sequence);
        samples.push(sample);
      };
      const loop = new TurnLoop(db, lease, { commitMetricSink: sink });
      await drain(loop);
      expect(samples.map(({ tick, kind }) => [tick, kind])).toEqual([
        [100, 'turn'],
        [500, 'turn'],
        [10_000, 'monthly'],
        [10_000, 'turn'],
      ]);
      expect(new Set(samples.map((sample) => sample.sequence)).size).toBe(samples.length);
      const turns = await query(() =>
        db.generalLog.findMany({ where: { worldId, sequence: { not: null } }, select: { sequence: true, tick: true } }),
      );
      const months = await query(() =>
        db.yearbookSnapshot.findMany({ where: { worldId }, select: { sequence: true, tick: true } }),
      );
      const witnesses = [
        ...turns.map((row) => ({ ...row, kind: 'turn' })),
        ...months.map((row) => ({ ...row, kind: 'monthly' })),
      ].sort((a, b) => a.sequence! - b.sequence!);
      expect(witnesses).toEqual(
        samples.map(({ sequence, tick, kind }) => ({ sequence, tick, kind })).sort((a, b) => a.sequence - b.sequence),
      );
      for (const sample of samples) {
        expect(sample.valid).toBe(true);
        expect(sample.sampleKind).toBe('post-commit-upper-bound');
        expect(sample.commitObservedAt).toBeGreaterThanOrEqual(sample.dueAt!);
        expect(sample.lagMs).toBe(sample.commitObservedAt! - sample.dueAt!);
      }
      const count = samples.length;
      await drain(new TurnLoop(db, lease, { commitMetricSink: sink }));
      expect(samples).toHaveLength(count);
    }),
  );

  it(
    '측정 ON/OFF의 게임 상태·월간 재생 해시는 같다',
    checkedCase(async () => {
      const off = await fixture();
      const on = await fixture();
      const samples: CommitMetric[] = [];
      await drain(new TurnLoop(db, off.lease));
      await drain(new TurnLoop(db, on.lease, { commitMetricSink: async (sample) => void samples.push(sample) }));
      expect(samples).toHaveLength(4);
      expect(hashState(await query(() => readWorldState(db, off.worldId)))).toBe(
        hashState(await query(() => readWorldState(db, on.worldId))),
      );
      expect(replayArchive(await query(() => exportReplay(db, off.worldId)), 1)).toEqual(
        replayArchive(await query(() => exportReplay(db, on.worldId)), 1),
      );
    }),
  );

  it(
    'rollback은 표본을 만들지 않고 같은 작업의 재시도 commit만 기록한다',
    checkedCase(async () => {
      const { worldId, lease } = await fixture();
      const before = hashState(await query(() => readWorldState(db, worldId)));
      const samples: CommitMetric[] = [];
      const sink: CommitMetricSink = async (sample) => void samples.push(sample);
      const failing = new TurnLoop(db, lease, {
        commitMetricSink: sink,
        beforeCommit: async () => {
          throw new Error('metric-contract-rollback');
        },
      });
      await expect(query(() => failing.poll(activeSignal.getStore()))).rejects.toThrow('metric-contract-rollback');
      expect(samples).toEqual([]);
      expect(hashState(await query(() => readWorldState(db, worldId)))).toBe(before);
      await drain(new TurnLoop(db, lease, { commitMetricSink: sink }));
      expect(samples).toHaveLength(4);
      expect(samples.every((sample) => sample.valid)).toBe(true);
    }),
  );

  it(
    '명시적 가속 진행을 실제 시계 지연의 성공 표본으로 세지 않는다',
    checkedCase(async () => {
      const { lease } = await fixture();
      const samples: CommitMetric[] = [];
      await query(() =>
        new TurnLoop(db, lease, { commitMetricSink: async (sample) => void samples.push(sample) }).advanceTo(
          500,
          activeSignal.getStore(),
        ),
      );
      expect(samples).toHaveLength(2);
      expect(samples.every((sample) => !sample.valid && sample.invalidReason === 'clock')).toBe(true);
    }),
  );
});
