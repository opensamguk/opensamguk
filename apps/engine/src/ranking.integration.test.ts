import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { publicNationPower, toWorldState } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { warFixture } from '../test/warFixture';
import { saveInitialWorld, readWorldState } from './world/persistence';
import { controlClock } from './world/clock';
import { acquireLease, renewLease } from './lease';
import { persistCommandReports } from './commandPersistence';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [];
const users: string[] = [];
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('T2-22 / AC-M2-19 엔진 순위 집계', () => {
  it('첫 정산에서 등장 장수만 집계하고 캐시 롤백·교체와 기존 재생 해시를 보존한다', async () => {
    const initial = await monthlyFixture();
    const { worldId, stateHash } = await saveInitialWorld(db, initial, {
      replayFormat: 'legacy',
      name: '순위 월간',
      turnTermMinutes: 60,
      endYear: null,
    });
    worlds.push(worldId);
    expect(hashState(await readWorldState(db, worldId))).toBe(stateHash);
    await db.general.update({
      where: { worldId_id: { worldId, id: 1 } },
      data: { battleWins: 7, captures: 3, stratagemSuccesses: 4 },
    });
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
    expect(generals[0]).toMatchObject({ wins: 7, captures: 3, stratagemSuccesses: 4 });
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
    const human = await db.user.create({
      data: { email: `${crypto.randomUUID()}@example.test`, passwordHash: 'fixture-only' },
    });
    users.push(human.id);
    const { worldId } = await saveInitialWorld(db, initial, {
      replayFormat: 'legacy',
      name: '순위 전투',
      turnTermMinutes: 60,
      endYear: null,
    });
    worlds.push(worldId);
    await db.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { userId: human.id } });
    await controlClock(db, worldId, 'start');
    const lease = (await acquireLease(db, worldId))!;
    await db.generalTurn.create({
      data: { worldId, generalId: 1, slot: 0, explicit: true, commandKey: 'attack', args: { cityKey: 2 } },
    });
    const actor = () => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const engagements = () => db.generalBattleStats.findMany({ where: { worldId }, orderBy: { generalId: 'asc' } });
    const interrupted = new TurnLoop(db, lease, {
      beforeCommit: async () => {
        throw new Error('전공 저장 중단');
      },
    });
    await expect(interrupted.advanceTo(100)).rejects.toThrow('전공 저장 중단');
    expect(await actor()).toMatchObject({ battleWins: 0, captures: 0, nextTurnTick: 100 });
    expect(await db.battleLog.count({ where: { worldId } })).toBe(0);
    expect(await engagements()).toEqual([]);
    await new TurnLoop(db, lease).advanceTo(100);
    expect(await actor()).toMatchObject({ battleWins: 2, captures: 1, nextTurnTick: 10100 });
    const recordedBattles = await engagements();
    const reports = await db.battleLog.findMany({ where: { worldId }, orderBy: { generalId: 'asc' } });
    expect(reports).toHaveLength(3);
    expect(reports[0]?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opponent: initial.generals.find(({ id }) => id === 2)!.name }),
        expect.objectContaining({ opponent: '성벽' }),
      ]),
    );
    expect(reports[1]?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'exchange',
          attackerLoss: expect.any(Number),
          defenderLoss: expect.any(Number),
        }),
      ]),
    );
    expect(recordedBattles[0]).toMatchObject({ engagements: 2, wins: 2, losses: 0, lastTick: 100 });
    expect(recordedBattles.slice(1).map((row) => row.losses)).toEqual([1, 1]);
    expect(recordedBattles[0]!.kills).toBe(recordedBattles[1]!.casualties + recordedBattles[2]!.casualties);
    expect(recordedBattles[0]!.casualties).toBe(recordedBattles[1]!.kills + recordedBattles[2]!.kills);
    expect(recordedBattles[0]).toMatchObject({
      humanEngagements: 1,
      humanKills: recordedBattles[1]!.casualties,
      humanCasualties: recordedBattles[1]!.kills,
    });
    expect(recordedBattles.slice(1).every(({ humanEngagements }) => humanEngagements === 0)).toBe(true);
    await new TurnLoop(db, lease).advanceTo(100);
    expect(await actor()).toMatchObject({ battleWins: 2, captures: 1 });
    expect(await engagements()).toEqual(recordedBattles);
    await new TurnLoop(db, lease).advanceTo(10_000);
    const snapshot = await db.rankingSnapshot.findUniqueOrThrow({ where: { worldId } });
    expect(snapshot.generals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 1,
          battleStats: {
            engagements: 2,
            winRate: 1,
            kills: Number(recordedBattles[0]!.kills),
            killRate: Number(recordedBattles[0]!.kills) / Math.max(1, Number(recordedBattles[0]!.casualties)),
            humanKills: Number(recordedBattles[0]!.humanKills),
            humanKillRate:
              Number(recordedBattles[0]!.humanKills) / Math.max(1, Number(recordedBattles[0]!.humanCasualties)),
          },
        }),
      ]),
    );
    const state = await db.$transaction((tx) => tx.general.findMany({ where: { worldId } }));
    expect(state.filter((g) => g.id !== 1).every((g) => g.battleWins === 0 && g.captures === 0)).toBe(true);
    const recorded = { stratagemSucceeded: true } as const;
    await expect(
      db.$transaction(async (tx) => {
        await persistCommandReports(tx, worldId, 100, 1, { ...recorded, logs: [], effects: [] });
        throw Error('계략 집계 중단');
      }),
    ).rejects.toThrow('계략 집계 중단');
    expect((await actor()).stratagemSuccesses).toBe(0);
    await db.$transaction((tx) => persistCommandReports(tx, worldId, 100, 1, { ...recorded, logs: [], effects: [] }));
    expect((await actor()).stratagemSuccesses).toBe(1);
  });
});
