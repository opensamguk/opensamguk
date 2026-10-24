import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@opensamguk/db';
import { applyEffects, runCommand, TICKS_PER_MONTH, type WorldInit } from '@opensamguk/rules';
import { rngFor } from '@opensamguk/shared';
import { acquireLease, LeaseLostError, releaseLease, renewLease } from './lease';
import { CLOCK_CHECKPOINT_MS, TurnLoop } from './turnLoop';
import * as worldLoader from './worldLoader';
import { loadInitialWorld } from './world/resources';
import { readWorldState, saveInitialWorld } from './world/persistence';
import { controlClock } from './world/clock';
import { runEngine } from './main';
import { requestShutdown } from './process-lifecycle';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let template: WorldInit;
beforeAll(async () => {
  await db.world.deleteMany();
  template = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'engine-test' });
});
afterAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany({ where: { id: 'turn-rest-human' } });
  await db.$disconnect();
});

async function create(count = 1, human = false) {
  const initial = structuredClone(template);
  const city = initial.cities.find((city) => city.nationId !== null)!;
  city.agriculture = 100;
  city.agricultureMax = 10_000;
  city.trust = 100;
  city.supplied = true;
  initial.generals = initial.generals.slice(0, count).map((general, i) => ({
    ...general,
    id: i + 1,
    cityKey: city.cityKey,
    nationId: city.nationId,
    nextTurnTick: 500,
    gold: 1000,
    injury: 3,
  }));
  if (human) {
    const userId = 'turn-rest-human';
    await db.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'test-only' },
    });
    initial.generals[0]!.userId = userId;
  }
  const { worldId } = await saveInitialWorld(db, initial, {
    replayFormat: 'legacy',
    name: '엔진 통합',
    turnTermMinutes: 10,
    endYear: null,
  });
  await controlClock(db, worldId, 'start');
  return { worldId, cityKey: city.cityKey };
}
async function queue(worldId: string, generalId = 1, commandKey = 'farm') {
  await db.generalTurn.createMany({
    data: [
      { worldId, generalId, slot: 0, explicit: true, commandKey, args: {} },
      { worldId, generalId, slot: 1, explicit: true, commandKey: 'rest', args: {} },
    ],
  });
}
async function engine(worldId: string) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('테스트 리스 획득 실패');
  return new TurnLoop(db, lease);
}
async function expire(worldId: string) {
  await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE "worldId" = ${worldId}`;
}
async function general(worldId: string) {
  return db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
}
function worker(worldId: string, phase: string) {
  return spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/turnWorker.ts', worldId, phase], {
    cwd: new URL('../../../', import.meta.url),
    env: { ...process.env, TEST_DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}
async function message(child: ChildProcess, expected?: string) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker가 ${expected}에 도달하지 못했습니다.`));
    }, 30_000);
    const onMessage = (value: unknown) => {
      cleanup();
      if (typeof value === 'string' && (expected === undefined || value === expected)) resolve(value);
      else reject(new Error(`worker: ${String(value)}`));
    };
    const onExit = () => {
      cleanup();
      reject(new Error('worker가 준비 전에 종료됐습니다.'));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }
    child.once('message', onMessage);
    child.once('exit', onExit);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

