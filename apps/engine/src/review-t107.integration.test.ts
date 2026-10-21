// 리뷰 탐침(T1-07, t_f69c5c57). PR에 넣지 않는 별도 브랜치 전용 실제 PostgreSQL 시험이다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextActionSequence, type Prisma } from '@opensamguk/db';
import { emptyTurns, type WorldInit } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { TurnLoop } from './turnLoop';
import { acquireLease, LeaseLostError, renewLease } from './lease';
import { controlClock } from './world/clock';
import { saveInitialWorld } from './world/persistence';
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

async function create(initial: WorldInit = template) {
  const { worldId } = await saveInitialWorld(db, initial, { name: '리뷰 탐침', turnTermMinutes: 60 });
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  return { worldId, lease, loop: new TurnLoop(db, lease) };
}

// T1-11 계약 문서 순서: 월드 행 잠금(nextActionSequence) → 장수 revision 확인 → 예턴·입력 저장.
async function apiSetTurns(worldId: string, generalId: number, commandKey: string, idempotencyKey: string) {
  return db.$transaction(async (tx) => {
    const sequence = await nextActionSequence(tx, worldId);
    await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND id = ${generalId} FOR UPDATE`;
    const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
    const turns = emptyTurns().map(() => ({ commandKey, args: {} }));
    await tx.generalTurn.deleteMany({ where: { worldId, generalId } });
    await tx.generalTurn.createMany({
      data: turns.map((turn, slot) => ({ ...turn, args: {}, slot, worldId, generalId })),
    });
    await tx.general.update({
      where: { worldId_id: { worldId, id: generalId } },
      data: { turnRevision: { increment: 1 } },
    });
    await tx.inputEvent.create({
      data: {
        worldId,
        userId: `review-${generalId}`,
        generalId,
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

describe('리뷰 탐침 AC-M1-12 밀린 여러 달 교차 순서', () => {
  it('한 번의 advanceTo(35000)에서 턴·정산이 tick 순으로 교차하고 sequence가 맞는다', async () => {
    const { worldId, loop } = await create();
    const executions = await loop.advanceTo(35000);
    expect(executions.map(({ generalId, tick }) => `${generalId}@${tick}`)).toEqual([
      '1@100',
      '2@10000',
      '1@10100',
      '2@20000',
      '1@20100',
      '2@30000',
      '1@30100',
    ]);
    const snapshots = await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } });
    // 1@100(1) M1(2) 2@10000(3) 1@10100(4) M2(5) 2@20000(6) 1@20100(7) M3(8) 2@30000(9) 1@30100(10)
    expect(snapshots.map(({ tick, sequence }) => [tick, sequence])).toEqual([
      [10000, 2],
      [20000, 5],
      [30000, 8],
    ]);
    expect(await db.world.findUniqueOrThrow({ where: { id: worldId } })).toMatchObject({
      monthlyTick: 30000,
      actionSequence: 10,
      clockTick: 35000,
    });
    expect(replayArchive(await exportReplay(db, worldId), 3)).toHaveLength(3);
  });
});

describe('리뷰 탐침 AC-M1-12 펜싱', () => {
  it('리스를 빼앗긴 옛 엔진은 월 정산을 쓰지 못하고 새 엔진이 한 번만 쓴다', async () => {
    const { worldId, lease, loop } = await create();
    await loop.advanceTo(9999);
    await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "worldId" = ${worldId}`;
    const taken = (await acquireLease(db, worldId))!;
    expect(taken.fencingToken).toBeGreaterThan(lease.fencingToken);
    await expect(loop.advanceTo(10000)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(0);
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).monthlyTick).toBe(0);
    const fresh = new TurnLoop(db, taken);
    await fresh.advanceTo(10000);
    await expect(loop.advanceTo(10000)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(1);
    expect(await db.nationHistory.count({ where: { worldId } })).toBe(2);
  });
});

describe('리뷰 탐침 AC-M1-13 동시 입력과 교차 월드 결정성', () => {
  it('엔진 진행과 동시에 들어온 예턴 입력도 교착 없이 직렬화되고 12개월 재생이 맞는다', async () => {
    const { worldId, loop, lease } = await create();
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, lease);
      const results = await Promise.allSettled([
        loop.advanceTo(month * 10000 - 5000),
        apiSetTurns(worldId, 1, month % 2 ? 'farm' : 'commerce', `g1-${month}`),
        apiSetTurns(worldId, 2, month % 2 ? 'commerce' : 'farm', `g2-${month}`),
      ]);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
      await loop.advanceTo(month * 10000);
    }
    const archive = await exportReplay(db, worldId);
    expect(archive.inputs).toHaveLength(24);
    const hashes = replayArchive(archive);
    expect(hashes.map(({ stateHash }) => stateHash)).toEqual(archive.months.map(({ stateHash }) => stateHash));
  }, 120000);

  it('같은 시드·같은 입력의 두 월드는 월별 해시가 같고 시드가 다르면 달라진다', async () => {
    const play = async (initial: WorldInit) => {
      const { worldId, loop, lease } = await create(initial);
      await apiSetTurns(worldId, 1, 'farm', 'a');
      await apiSetTurns(worldId, 2, 'farm', 'b');
      for (let month = 1; month <= 12; month++) {
        await renewLease(db, lease);
        await loop.advanceTo(month * 10000);
      }
      const archive = await exportReplay(db, worldId);
      expect(replayArchive(archive)).toHaveLength(12);
      return archive.months.map(({ stateHash }) => stateHash);
    };
    const first = await play(template);
    expect(await play(template)).toEqual(first);
    expect(await play({ ...structuredClone(template), seed: 'review-other-seed' })).not.toEqual(first);
  }, 120000);
});
