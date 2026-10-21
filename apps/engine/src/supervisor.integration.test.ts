import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { TICKS_PER_MONTH } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { acquireLease, LeaseLostError, releaseLease } from './lease';
import { HEARTBEAT_MS, writeHeartbeat } from './main';
import { exportReplay, replayArchive } from './replay';
import { CRASH_MESSAGE, type SupervisorEvent } from './supervisor';
import { controlClock } from './world/clock';
import { saveInitialWorld } from './world/persistence';
import { loadInitialWorld } from './world/resources';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const owned: string[] = [];
const supervisors: { child: ChildProcess; events: SupervisorEvent[]; output: string[] }[] = [];

async function until(check: () => Promise<boolean> | boolean, timeout = 25_000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('감독 통합 시험 대기 시간이 지났습니다.');
    await delay(50);
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

afterEach(async () => {
  await Promise.all(supervisors.map(({ child }) => stop(child)));
  for (const supervisor of supervisors) {
    expect(supervisor.child.exitCode).toBe(0);
    for (const event of supervisor.events) {
      if (event.kind === 'started') expect(alive(event.pid!)).toBe(false);
    }
  }
  supervisors.length = 0;
  await db.world.deleteMany({ where: { id: { in: owned.splice(0) } } });
});
afterAll(() => db.$disconnect());

async function create(second = false) {
  const initial = await loadInitialWorld({
    scenario: '1030',
    map: 'che',
    seed: second ? 'supervisor-b' : 'supervisor-a',
  });
  // 저장소에는 1030만 있으므로 B는 시작 연도·등장 시기가 다른 별도 시나리오 fixture다.
  if (second) {
    initial.scenarioKey = 'supervisor-later';
    initial.startYear += 10;
    for (const general of initial.generals) general.activeFromYear += 10;
  }
  // 실제 월간 정산과 NPC 규칙은 유지하고 자식 장애 시험의 실행량만 줄인다.
  initial.generals = initial.generals.slice(0, 2);
  const result = await saveInitialWorld(db, initial, {
    name: second ? '감독 B' : '감독 A',
    turnTermMinutes: second ? 60 : 10,
  });
  owned.push(result.worldId);
  await db.world.update({
    where: { id: result.worldId },
    data: { status: 'RUNNING', clockAnchorAt: new Date('2099-01-01T00:00:00Z') },
  });
  return result.worldId;
}

function supervisor() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/supervisorWorker.ts'], {
    cwd: new URL('../../../', import.meta.url),
    env: { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events: SupervisorEvent[] = [];
  const output: string[] = [];
  child.on('message', (event: SupervisorEvent) => events.push(event));
  child.stdout!.on('data', (data: Buffer) => output.push(data.toString()));
  child.stderr!.on('data', (data: Buffer) => output.push(data.toString()));
  const result = { child, events, output };
  supervisors.push(result);
  return result;
}

async function ready(worldId: string) {
  await until(async () => (await db.engineHeartbeat.count({ where: { worldId } })) === 1);
}

async function advance(worldId: string, months: number) {
  // 격리 DB의 시계 체크포인트만 수동 주입한다. 턴·정산은 운영 runEngine 자식이 처리한다.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    await tx.world.update({
      where: { id: worldId },
      data: { clockTick: months * TICKS_PER_MONTH, clockRevision: { increment: 1 } },
    });
  });
  await until(
    async () => (await db.world.findUniqueOrThrow({ where: { id: worldId } })).monthlyTick === months * TICKS_PER_MONTH,
  );
}

function starts(events: SupervisorEvent[], worldId: string) {
  return events.filter((event) => event.kind === 'started' && event.worldId === worldId);
}

