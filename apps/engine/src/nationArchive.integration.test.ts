import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, nextActionSequence, type Prisma } from '@opensamguk/db';
import { emptyTurns, runGeneralTurn, toWorldState, type WorldInit } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { warFixture } from '../test/warFixture';
import { monthlyFixture } from '../test/monthlyFixture';
import { saveInitialWorld, readWorldState } from './world/persistence';
import { controlClock } from './world/clock';
import { acquireLease, releaseLease, renewLease, LeaseLostError } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';
import { backfillWorld, backfillWorlds } from './cli/backfillYearbookNations';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const execute = promisify(execFile);
const userPrefix = `archive-human-${randomUUID()}-`;
const worldIds: string[] = [];
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  await db.user.deleteMany({ where: { id: { startsWith: userPrefix } } });
  await db.$disconnect();
});

async function create(initial?: WorldInit) {
  initial ??= await warFixture();
  // 조기 통일을 막고 명시한 예턴만 실행해 저장 경계를 검증한다.
  initial.cities.push({
    ...initial.cities[0]!,
    cityKey: 999,
    name: '보존 검증 경계 도시',
    nationId: null,
    connections: [],
    supplied: false,
  });
  for (const general of initial.generals) {
    general.userId = `${userPrefix}${general.id}`;
    await db.user.upsert({
      where: { id: general.userId },
      update: {},
      create: { id: general.userId, email: `${general.userId}@example.test`, passwordHash: 'fixture-only' },
    });
  }
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '국가 표시값 보존',
    turnTermMinutes: 60,
    endYear: null,
  });
  worldIds.push(worldId);
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
      data: turns.map((turn, slot) => ({
        ...turn,
        worldId,
        generalId,
        slot,
        args: turn.args as Prisma.InputJsonValue,
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
        userId: actor.userId!,
        generalId,
        kind: 'turns.set',
        idempotencyKey: `archive-${sequence}`,
        status: 'APPLIED',
        sequence,
        payload: { turns, revision: actor.turnRevision } as unknown as Prisma.InputJsonValue,
        result: { revision: actor.turnRevision + 1 },
      },
    });
  });
}
async function archived(worldId: string) {
  return db.yearbookNation.findMany({ where: { worldId }, orderBy: [{ tick: 'asc' }, { nationId: 'asc' }] });
}
async function snapshot(worldId: string) {
  return {
    state: await readWorldState(db, worldId),
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    logs: await db.generalLog.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    frames: await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } }),
    nations: await archived(worldId),
    removed: await db.removedNation.findMany({ where: { worldId }, orderBy: { nationId: 'asc' } }),
    history: await db.nationHistory.findMany({ where: { worldId }, orderBy: [{ tick: 'asc' }, { nationId: 'asc' }] }),
    ranking: await db.rankingSnapshot.findUnique({ where: { worldId } }),
  };
}
async function birthFixture(attackTick = 100) {
  const initial = await warFixture();
  initial.cities[1]!.nationId = 1;
  initial.cities[1]!.supplied = true;
  initial.cities[3]!.nationId = 2;
  initial.nations[1]!.capitalCityKey = 4;
  for (const general of initial.generals.slice(1, 3)) general.cityKey = 4;
  initial.generals[0]!.cityKey = 2;
  initial.generals[0]!.nextTurnTick = attackTick;
  initial.generals[3]!.nextTurnTick = 50;
  return initial;
}
async function birthAndRemove(frameFirst: boolean) {
  const item = await create(await birthFixture(frameFirst ? 10100 : 100));
  await queue(item.worldId, 4, 'found', { name: '짧은 나라', color: '#123456' });
  await item.loop.advanceTo(50);
  await db.diplomacy.create({ data: { worldId: item.worldId, nationA: 1, nationB: 3, state: 'WAR', untilTick: 0 } });
  if (frameFirst) await item.loop.advanceTo(10000);
  await queue(item.worldId, 1, 'attack', { cityKey: 3 });
  await item.loop.advanceTo(frameFirst ? 10100 : 100);
  expect(await db.nation.findUnique({ where: { worldId_id: { worldId: item.worldId, id: 3 } } })).toBeNull();
  return item;
}
async function cli(worldId: string, apply = false) {
  const result = await execute(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/engine/src/cli/backfillYearbookNations.ts',
      '--world',
      worldId,
      ...(apply ? ['--apply'] : []),
    ],
    {
      env: { ...process.env, DATABASE_URL: url },
      timeout: 30_000,
    },
  );
  return JSON.parse(result.stdout.trim()) as Awaited<ReturnType<typeof backfillWorld>>;
}

