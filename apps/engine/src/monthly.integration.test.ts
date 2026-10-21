import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextActionSequence, type Prisma } from '@opensamguk/db';
import { emptyTurns, type WorldInit } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../test/monthlyFixture';
import { TurnLoop } from './turnLoop';
import { acquireLease, LeaseLostError, releaseLease, renewLease } from './lease';
import { controlClock } from './world/clock';
import { saveInitialWorld, readWorldState } from './world/persistence';
import { exportReplay, replayArchive } from './replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let template: WorldInit;
beforeAll(async () => {
  template = await monthlyFixture();
});
afterAll(async () => {
  await db.world.deleteMany();
  await db.$disconnect();
});
async function create() {
  const { worldId } = await saveInitialWorld(db, template, { name: '월간 통합', turnTermMinutes: 60 });
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  return { worldId, lease, loop: new TurnLoop(db, lease) };
}
async function setTurns(worldId: string, commandKey: string, idempotencyKey: string) {
  return db.$transaction(async (tx) => {
    const sequence = await nextActionSequence(tx, worldId);
    const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const turns = emptyTurns();
    turns[0] = { commandKey, args: {} };
    await tx.generalTurn.deleteMany({ where: { worldId, generalId: 1 } });
    await tx.generalTurn.createMany({
      data: turns.map((turn, slot) => ({
        ...turn,
        args: turn.args as Prisma.InputJsonValue,
        slot,
        worldId,
        generalId: 1,
      })),
    });
    await tx.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { turnRevision: { increment: 1 } } });
    return tx.inputEvent.create({
      data: {
        worldId,
        userId: 'test-actor',
        generalId: 1,
        kind: 'turns.set',
        idempotencyKey,
        payload: { revision: actor.turnRevision, turns } as unknown as Prisma.InputJsonValue,
        status: 'APPLIED',
        sequence,
        result: { revision: actor.turnRevision + 1 },
      },
    });
  });
}