describe('AC-M2-01 실제 PostgreSQL·감독·자식 프로세스', () => {
  it('다른 시나리오·간격의 두 월드를 3개월 진행하고 B kill·재개, A 정지, 30초 관측을 검증한다', async () => {
    const a = await create();
    const b = await create(true);
    const managed = supervisor();
    await Promise.all([ready(a), ready(b)]);
    const heartbeat = await db.engineHeartbeat.findUniqueOrThrow({ where: { worldId: a } });
    await advance(a, 3);
    expect((await db.world.findUniqueOrThrow({ where: { id: b } })).monthlyTick).toBe(0);
    await advance(b, 3);
    expect(replayArchive(await exportReplay(db, a), 3)).toHaveLength(3);
    expect(replayArchive(await exportReplay(db, b), 3)).toHaveLength(3);
    const lease = await db.engineLease.findUniqueOrThrow({ where: { worldId: b } });
    const killedAt = performance.now();
    process.kill(starts(managed.events, b)[0]!.pid!, 'SIGKILL');
    await until(() => managed.events.some((event) => event.kind === 'retry' && event.worldId === b));
    expect(managed.events.find((event) => event.kind === 'retry' && event.worldId === b)?.delayMs).toBe(1000);
    await advance(a, 4);
    await until(() => starts(managed.events, b).length === 2);
    expect(performance.now() - killedAt).toBeGreaterThanOrEqual(1000);
    await until(
      async () => (await db.engineLease.findUniqueOrThrow({ where: { worldId: b } })).fencingToken > lease.fencingToken,
    );
    await advance(b, 4);
    await controlClock(db, a, 'pause');
    const frozen = await db.world.findUniqueOrThrow({ where: { id: a } });
    await advance(b, 5);
    await until(
      async () => (await db.engineHeartbeat.findUniqueOrThrow({ where: { worldId: a } })).at > heartbeat.at,
      HEARTBEAT_MS + 10_000,
    );
    const observed = await db.engineHeartbeat.findUniqueOrThrow({ where: { worldId: a } });
    expect(observed.lastTick).toBe(frozen.clockTick);
    expect(observed.lagMs).toBeGreaterThanOrEqual(0);
    expect(observed.at.getTime() - heartbeat.at.getTime()).toBeGreaterThanOrEqual(HEARTBEAT_MS - 100);
    expect((await db.world.findUniqueOrThrow({ where: { id: a } })).clockTick).toBe(frozen.clockTick);
    expect(starts(managed.events, a)).toHaveLength(1);
    expect(replayArchive(await exportReplay(db, b), 5)).toHaveLength(5);
    console.log('T2-01: A/B manual3, B SIGKILL/backoff/reacquire, A PAUSED/B5, heartbeat30s, replay PASS');
  }, 90_000);

  it('실제 자식을 5회 죽이면 중단·안전 오류를 기록하고 A는 계속 진행한다', async () => {
    const a = await create();
    const b = await create(true);
    const managed = supervisor();
    await ready(a);
    for (let i = 0; i < 5; i++) {
      await until(() => starts(managed.events, b).length === i + 1);
      process.kill(starts(managed.events, b)[i]!.pid!, 'SIGKILL');
    }
    await until(
      async () => (await db.engineHeartbeat.findUnique({ where: { worldId: b } }))?.lastError === CRASH_MESSAGE,
    );
    expect(
      managed.events.filter((event) => event.kind === 'retry' && event.worldId === b).map((event) => event.delayMs),
    ).toEqual([1000, 2000, 4000, 8000]);
    await advance(a, 1);
    await delay(1500);
    expect(starts(managed.events, b)).toHaveLength(5);
    expect(managed.events.filter((event) => event.kind === 'halted' && event.worldId === b)).toHaveLength(1);
    await stop(managed.child, 'SIGINT');
    console.log('T2-01: five real crashes, halt/error, A progress, SIGINT cleanup PASS');
  }, 60_000);

  it('종료·삭제 월드를 10초 발견 주기에서 내리고 SIGTERM으로 자기 자식만 정리한다', async () => {
    const a = await create();
    const b = await create(true);
    const managed = supervisor();
    await Promise.all([ready(a), ready(b)]);
    await db.world.update({ where: { id: a }, data: { status: 'ENDED' } });
    await db.world.delete({ where: { id: b } });
    await until(() => managed.events.filter((event) => event.kind === 'removed').length === 2);
    expect(await db.engineHeartbeat.findUnique({ where: { worldId: b } })).toBeNull();
    for (const event of managed.events.filter((event) => event.kind === 'started'))
      expect(alive(event.pid!)).toBe(false);
    await stop(managed.child);
    console.log('T2-01: ENDED/deleted removal, cascading heartbeat, SIGTERM cleanup PASS');
  });

  it('감독 둘의 중복 자식도 한 리스만 쓰고 소유 감독 종료 뒤 낡은 토큰을 거부한다', async () => {
    const a = await create();
    const first = supervisor();
    await ready(a);
    const lease = await db.engineLease.findUniqueOrThrow({ where: { worldId: a } });
    const second = supervisor();
    await until(() => starts(second.events, a).length === 1);
    await delay(1000);
    expect((await db.engineLease.findUniqueOrThrow({ where: { worldId: a } })).fencingToken).toBe(lease.fencingToken);
    await advance(a, 3);
    expect(replayArchive(await exportReplay(db, a), 3)).toHaveLength(3);
    await stop(first.child);
    expect(alive(starts(second.events, a)[0]!.pid!)).toBe(true);
    await until(
      async () => (await db.engineLease.findUniqueOrThrow({ where: { worldId: a } })).fencingToken > lease.fencingToken,
    );
    await expect(writeHeartbeat(db, { ...lease, ttlMs: 15_000 }, 0)).rejects.toBeInstanceOf(LeaseLostError);
    await advance(a, 4);
    expect(replayArchive(await exportReplay(db, a), 4)).toHaveLength(4);
    console.log('T2-01: duplicate supervisors, one writer, independent shutdown, stale token rejection PASS');
  });

  it('한 월드의 실제 heartbeat DB 오류가 A의 진행을 막거나 오류 원문을 노출하지 않는다', async () => {
    const a = await create();
    const b = await create(true);
    // 자기 fixture 한 행에만 적용하는 임시 DB 제약이다. 다른 월드·스키마에는 영향을 주지 않는다.
    await db.engineHeartbeat.create({ data: { worldId: b, at: new Date(), lastTick: 0, lagMs: 0 } });
    await db.$executeRawUnsafe(
      `CREATE FUNCTION supervisor_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."worldId" = '${b}' THEN RAISE EXCEPTION 'private-database-error-marker'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER supervisor_test_failure BEFORE UPDATE ON "EngineHeartbeat" FOR EACH ROW EXECUTE FUNCTION supervisor_test_failure()',
    );
    const managed = supervisor();
    try {
      await ready(a);
      await until(() => managed.events.some((event) => event.worldId === b && event.kind === 'retry'));
      await advance(a, 2);
      expect(managed.output.join('')).not.toContain('private-database-error-marker');
      expect(replayArchive(await exportReplay(db, a), 2)).toHaveLength(2);
    } finally {
      await stop(managed.child);
      await db.$executeRawUnsafe('DROP TRIGGER supervisor_test_failure ON "EngineHeartbeat"');
      await db.$executeRawUnsafe('DROP FUNCTION supervisor_test_failure()');
    }
    console.log('T2-01: world-scoped real DB error, A progress, safe logs PASS');
  });

  it('heartbeat만 갱신해도 재생 기록·해시는 같고 DB는 음수 lag와 없는 월드를 거부한다', async () => {
    const a = await create();
    const lease = await acquireLease(db, a);
    expect(lease).not.toBeNull();
    const before = hashState(await exportReplay(db, a));
    await writeHeartbeat(db, lease!, 17.9);
    expect((await db.engineHeartbeat.findUniqueOrThrow({ where: { worldId: a } })).lagMs).toBe(17);
    expect(hashState(await exportReplay(db, a))).toBe(before);
    await expect(db.engineHeartbeat.update({ where: { worldId: a }, data: { lagMs: -1 } })).rejects.toThrow();
    await expect(
      db.engineHeartbeat.create({ data: { worldId: 'nonexistent-test-world', at: new Date(), lastTick: 0, lagMs: 0 } }),
    ).rejects.toThrow();
    await releaseLease(db, lease!);
  });
});
