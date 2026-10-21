import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, nextActionSequence, type Prisma } from '@opensamguk/db';
import { emptyTurns, refreshSupply, runGeneralTurn, toWorldState, type WorldInit } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { warFixture } from '../test/warFixture';
import { saveInitialWorld, readWorldState } from './world/persistence';
import { controlClock } from './world/clock';
import { acquireLease, LeaseLostError, releaseLease, renewLease } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
afterAll(async () => {
  await db.world.deleteMany();
  await db.$disconnect();
});
async function create(initial?: WorldInit) {
  initial ??= await warFixture();
  const { worldId } = await saveInitialWorld(db, initial, { name: '전투 통합', turnTermMinutes: 60 });
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  return { initial, worldId, lease, loop: new TurnLoop(db, lease) };
}
async function queue(worldId: string, generalId: number, commandKey: string, args: Prisma.InputJsonValue) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
    const turns = emptyTurns();
    turns[0] = { commandKey, args };
    await tx.generalTurn.deleteMany({ where: { worldId, generalId } });
    await tx.generalTurn.createMany({
      data: turns.map((t, slot) => ({
        worldId,
        generalId,
        slot,
        commandKey: t.commandKey,
        args: t.args as Prisma.InputJsonValue,
      })),
    });
    await tx.general.update({
      where: { worldId_id: { worldId, id: generalId } },
      data: { turnRevision: { increment: 1 } },
    });
    const sequence = await nextActionSequence(tx, worldId);
    await tx.inputEvent.create({
      data: {
        worldId,
        userId: 'war-test-actor',
        generalId,
        kind: 'turns.set',
        idempotencyKey: `turn-${sequence}`,
        status: 'APPLIED',
        sequence,
        payload: { turns, revision: actor.turnRevision } as unknown as Prisma.InputJsonValue,
        result: { revision: actor.turnRevision + 1 },
      },
    });
  });
}
async function snapshot(worldId: string) {
  return {
    state: await readWorldState(db, worldId),
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    logs: await db.generalLog.findMany({ where: { worldId } }),
    battle: await db.battleLog.findMany({ where: { worldId } }),
    history: await db.nationHistory.findMany({ where: { worldId } }),
  };
}