describe('AC-M1-12 실제 PostgreSQL 월 경계', () => {
  it('앞선 턴 → 정산 → 같은 tick 턴, 국가 기록·소유권·해시를 한 번만 저장한다', async () => {
    const { worldId, loop } = await create();
    expect(await loop.advanceTo(10000)).toEqual([
      { generalId: 1, tick: 100, commandKey: 'rest' },
      { generalId: 2, tick: 10000, commandKey: 'rest' },
    ]);
    const snapshot = await db.yearbookSnapshot.findFirstOrThrow({ where: { worldId } });
    expect(snapshot).toMatchObject({ tick: 10000, year: 191, month: 1, sequence: 2 });
    expect(await db.nationHistory.count({ where: { worldId } })).toBe(2);
    expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toMatchObject({
      monthlyTick: 10000,
      actionSequence: 3,
    });
    expect(replayArchive(await exportReplay(db, worldId), 1)[0]!.stateHash).toBe(snapshot.stateHash);
    await loop.advanceTo(10000);
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(1);
    expect(await db.generalLog.count({ where: { worldId } })).toBe(2);
  });

  it.each(['error', 'token', 'expiry'])(
    '정산 commit 직전 %s이면 상태·연감·국가 기록·순서·메모리를 모두 롤백한다',
    async (failure) => {
      const { worldId, loop, lease } = await create();
      await loop.advanceTo(9999);
      const before = await readWorldState(db, worldId);
      const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      const failing = new TurnLoop(db, lease, {
        beforeCommit: async (tx) => {
          if (failure === 'error') throw new Error('정산 중단');
          await tx.engineLease.update({
            where: { worldId },
            data: failure === 'token' ? { fencingToken: { increment: 1 } } : { expiresAt: new Date(0) },
          });
        },
      });
      if (failure === 'error') await expect(failing.advanceTo(10000)).rejects.toThrow('정산 중단');
      else await expect(failing.advanceTo(10000)).rejects.toBeInstanceOf(LeaseLostError);
      expect(failing.state).toBeNull();
      expect(await readWorldState(db, worldId)).toEqual(before);
      expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toEqual(world);
      expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(0);
      expect(await db.nationHistory.count({ where: { worldId } })).toBe(0);
      await loop.advanceTo(10000);
      expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(1);
    },
  );

  it('정지 중 정산하지 않고 재시작은 체크포인트와 별도로 밀린 달을 처리한다', async () => {
    const { worldId, loop, lease } = await create();
    await controlClock(db, worldId, 'pause');
    await loop.advanceTo(30000);
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(0);
    await controlClock(db, worldId, 'resume');
    await db.world.update({ where: { id: worldId }, data: { clockTick: 30000 } });
    await releaseLease(db, lease);
    const restarted = new TurnLoop(db, (await acquireLease(db, worldId))!);
    await restarted.advanceTo(30000);
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(3);
    expect(replayArchive(await exportReplay(db, worldId), 3)).toHaveLength(3);
  });

  it.each(['beforeCommit', 'committed'])(
    '실제 SIGKILL %s 후 월 정산은 정확히 한 번 반영된다',
    async (phase) => {
      const { worldId, lease } = await create();
      await releaseLease(db, lease);
      const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/monthlyWorker.ts', worldId, phase], {
        env: { ...process.env, TEST_DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const exited = once(child, 'exit');
      try {
        const received = await Promise.race([
          once(child, 'message').then(([message]) => message),
          exited.then(() => {
            throw new Error('worker가 준비 전에 종료됐습니다.');
          }),
        ]);
        expect(received).toBe(phase);
        child.kill('SIGKILL');
        await exited;
        expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(phase === 'committed' ? 1 : 0);
        await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "worldId" = ${worldId}`;
        const restarted = new TurnLoop(db, (await acquireLease(db, worldId))!);
        await restarted.advanceTo(10000);
        await restarted.advanceTo(10000);
        expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(1);
        expect(await db.nationHistory.count({ where: { worldId } })).toBe(2);
        expect(replayArchive(await exportReplay(db, worldId), 1)).toHaveLength(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
    60000,
  );
});

describe('AC-M1-13 실제 DB 입력과 12개월 재생', () => {
  it('턴 사이 예턴 편집·거부·장수 생성과 12개월 해시, 실제 CLI를 검증한다', async () => {
    const { worldId, loop, lease } = await create();
    await setTurns(worldId, 'farm', 'first');
    await loop.advanceTo(100);
    await setTurns(worldId, 'commerce', 'second');
    await db.$transaction(async (tx) => {
      await tx.inputEvent.create({
        data: {
          worldId,
          userId: 'test-actor',
          kind: 'general.create',
          idempotencyKey: 'rejected',
          payload: {},
          status: 'REJECTED',
          sequence: await nextActionSequence(tx, worldId),
          result: { code: 'INVALID' },
        },
      });
      const general = { ...template.generals[0]!, id: 4, nationId: null, nextTurnTick: 500 };
      await tx.general.create({ data: { ...general, worldId } });
      await tx.inputEvent.create({
        data: {
          worldId,
          userId: 'test-new-actor',
          generalId: 4,
          kind: 'general.create',
          idempotencyKey: 'created',
          payload: {},
          status: 'APPLIED',
          sequence: await nextActionSequence(tx, worldId),
          result: { general },
        },
      });
    });
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo(month * 10000);
      if (month === 4) await setTurns(worldId, 'not-a-command', 'failed-turn');
    }
    const archive = await exportReplay(db, worldId);
    const hashes = replayArchive(archive);
    expect(hashes).toHaveLength(12);
    expect(hashes.map((entry) => entry.stateHash)).toEqual(archive.months.map((entry) => entry.stateHash));
    expect(await db.generalLog.findFirst({ where: { worldId, commandKey: 'not-a-command' } })).toMatchObject({
      kind: 'failure',
    });
    const wrongOrder = structuredClone(archive);
    wrongOrder.inputs.reverse();
    expect(() => replayArchive(wrongOrder)).toThrow('순서');
    const missing = structuredClone(archive);
    missing.inputs.shift();
    expect(() => replayArchive(missing)).toThrow();
    const changed = structuredClone(archive);
    (changed.inputs[0]!.payload as { turns: { commandKey: string }[] }).turns[0]!.commandKey = 'rest';
    expect(() => replayArchive(changed)).toThrow('해시');
    const dir = await mkdtemp(join(tmpdir(), 'opensamguk-monthly-'));
    const path = join(dir, 'replay.json');
    const cli = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay.ts', ...args], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 30000,
      });
    try {
      const exported = cli(['--world', worldId, '--output', path]);
      expect(exported.status, exported.stderr).toBe(0);
      const replayed = cli(['--from', path, '--months', '12']);
      expect(replayed.status, replayed.stderr).toBe(0);
      expect(replayed.stdout.trim().split('\n')).toHaveLength(12);
      expect(cli(['--world', worldId, '--output', path]).status).toBe(1);
      const badPath = join(dir, 'bad.json');
      await writeFile(badPath, JSON.stringify(changed));
      expect(cli(['--from', badPath, '--months', '12']).status).toBe(1);
      expect(cli(['--from', path, '--months', '13']).status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('DB는 중복 멱등 키·sequence와 미완료/완료 결과 불일치를 거부한다', async () => {
    const { worldId } = await create();
    const first = await setTurns(worldId, 'rest', 'same');
    const base = { worldId, userId: first.userId, kind: 'turns.set', idempotencyKey: 'same', payload: {} };
    await expect(db.inputEvent.create({ data: base })).rejects.toThrow();
    await expect(
      db.inputEvent.create({
        data: {
          ...base,
          idempotencyKey: 'duplicate-sequence',
          status: 'APPLIED',
          sequence: first.sequence,
          result: {},
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.inputEvent.create({ data: { ...base, idempotencyKey: 'bad-completion', status: 'APPLIED' } }),
    ).rejects.toThrow();
    await expect(
      db.inputEvent.create({ data: { ...base, idempotencyKey: 'bad-pending', sequence: 99 } }),
    ).rejects.toThrow();
  });

  it('생성 원본이 없는 기존 월드는 추측하지 않고 거부한다', async () => {
    const { worldId } = await create();
    await db.$executeRaw`UPDATE "World" SET "replayOrigin" = NULL WHERE id = ${worldId}`;
    await expect(exportReplay(db, worldId)).rejects.toThrow('생성 기록');
    expect(hashState(await readWorldState(db, worldId))).toBe(hashState(template));
  });
});