describe('AC-M1-10 턴 실행, 실제 PostgreSQL', () => {
  it('시계 주입: 턴 시각에 농업·금·로그·30칸 당김·revision을 함께 저장한다', async () => {
    const { worldId, cityKey } = await create(1, true);
    await queue(worldId);
    const loop = await engine(worldId);
    expect(await loop.advanceTo(499)).toEqual([]);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
    expect(await loop.advanceTo(500)).toEqual([{ generalId: 1, tick: 500, commandKey: 'farm' }]);
    expect(
      (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey } } })).agriculture,
    ).toBeGreaterThan(100);
    expect(await general(worldId)).toMatchObject({ gold: 900, turnRevision: 1, nextTurnTick: 10_500 });
    const logs = await db.generalLog.findMany({ where: { worldId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ tick: 500, commandKey: 'farm', kind: 'success' });
    const turns = await db.generalTurn.findMany({ where: { worldId }, orderBy: { slot: 'asc' } });
    expect(turns).toHaveLength(30);
    expect(turns.every((turn, slot) => turn.slot === slot && turn.commandKey === 'rest')).toBe(true);
    expect(await loop.advanceTo(10_000)).toEqual([]);
    expect(await loop.advanceTo(10_500)).toHaveLength(1);
    expect(await general(worldId)).toMatchObject({ injury: 2, turnRevision: 2 });
    // 1월 세입·봉급은 10,000 tick에서 별도로 반영된다.
    expect((await general(worldId)).gold).toBeGreaterThan(900);
  });

  it('밀린 턴은 tick 우선, 같은 tick은 장수 ID 순서로 처리한다', async () => {
    const { worldId } = await create(3);
    await db.general.update({ where: { worldId_id: { worldId, id: 3 } }, data: { nextTurnTick: 100 } });
    const loop = await engine(worldId);
    const executions = await loop.advanceTo(10_500);
    expect(executions.map(({ generalId, tick }) => [generalId, tick])).toEqual([
      [3, 100],
      [1, 500],
      [2, 500],
      [3, 10_100],
      [1, 10_500],
      [2, 10_500],
    ]);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(6);
  });

  it('실행 시 재검사 실패는 실패 로그를 남기고 턴과 예턴을 진행한다', async () => {
    const { worldId, cityKey } = await create();
    await queue(worldId);
    await db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { gold: 0 } });
    const loop = await engine(worldId);
    await loop.advanceTo(500);
    expect(await general(worldId)).toMatchObject({ gold: 0, nextTurnTick: 10_500, turnRevision: 1 });
    expect((await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey } } })).agriculture).toBe(
      100,
    );
    expect(await db.generalLog.findFirst({ where: { worldId } })).toMatchObject({
      kind: 'failure',
      text: expect.stringContaining('NO_GOLD'),
    });
  });

  it.each(['missing-command', 'bad-args'])('잘못 저장된 명령 %s도 상태 변경 없이 실패로 소비한다', async (kind) => {
    const { worldId } = await create();
    await queue(worldId, 1, kind === 'missing-command' ? 'unknown' : 'farm');
    if (kind === 'bad-args')
      await db.generalTurn.update({
        where: { worldId_generalId_slot: { worldId, generalId: 1, slot: 0 } },
        data: { args: { unexpected: 1 } },
      });
    await (await engine(worldId)).advanceTo(500);
    expect(await general(worldId)).toMatchObject({ gold: 1000, nextTurnTick: 10_500 });
    expect(await db.generalLog.findFirst({ where: { worldId } })).toMatchObject({
      kind: 'failure',
      text: expect.stringContaining(kind === 'missing-command' ? 'UNKNOWN_COMMAND' : 'BAD_ARGS'),
    });
  });

  it('일시정지 동안 예턴·로그·다음 턴을 바꾸지 않고 재개 후 따라잡는다', async () => {
    const { worldId } = await create();
    const loop = await engine(worldId);
    await controlClock(db, worldId, 'pause');
    expect(await loop.advanceTo(500)).toEqual([]);
    expect(await general(worldId)).toMatchObject({ nextTurnTick: 500, turnRevision: 0 });
    await controlClock(db, worldId, 'resume');
    expect(await loop.advanceTo(500)).toHaveLength(1);
  });

  it('realtime 시계가 역행해도 이전에 관측·저장한 tick보다 줄지 않는다', async () => {
    const { worldId } = await create();
    await db.general.updateMany({ where: { worldId }, data: { nextTurnTick: 100_000 } });
    await db.world.update({ where: { id: worldId }, data: { clockAnchorAt: new Date(Date.now() - 300_000) } });
    let elapsed = 0;
    const loop = new TurnLoop(db, (await acquireLease(db, worldId))!, { elapsedNow: () => elapsed });
    await loop.poll();
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick).toBe(0);
    // DB 벽시계 대신 기준 시각을 미래로 보내 역행을 재현한다.
    await db.world.update({ where: { id: worldId }, data: { clockAnchorAt: new Date(Date.now() + 600_000) } });
    elapsed = CLOCK_CHECKPOINT_MS;
    await loop.poll();
    const first = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick;
    expect(first).toBeGreaterThanOrEqual(5_000);
    elapsed += CLOCK_CHECKPOINT_MS;
    await loop.poll();
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick).toBe(first);
    await expect(loop.advanceTo(first - 1)).rejects.toThrow('뒤로');
  });

  it('턴이 없는 폴링은 전체 월드 적재를 생략하고 시계는 5초마다만 저장한다', async () => {
    const { worldId } = await create();
    await db.general.updateMany({ where: { worldId }, data: { nextTurnTick: 100_000 } });
    let elapsed = 0;
    const loop = new TurnLoop(db, (await acquireLease(db, worldId))!, { elapsedNow: () => elapsed });
    const load = vi.spyOn(worldLoader, 'loadWorld');
    try {
      const before = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      for (let i = 0; i < 5; i++) await loop.poll();
      elapsed = CLOCK_CHECKPOINT_MS - 1;
      await loop.poll();
      expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(before);
      elapsed++;
      await loop.poll();
      const saved = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      expect(saved.clockRevision).toBe(before.clockRevision + 1);
      await loop.poll();
      expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockRevision).toBe(saved.clockRevision);
      await controlClock(db, worldId, 'pause');
      const paused = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      elapsed += CLOCK_CHECKPOINT_MS;
      for (let i = 0; i < 3; i++) await loop.poll();
      expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(paused);
      expect(load).not.toHaveBeenCalled();
      expect(loop.state).toBeNull();
    } finally {
      load.mockRestore();
    }
  });

  it('운영 명령은 진행 중인 시계 쓰기를 기다린 뒤 최신 revision으로 저장한다', async () => {
    const { worldId } = await create();
    let locked!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.world.update({ where: { id: worldId }, data: { clockRevision: { increment: 1 } } });
      locked(backend!.pid);
      await gate;
    });
    const pid = await ready;
    const pause = controlClock(db, worldId, 'pause');
    // 잠금 대기를 실제 PostgreSQL에서 확인한 다음 쓰기를 commit한다.
    try {
      await vi.waitFor(
        async () => {
          const [row] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
        ) AS waiting`;
          expect(row!.waiting).toBe(true);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      release();
      await writer;
    }
    expect((await pause).status).toBe('PAUSED');
  });

  it('realtime 엔진 실행 중 pause/resume 80회가 모두 성공하고 정지 중 턴을 실행하지 않는다', async () => {
    const { worldId } = await create();
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = runEngine(db, {
      worldId,
      signal: abort.signal,
      onStatus: (status) => {
        if (status === '실행권 획득') started();
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await ready;
      for (let i = 0; i < 40; i++) {
        const paused = await controlClock(db, worldId, 'pause');
        expect(paused.status).toBe('PAUSED');
        if (i === 0) {
          await db.general.updateMany({ where: { worldId }, data: { nextTurnTick: 0 } });
          const logs = await db.generalLog.count({ where: { worldId } });
          await delay(300);
          expect(await db.generalLog.count({ where: { worldId } })).toBe(logs);
          expect((await general(worldId)).nextTurnTick).toBe(0);
          expect((await controlClock(db, worldId, 'status')).tick).toBe(paused.tick);
        }
        expect((await controlClock(db, worldId, 'resume')).status).toBe('RUNNING');
        await delay(5);
      }
    } finally {
      abort.abort();
      expect(await running).toBeNull();
    }
  });
});

describe('AC-M1-11 리스·재시작·펜싱, 실제 PostgreSQL', () => {
  it('엔진 둘의 동시 획득은 하나만 성공하고, 해제 후 토큰이 증가한다', async () => {
    const { worldId } = await create();
    const leases = await Promise.all([acquireLease(db, worldId), acquireLease(db, worldId)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const lease = leases.find((lease) => lease !== null)!;
    await renewLease(db, lease);
    await releaseLease(db, lease);
    const next = (await acquireLease(db, worldId))!;
    expect(next.fencingToken).toBe(lease.fencingToken + 1);
    await expect(new TurnLoop(db, lease).advanceTo(500)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(renewLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
    await releaseLease(db, lease);
    expect(await acquireLease(db, worldId)).toBeNull();
    expect(await new TurnLoop(db, next).advanceTo(500)).toHaveLength(1);
  });

  it('리스 만료 후 새 엔진만 commit하고 이전 엔진의 갱신·commit을 거부한다', async () => {
    const { worldId } = await create();
    const old = await engine(worldId);
    await expire(worldId);
    await expect(renewLease(db, old.lease)).rejects.toBeInstanceOf(LeaseLostError);
    const next = await engine(worldId);
    expect(next.lease.fencingToken).toBe(old.lease.fencingToken + 1);
    await expect(old.advanceTo(500)).rejects.toBeInstanceOf(LeaseLostError);
    await next.advanceTo(500);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(1);
  });

  it('commit 직전 오류는 엔티티·로그·예턴·시계·메모리 사본을 모두 롤백한다', async () => {
    const { worldId } = await create();
    await queue(worldId);
    const loop = new TurnLoop(db, (await acquireLease(db, worldId))!, {
      beforeCommit: async () => {
        throw new Error('중단');
      },
    });
    const before = await readWorldState(db, worldId);
    const clock = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    await expect(loop.advanceTo(500)).rejects.toThrow('중단');
    expect(loop.state).toBeNull();
    expect(await readWorldState(db, worldId)).toEqual(before);
    expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(clock);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
    expect(await db.generalTurn.count({ where: { worldId } })).toBe(2);
    expect((await general(worldId)).turnRevision).toBe(0);
    await releaseLease(db, loop.lease);
    expect(await (await engine(worldId)).advanceTo(500)).toHaveLength(1);
  });

  it('commit 직전 토큰이 바뀌면 최종 검사에서 모든 저장을 롤백한다', async () => {
    const { worldId } = await create();
    const loop = new TurnLoop(db, (await acquireLease(db, worldId))!, {
      beforeCommit: async (tx) => {
        await tx.engineLease.update({ where: { worldId }, data: { fencingToken: { increment: 1 } } });
      },
    });
    await expect(loop.advanceTo(500)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await general(worldId)).toMatchObject({ nextTurnTick: 500, turnRevision: 0 });
    expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
  });

  it('저장 도중 리스가 만료되면 같은 토큰이어도 commit을 롤백한다', async () => {
    const { worldId } = await create();
    const loop = new TurnLoop(db, (await acquireLease(db, worldId))!, {
      beforeCommit: async (tx) => {
        await tx.engineLease.update({ where: { worldId }, data: { expiresAt: new Date(0) } });
      },
    });
    await expect(loop.advanceTo(500)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
  });

  it('종료 신호가 처리 중 들어오면 현재 트랜잭션을 취소한다', async () => {
    const { worldId } = await create();
    const abort = new AbortController();
    const loop = new TurnLoop(db, (await acquireLease(db, worldId))!, {
      beforeCommit: async () => {
        abort.abort();
      },
    });
    await expect(loop.advanceTo(500, abort.signal)).rejects.toThrow();
    expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
    expect(await general(worldId)).toMatchObject({ nextTurnTick: 500, turnRevision: 0 });
    expect(loop.state).toBeNull();
  });

  it.each(['beforeCommit', 'committed'])(
    '실제 SIGKILL (%s) 후 재시작하면 같은 RNG 결과로 턴이 정확히 한 번 반영된다',
    async (phase) => {
      const { worldId } = await create();
      await queue(worldId);
      const initial = await readWorldState(db, worldId);
      const state = {
        startYear: initial.startYear,
        cities: Object.fromEntries(initial.cities.map((c) => [c.cityKey, c])),
        nations: Object.fromEntries(initial.nations.map((n) => [n.id, n])),
        generals: Object.fromEntries(initial.generals.map((g) => [g.id, g])),
        diplomacies: initial.diplomacies,
      };
      const expected = runCommand(state, { generalId: 1 }, 'farm', {}, rngFor(initial.seed, 'turn', 500, 1));
      if ('code' in expected) throw new Error('검증 명령 실패');
      const next = applyEffects(state, expected.effects);
      const child = worker(worldId, phase);
      try {
        await message(child, phase);
        await kill(child);
        expect(await db.generalLog.count({ where: { worldId } })).toBe(phase === 'committed' ? 1 : 0);
        await expire(worldId);
        const restarted = await engine(worldId);
        await restarted.advanceTo(500);
        await restarted.advanceTo(TICKS_PER_MONTH - 1);
        expect(await general(worldId)).toMatchObject({
          gold: next.generals[1]!.gold,
          experience: next.generals[1]!.experience,
          nextTurnTick: 10_500,
          turnRevision: 1,
        });
        expect(await db.generalLog.count({ where: { worldId } })).toBe(1);
        expect(await db.generalTurn.count({ where: { worldId } })).toBe(30);
        expect(await db.generalLog.findFirst({ where: { worldId } })).toMatchObject({ text: expected.logs[0]!.text });
      } finally {
        await kill(child);
      }
    },
    60_000,
  );

  it('실제 프로세스 둘을 띄우면 한 쪽만 턴을 저장한다', async () => {
    const { worldId } = await create();
    const a = worker(worldId, 'committed');
    const readyA = message(a);
    const b = worker(worldId, 'committed');
    const readyB = message(b);
    try {
      const outcomes = await Promise.all([readyA, readyB]);
      expect(outcomes.sort()).toEqual(['committed', 'waiting']);
      expect(await db.generalLog.count({ where: { worldId } })).toBe(1);
    } finally {
      await Promise.all([kill(a), kill(b)]);
    }
  }, 60_000);

  it('런타임이 RUNNING 월드를 자동 선택하고 종료 때 리스를 해제한다', async () => {
    await db.world.updateMany({ data: { status: 'PAUSED' } });
    const { worldId } = await create();
    const abort = new AbortController();
    let acquired = false;
    const running = runEngine(db, {
      signal: abort.signal,
      onStatus: (status) => {
        if (status === '실행권 획득') {
          acquired = true;
          abort.abort();
        }
      },
    });
    await running;
    expect(acquired).toBe(true);
    const lease = await acquireLease(db, worldId);
    expect(lease).not.toBeNull();
  });

  it('명시적 월드 CLI가 실행권을 잡고 SIGTERM으로 정상 종료·해제한다', async () => {
    const { worldId } = await create();
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/src/index.ts', '--world', worldId], {
      cwd: new URL('../../../', import.meta.url),
      env: { ...process.env, DATABASE_URL: url },
      stdio: process.platform === 'win32' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('CLI 시작 시간 초과'));
        }, 30_000);
        const onData = (data: Buffer) => {
          if (data.toString().includes('실행권 획득')) {
            cleanup();
            resolve();
          }
        };
        const onExit = () => {
          cleanup();
          reject(new Error('CLI가 시작 전에 종료됐습니다.'));
        };
        function cleanup() {
          clearTimeout(timer);
          child.stdout!.off('data', onData);
          child.off('exit', onExit);
        }
        child.stdout!.on('data', onData);
        child.once('exit', onExit);
      });
      requestShutdown(child, 'SIGTERM');
      expect((await exited)[0]).toBe(0);
      expect(await acquireLease(db, worldId)).not.toBeNull();
    } finally {
      await kill(child);
    }
  }, 60_000);
});