describe('AC-M1-14~16 실제 PostgreSQL 명령·전투', () => {
  it('국가포상·수비2명·성벽·멸망·재야·국가예턴 삭제와 로그를 한 번 저장하고 12개월 재생한다', async () => {
    const { initial, worldId, loop, lease } = await create();
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    const expected = runGeneralTurn(
      toWorldState(initial),
      { generalId: 1, tick: 100, unitSet: initial.unitSet },
      { commandKey: 'attack', args: { cityKey: 2 } },
      initial.seed,
    ).state;
    await loop.advanceTo(100);
    await loop.advanceTo(100);
    const stored = toWorldState(await readWorldState(db, worldId));
    expected.generals[1]!.nextTurnTick = 10100;
    expect(hashState(stored)).toBe(hashState(expected));
    expect(await db.nationTurn.count({ where: { worldId, nationId: 2 } })).toBe(0);
    expect(await db.nationTurn.count({ where: { worldId, nationId: 1 } })).toBe(30);
    expect(await db.battleLog.findMany({ where: { worldId }, orderBy: { generalId: 'asc' } })).toMatchObject([
      { generalId: 2, text: expect.stringContaining('점령') },
      { generalId: 3, text: expect.stringContaining('점령') },
    ]);
    expect(
      await db.nationHistory.findUniqueOrThrow({
        where: { worldId_tick_nationId: { worldId, tick: 100, nationId: 2 } },
      }),
    ).toMatchObject({ data: { events: expect.arrayContaining([expect.stringContaining('멸망')]) } });
    expect(await db.generalLog.count({ where: { worldId } })).toBe(1);
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
      turnRevision: 2,
      nextTurnTick: 10100,
    });
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo(month * 10000);
    }
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive).map((e) => e.stateHash)).toEqual(archive.months.map((m) => m.stateHash));
    expect(archive.months[0]!.data.nations.map((n) => n.nationId)).toEqual([1]);
  });
  it.each(['error', 'token', 'expiry'] as const)(
    '전투 저장 직전 %s이면 소유권·국가·양쪽 로그·예턴·메모리를 모두 롤백한다',
    async (failure) => {
      const { worldId, lease } = await create();
      await queue(worldId, 1, 'attack', { cityKey: 2 });
      const before = await snapshot(worldId);
      const loop = new TurnLoop(db, lease, {
        beforeCommit: async (tx) => {
          if (failure === 'error') throw new Error('전투 중단');
          await tx.engineLease.update({
            where: { worldId },
            data: failure === 'token' ? { fencingToken: { increment: 1 } } : { expiresAt: new Date(0) },
          });
        },
      });
      if (failure === 'error') await expect(loop.advanceTo(100)).rejects.toThrow('전투 중단');
      else await expect(loop.advanceTo(100)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await snapshot(worldId)).toEqual(before);
      expect(loop.state).toBeNull();
      await new TurnLoop(db, lease).advanceTo(100);
      expect(await db.battleLog.count({ where: { worldId } })).toBe(2);
    },
  );
  it.each(['beforeCommit', 'committed'])(
    '실제 SIGKILL %s 후 전투·멸망·국가예턴은 정확히 한 번 반영된다',
    async (phase) => {
      const { worldId, lease } = await create();
      await queue(worldId, 1, 'attack', { cityKey: 2 });
      await releaseLease(db, lease);
      const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/turnWorker.ts', worldId, phase], {
        env: { ...process.env, TEST_DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const exited = once(child, 'exit');
      try {
        const message = await Promise.race([
          once(child, 'message').then(([m]) => m),
          exited.then(() => {
            throw new Error('전투 worker 조기 종료');
          }),
        ]);
        expect(message).toBe(phase);
        child.kill('SIGKILL');
        await exited;
        expect(await db.battleLog.count({ where: { worldId } })).toBe(phase === 'committed' ? 2 : 0);
        await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "worldId" = ${worldId}`;
        const loop = new TurnLoop(db, (await acquireLease(db, worldId))!);
        await loop.advanceTo(500);
        await loop.advanceTo(500);
        expect(await db.battleLog.count({ where: { worldId } })).toBe(2);
        expect(await db.generalLog.count({ where: { worldId } })).toBe(1);
        expect(await db.nation.count({ where: { worldId } })).toBe(1);
        expect(
          await db.nationTurn.findUniqueOrThrow({
            where: { worldId_nationId_slot: { worldId, nationId: 1, slot: 0 } },
          }),
        ).toMatchObject({ commandKey: 'nation_rest' });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
    60000,
  );
  it('건국·등용제안·수락은 DB 재적재 후 유지되고 재생도 일치한다', async () => {
    const initial = await warFixture();
    initial.generals[3]!.nextTurnTick = 50;
    const { worldId, loop, lease } = await create(initial);
    await queue(worldId, 4, 'found', { name: '새나라', color: '#123456' });
    await queue(worldId, 3, 'resign', {});
    await loop.advanceTo(50);
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toMatchObject({
      capitalCityKey: 3,
    });
    await queue(worldId, 4, 'invite', { generalId: 3 });
    await loop.advanceTo(10050);
    expect((await readWorldState(db, worldId)).commandMeta?.offers[3]).toBe(3);
    await queue(worldId, 3, 'accept_invite', {});
    await loop.advanceTo(15000);
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toMatchObject({
      nationId: 3,
      cityKey: 3,
    });
    expect((await readWorldState(db, worldId)).commandMeta?.offers[3]).toBeUndefined();
    for (let month = 2; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo(month * 10000);
    }
    expect(replayArchive(await exportReplay(db, worldId))).toHaveLength(12);
  });
  it('회랑 점령·단절 월간 손해·재점령 회복을 저장하고 2개월 재생한다', async () => {
    const initial = await warFixture();
    for (const id of [1, 2, 3]) initial.cities[id - 1]!.nationId = 1;
    initial.cities[3]!.nationId = 2;
    initial.cities[1]!.connections.push(4);
    initial.cities[3]!.connections.push(2);
    initial.nations[1]!.capitalCityKey = 4;
    initial.generals[0]!.nextTurnTick = 200;
    initial.generals[1]!.nextTurnTick = 100;
    initial.generals[1]!.cityKey = 4;
    initial.generals[1]!.crew = 10000;
    initial.generals[2]!.nationId = 1;
    initial.generals[2]!.cityKey = 3;
    const ready = toWorldState(initial);
    refreshSupply(ready);
    initial.cities = Object.values(ready.cities);
    const { worldId, loop, lease } = await create(initial);
    await queue(worldId, 2, 'attack', { cityKey: 2 });
    await loop.advanceTo(100);
    expect(
      await db.generalLog.findUniqueOrThrow({
        where: { worldId_generalId_tick: { worldId, generalId: 2, tick: 100 } },
      }),
    ).toMatchObject({ kind: 'success' });
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({ supplied: false, agriculture: 100 });
    for (const tick of [200, 5000, 9999]) {
      await loop.advanceTo(tick);
      const state = await readWorldState(db, worldId);
      expect(state.cities[1], `tick ${tick} 회랑 소유권`).toMatchObject({ nationId: 2 });
      expect(state.cities[2], `tick ${tick} 뒤쪽 도시`).toMatchObject({ nationId: 1, supplied: false });
    }
    await loop.advanceTo(10000);
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({ supplied: false, agriculture: 90 });
    await queue(worldId, 2, 'move', { cityKey: 4 });
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await renewLease(db, lease);
    await loop.advanceTo(10200);
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({ supplied: true, agriculture: 90 });
    await loop.advanceTo(20000);
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({ supplied: true, agriculture: 90 });
    expect(replayArchive(await exportReplay(db, worldId), 2)).toHaveLength(2);
  });
});
