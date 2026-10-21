import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { publicNationPower, toWorldState } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { warFixture } from '../test/warFixture';
import { saveInitialWorld, readWorldState } from './world/persistence';
import { controlClock } from './world/clock';
import { acquireLease, renewLease } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [];
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.$disconnect();
});

describe('T2-22 / AC-M2-19 엔진 순위 집계', () => {
  it('첫 정산에서 등장 장수만 집계하고 캐시 롤백·교체와 기존 재생 해시를 보존한다', async () => {
    const initial = await monthlyFixture();
    const { worldId, stateHash } = await saveInitialWorld(db, initial, { name: '순위 월간', turnTermMinutes: 60 });
    worlds.push(worldId);
    expect(hashState(await readWorldState(db, worldId))).toBe(stateHash);
    await db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { battleWins: 7, captures: 3 } });
    expect(hashState(await readWorldState(db, worldId))).toBe(stateHash);
    await controlClock(db, worldId, 'start');
    const lease = (await acquireLease(db, worldId))!;
    const loop = new TurnLoop(db, lease);
    await loop.advanceTo(9999);
    expect(await db.rankingSnapshot.findUnique({ where: { worldId } })).toBeNull();
    const interrupted = new TurnLoop(db, lease, {
      beforeCommit: async () => {
        throw new Error('순위 저장 중단');
      },
    });
    await expect(interrupted.advanceTo(10000)).rejects.toThrow('순위 저장 중단');
    expect(await db.rankingSnapshot.findUnique({ where: { worldId } })).toBeNull();
    expect(await db.yearbookSnapshot.count({ where: { worldId } })).toBe(0);
    await loop.advanceTo(10000);
    const first = await db.rankingSnapshot.findUniqueOrThrow({ where: { worldId } });
    expect(first).toMatchObject({ tick: 10000, year: initial.startYear, month: 1 });
    const generals = first.generals as Array<{ id: number; wins: number; captures: number }>;
    expect(generals.map((g) => g.id)).toEqual([1, 2]);
    expect(generals[0]).toMatchObject({ wins: 7, captures: 3 });
    const nations = first.nations as Array<{ id: number; cities: number; generals: number; power: number }>;
    const settled = toWorldState(await readWorldState(db, worldId));
    for (const nation of nations) {
      expect(nation.power).toBe(
        publicNationPower(settled, nation.id, { seed: initial.seed, tick: 10000, year: initial.startYear }),
      );
    }
    expect(JSON.stringify(first)).not.toMatch(/gold|rice|crew|population|userId|affinity|leadership/);
    await loop.advanceTo(10000);
    expect(await db.rankingSnapshot.findUnique({ where: { worldId } })).toEqual(first);
    await renewLease(db, lease);
    await loop.advanceTo(19999);
    const beforeFailure = await db.rankingSnapshot.findUnique({ where: { worldId } });
    await expect(interrupted.advanceTo(20000)).rejects.toThrow('순위 저장 중단');
    expect(await db.rankingSnapshot.findUnique({ where: { worldId } })).toEqual(beforeFailure);
    await loop.advanceTo(20000);
    expect(await db.rankingSnapshot.findUnique({ where: { worldId } })).toMatchObject({ tick: 20000, month: 2 });
    expect(await db.rankingSnapshot.count({ where: { worldId } })).toBe(1);
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive, 2).map((month) => month.stateHash)).toEqual(
      archive.months.map((month) => month.stateHash),
    );
  });

  it('전투 누계는 실패한 턴에서 롤백되고 재시도·엔진 재시작에도 한 번만 저장된다', async () => {
    const initial = await warFixture();
    const { worldId } = await saveInitialWorld(db, initial, { name: '순위 전투', turnTermMinutes: 60 });
    worlds.push(worldId);
    await controlClock(db, worldId, 'start');
    const lease = (await acquireLease(db, worldId))!;
    await db.generalTurn.create({
      data: { worldId, generalId: 1, slot: 0, commandKey: 'attack', args: { cityKey: 2 } },
    });
    const actor = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const interrupted = new TurnLoop(db, lease, {
      beforeCommit: async () => {
        throw new Error('전공 저장 중단');
      },
    });
    await expect(interrupted.advanceTo(100)).rejects.toThrow('전공 저장 중단');
    expect(await actor()).toMatchObject({ battleWins: 0, captures: 0, nextTurnTick: 100 });
    expect(await db.battleLog.count({ where: { worldId } })).toBe(0);
    await new TurnLoop(db, lease).advanceTo(100);
    expect(await actor()).toMatchObject({ battleWins: 2, captures: 1, nextTurnTick: 10100 });
    await new TurnLoop(db, lease).advanceTo(100);
    expect(await actor()).toMatchObject({ battleWins: 2, captures: 1 });
    const state = await db.$transaction((tx) => tx.general.findMany({ where: { worldId } }));
    expect(state.filter((g) => g.id !== 1).every((g) => g.battleWins === 0 && g.captures === 0)).toBe(true);
  });
});