describe('T4-56 / AC-P2-17 실제 PostgreSQL 국가 표시값 저장', () => {
  it('R1/S3 멸망 턴의 행동 번호·tick과 삭제 전 이름·색을 보존하고 옛 프레임은 남긴다', async () => {
    const initial = await warFixture();
    initial.generals[0]!.nextTurnTick = 10100;
    const { worldId, loop } = await create(initial);
    await loop.advanceTo(10000);
    const before = await archived(worldId);
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await loop.advanceTo(10100);
    const row = await db.removedNation.findUniqueOrThrow({ where: { worldId_nationId: { worldId, nationId: 2 } } });
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(row).toEqual({
      worldId,
      nationId: 2,
      name: initial.nations[1]!.name,
      color: initial.nations[1]!.color,
      removedSequence: world.actionSequence,
      removedTick: 10100,
    });
    expect(
      await db.generalLog.findUniqueOrThrow({
        where: { worldId_generalId_tick: { worldId, generalId: 1, tick: row.removedTick } },
      }),
    ).toMatchObject({ kind: 'success' });
    expect(await archived(worldId)).toEqual(before);
    await loop.advanceTo(20000);
    expect((await archived(worldId)).filter(({ tick }) => tick === 20000).map(({ nationId }) => nationId)).toEqual([1]);
  });

  it('R2 첫 정산 전 멸망도 프레임 없이 보존한다', async () => {
    const { worldId, loop, initial } = await create();
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await loop.advanceTo(100);
    expect(await archived(worldId)).toEqual([]);
    expect(await db.removedNation.findMany({ where: { worldId } })).toMatchObject([
      { nationId: 2, name: initial.nations[1]!.name, color: initial.nations[1]!.color, removedTick: 100 },
    ]);
  });

  it('R3/R4/S2 같은 달 건국·멸망과 같은 이름의 새 ID를 분리하고 다음 달 새 ID만 저장한다', async () => {
    const initial = await birthFixture();
    initial.generals.push({ ...initial.generals[3]!, id: 5, cityKey: 999, nextTurnTick: 200 });
    const { worldId, loop } = await create(initial);
    await queue(worldId, 4, 'found', { name: '짧은 나라', color: '#123456' });
    await loop.advanceTo(50);
    await db.diplomacy.create({ data: { worldId, nationA: 1, nationB: 3, state: 'WAR', untilTick: 0 } });
    await queue(worldId, 1, 'attack', { cityKey: 3 });
    await loop.advanceTo(100);
    expect(await archived(worldId)).toEqual([]);
    expect(
      await db.removedNation.findUniqueOrThrow({ where: { worldId_nationId: { worldId, nationId: 3 } } }),
    ).toMatchObject({ name: '짧은 나라', color: '#123456', removedTick: 100 });
    await queue(worldId, 5, 'found', { name: '짧은 나라', color: '#654321' });
    await loop.advanceTo(200);
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 4 } } })).toMatchObject({
      name: '짧은 나라',
      color: '#654321',
    });
    await loop.advanceTo(10000);
    expect((await archived(worldId)).map(({ nationId }) => nationId)).toEqual([1, 2, 4]);
  });

  it.each(['error', 'token', 'expiry'])(
    'R5 멸망 턴 %s는 보존·국가·로그·예턴·행동 번호를 함께 롤백한다',
    async (failure) => {
      const { worldId, lease } = await create();
      await queue(worldId, 1, 'attack', { cityKey: 2 });
      const before = await snapshot(worldId);
      const loop = new TurnLoop(db, lease, {
        beforeCommit: async (tx) => {
          if (failure === 'error') throw new Error('보존 롤백');
          await tx.engineLease.update({
            where: { worldId },
            data: failure === 'token' ? { fencingToken: { increment: 1 } } : { expiresAt: new Date(0) },
          });
        },
      });
      if (failure === 'error') await expect(loop.advanceTo(100)).rejects.toThrow('보존 롤백');
      else await expect(loop.advanceTo(100)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await snapshot(worldId)).toEqual(before);
      await new TurnLoop(db, lease).advanceTo(100);
      expect(await db.removedNation.count({ where: { worldId } })).toBe(1);
    },
  );

  it.each(['beforeCommit', 'committed'])(
    'R6 실제 SIGKILL %s 뒤 보존은 한 번이고 재적재 상태가 일치한다',
    async (phase) => {
      const { worldId, lease, initial } = await create();
      await queue(worldId, 1, 'attack', { cityKey: 2 });
      const expected = runGeneralTurn(
        toWorldState(initial),
        { generalId: 1, tick: 100, unitSet: initial.unitSet },
        { commandKey: 'attack', args: { cityKey: 2 } },
        initial.seed,
      ).state;
      expected.generals[1]!.nextTurnTick = 10100;
      await releaseLease(db, lease);
      const child = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/test/turnWorker.ts', worldId, phase], {
        env: { ...process.env, TEST_DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const exited = once(child, 'exit');
      try {
        const message = await Promise.race([
          once(child, 'message').then(([value]) => value),
          exited.then(() => {
            throw new Error('보존 worker 조기 종료');
          }),
        ]);
        expect(message).toBe(phase);
        child.kill('SIGKILL');
        await exited;
        expect(await db.removedNation.count({ where: { worldId } })).toBe(phase === 'committed' ? 1 : 0);
        await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "worldId" = ${worldId}`;
        const loop = new TurnLoop(db, (await acquireLease(db, worldId))!);
        await loop.advanceTo(500);
        await loop.advanceTo(500);
        expect(await db.removedNation.count({ where: { worldId } })).toBe(1);
        expect(hashState(toWorldState(await readWorldState(db, worldId)))).toBe(hashState(expected));
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
    60_000,
  );

  it('R7 삭제 보존 키 중복은 턴 전체를 롤백한다', async () => {
    const { worldId, loop, initial } = await create();
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await db.removedNation.create({
      data: {
        worldId,
        nationId: 2,
        name: initial.nations[1]!.name,
        color: initial.nations[1]!.color,
        removedSequence: 1,
        removedTick: 0,
      },
    });
    const before = await snapshot(worldId);
    await expect(loop.advanceTo(100)).rejects.toThrow();
    expect(await snapshot(worldId)).toEqual(before);
    await db.removedNation.deleteMany({ where: { worldId } });
    await loop.advanceTo(100);
    expect(await db.removedNation.count({ where: { worldId } })).toBe(1);
  });

  it('S1/S8 12개월 표시값은 commit 직전 국가와 같고 v2 재생과 보관 key는 그대로다', async () => {
    const { worldId, lease } = await create(await monthlyFixture());
    const seen = new Set<number>();
    const loop = new TurnLoop(db, lease, {
      beforeCommit: async (tx) => {
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        if (!world.monthlyTick || seen.has(world.monthlyTick)) return;
        const rows = await tx.yearbookNation.findMany({
          where: { worldId, tick: world.monthlyTick },
          orderBy: { nationId: 'asc' },
          select: { nationId: true, name: true, color: true },
        });
        const alive = await tx.nation.findMany({
          where: { worldId },
          orderBy: { id: 'asc' },
          select: { id: true, name: true, color: true },
        });
        expect(rows).toEqual(alive.map(({ id, name, color }) => ({ nationId: id, name, color })));
        const frame = await tx.yearbookSnapshot.findUniqueOrThrow({
          where: { worldId_tick: { worldId, tick: world.monthlyTick } },
        });
        expect(rows.map(({ nationId }) => nationId)).toEqual(
          (frame.data as { nations: Array<{ nationId: number }> }).nations.map(({ nationId }) => nationId),
        );
        seen.add(world.monthlyTick);
      },
    });
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo(month * 10000);
    }
    expect(seen.size).toBe(12);
    const archive = await exportReplay(db, worldId);
    expect(Object.keys(archive).sort()).toEqual(['afterEnd', 'config', 'end', 'inputs', 'months', 'origin', 'version']);
    for (const month of archive.months)
      expect(Object.keys(month).sort()).toEqual(['data', 'month', 'sequence', 'stateHash', 'tick', 'year']);
    expect(replayArchive(archive).map(({ stateHash }) => stateHash)).toEqual(
      archive.months.map(({ stateHash }) => stateHash),
    );
  });

  it('S2 건국 전 프레임에는 새 ID가 없고 다음 프레임부터 남긴다', async () => {
    const initial = await birthFixture(30100);
    initial.generals[3]!.nextTurnTick = 10050;
    const { worldId, loop } = await create(initial);
    await loop.advanceTo(10000);
    await queue(worldId, 4, 'found', { name: '다음 달 나라', color: '#123456' });
    await loop.advanceTo(10050);
    await loop.advanceTo(20000);
    expect((await archived(worldId)).filter(({ tick }) => tick === 10000).map(({ nationId }) => nationId)).toEqual([
      1, 2,
    ]);
    expect((await archived(worldId)).filter(({ tick }) => tick === 20000).map(({ nationId }) => nationId)).toEqual([
      1, 2, 3,
    ]);
  });

  it('S4 규칙 변경 없이 DB 표시값을 바꾼 저장 결합 시험: 앞·뒤 프레임과 삭제 직전 값이 다르다', async () => {
    const initial = await warFixture();
    initial.generals[0]!.nextTurnTick = 20100;
    const { worldId, loop } = await create(initial);
    await loop.advanceTo(10000);
    await db.nation.update({
      where: { worldId_id: { worldId, id: 2 } },
      data: { name: '바뀐 국호', color: '#112233' },
    });
    await loop.advanceTo(20000);
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await loop.advanceTo(20100);
    expect((await archived(worldId)).filter(({ nationId }) => nationId === 2)).toMatchObject([
      { tick: 10000, name: initial.nations[1]!.name, color: initial.nations[1]!.color },
      { tick: 20000, name: '바뀐 국호', color: '#112233' },
    ]);
    expect(
      await db.removedNation.findUniqueOrThrow({ where: { worldId_nationId: { worldId, nationId: 2 } } }),
    ).toMatchObject({ name: '바뀐 국호', color: '#112233' });
  });

  it('S7 방금 쓴 부모 프레임 아래 같은 트랜잭션의 중복은 정산 전체를 롤백한다', async () => {
    const { worldId, loop, lease } = await create(await monthlyFixture());
    await loop.advanceTo(9999);
    const before = await snapshot(worldId);
    const failing = new TurnLoop(db, lease, {
      beforeCommit: async (tx) => {
        const row = await tx.yearbookNation.findFirstOrThrow({ where: { worldId, tick: 10000 } });
        await tx.yearbookNation.create({ data: row });
      },
    });
    await expect(failing.advanceTo(10000)).rejects.toThrow();
    expect(await snapshot(worldId)).toEqual(before);
    await loop.advanceTo(10000);
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(1);
    expect(await db.yearbookNation.count({ where: { worldId } })).toBe(2);
  });

  it('S9 RepeatableRead는 commit 전 둘 다 못 보고 commit 후 새 읽기는 둘 다 본다', async () => {
    const { worldId, loop, lease } = await create(await monthlyFixture());
    await loop.advanceTo(9999);
    let allowCommit!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = new TurnLoop(db, lease, {
      beforeCommit: async () => {
        entered();
        await held;
      },
    }).advanceTo(10000);
    await Promise.race([
      ready,
      writer.then(() => {
        throw new Error('정산 정지 지점이 실행되지 않았습니다.');
      }),
    ]);
    try {
      await db.$transaction(
        async (tx) => {
          expect(await tx.yearbookSnapshot.count({ where: { worldId } })).toBe(0);
          expect(await tx.yearbookNation.count({ where: { worldId } })).toBe(0);
          allowCommit();
          await writer;
          expect(await tx.yearbookSnapshot.count({ where: { worldId } })).toBe(0);
          expect(await tx.yearbookNation.count({ where: { worldId } })).toBe(0);
        },
        { isolationLevel: 'RepeatableRead', timeout: 30_000 },
      );
    } finally {
      allowCommit();
      await writer;
    }
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(1);
    expect(await db.yearbookNation.count({ where: { worldId } })).toBe(2);
  });
  it('M1 프레임 외래 키를 강제하고 월드 삭제는 두 보존 표에 전파된다', async () => {
    const { worldId, loop } = await create();
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await loop.advanceTo(10000);
    await expect(
      db.yearbookNation.create({ data: { worldId, tick: 99999, nationId: 1, name: '시험', color: '#112233' } }),
    ).rejects.toThrow();
    expect(await db.removedNation.count({ where: { worldId } })).toBe(1);
    expect(await db.yearbookNation.count({ where: { worldId } })).toBe(1);
    await db.world.delete({ where: { id: worldId } });
    expect(await db.removedNation.count({ where: { worldId } })).toBe(0);
    expect(await db.yearbookNation.count({ where: { worldId } })).toBe(0);
  });
});

describe('T4-56 / AC-P2-17 실제 PostgreSQL legacy 백필', () => {
  it('B1/B3/B4 실제 CLI의 보고는 쓰지 않고 apply는 모든 증거와 일치하며 반복은 0행이다', async () => {
    const { worldId } = await birthAndRemove(true);
    const expected = await archived(worldId);
    await db.yearbookNation.deleteMany({ where: { worldId } });
    const removed = await db.removedNation.findMany({ where: { worldId } });
    const dry = await cli(worldId);
    expect(dry).toMatchObject({ status: 'ok', inserted: 0, wouldInsert: expected.length });
    expect(await archived(worldId)).toEqual([]);
    expect((await cli(worldId, true)).inserted).toBe(expected.length);
    expect(await archived(worldId)).toEqual(expected);
    expect(await db.removedNation.findMany({ where: { worldId } })).toEqual(removed);
    expect(await backfillWorld(db, worldId, true)).toMatchObject({
      status: 'ok',
      inserted: 0,
      existing: expected.length,
    });
  }, 60_000);

  it('B2/B4 부분 프레임은 쌍마다 채우며 근거가 뒤늦게 생긴 국가만 재실행한다', async () => {
    const { worldId, initial } = await birthAndRemove(true);
    await db.yearbookNation.deleteMany({ where: { worldId } });
    await db.removedNation.deleteMany({ where: { worldId, nationId: 3 } });
    const report = await backfillWorld(db, worldId, true);
    expect(report).toMatchObject({
      status: 'ok',
      inserted: 2,
      missing: [{ tick: 10000, nationId: 3 }],
      partialFrames: 1,
    });
    expect((await archived(worldId)).map(({ nationId }) => nationId)).toEqual([1, 2]);
    await db.nation.create({
      data: { ...initial.nations[0]!, worldId, id: 3, name: '짧은 나라', color: '#123456', capitalCityKey: null },
    });
    expect(await backfillWorld(db, worldId, true)).toMatchObject({
      status: 'ok',
      inserted: 1,
      existing: 2,
      missing: [],
      partialFrames: 0,
    });
  });

  it('B5/B6 기존 행·초기 증거 충돌은 월드 전체를 닫고 다른 월드는 계속 처리한다', async () => {
    const bad = await create(await monthlyFixture());
    await bad.loop.advanceTo(20000);
    await db.yearbookNation.deleteMany({ where: { worldId: bad.worldId, tick: 10000 } });
    await db.yearbookNation.update({
      where: { worldId_tick_nationId: { worldId: bad.worldId, tick: 20000, nationId: 1 } },
      data: { name: '충돌 비밀값' },
    });
    const before = await archived(bad.worldId);
    const conflict = await backfillWorld(db, bad.worldId, true);
    expect(conflict).toMatchObject({
      status: 'conflict',
      inserted: 0,
      conflict: { tick: 20000, nationId: 1, sources: expect.arrayContaining(['YearbookNation', 'Nation']) },
    });
    expect(JSON.stringify(conflict)).not.toContain('충돌 비밀값');
    expect(await archived(bad.worldId)).toEqual(before);
    const good = await create(await monthlyFixture());
    await good.loop.advanceTo(10000);
    await db.yearbookNation.deleteMany({ where: { worldId: good.worldId } });
    const reports = await backfillWorlds(db, true);
    expect(reports.find(({ worldId }) => worldId === bad.worldId)!.status).toBe('conflict');
    expect(reports.find(({ worldId }) => worldId === good.worldId)!.inserted).toBe(2);
    await db.yearbookNation.deleteMany({ where: { worldId: good.worldId } });
    await db.nation.update({ where: { worldId_id: { worldId: good.worldId, id: 1 } }, data: { color: '#abcdef' } });
    expect(await backfillWorld(db, good.worldId, true)).toMatchObject({
      status: 'conflict',
      inserted: 0,
      conflict: { sources: expect.arrayContaining(['Nation', 'replayOrigin.initial.nations']) },
    });
    expect(await archived(good.worldId)).toEqual([]);
  });

  it('B7 생성 기록 없이 살아 있는 국가·삭제 보존만 쓰고 저장 행만 있는 쌍은 보존한다', async () => {
    const { worldId } = await birthAndRemove(true);
    const kept = (await archived(worldId)).find(({ nationId }) => nationId === 3)!;
    await db.$executeRaw`UPDATE "World" SET "replayOrigin" = NULL WHERE id = ${worldId}`;
    await db.removedNation.deleteMany({ where: { worldId } });
    await db.yearbookNation.deleteMany({ where: { worldId, nationId: { not: 3 } } });
    expect(await backfillWorld(db, worldId, true)).toMatchObject({
      status: 'ok',
      inserted: 2,
      existing: 1,
      missing: [],
    });
    expect((await archived(worldId)).find(({ nationId }) => nationId === 3)).toEqual(kept);
    await db.yearbookNation.deleteMany({ where: { worldId, nationId: 3 } });
    expect(await backfillWorld(db, worldId, true)).toMatchObject({
      status: 'ok',
      inserted: 0,
      missing: [{ tick: 10000, nationId: 3 }],
      partialFrames: 1,
    });
  });
});
