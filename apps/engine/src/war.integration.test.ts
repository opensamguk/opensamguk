import { prepareBattleFixture, warArmies, type FixtureArmy } from '../test/battleFixture';
import { recordTestTurns } from '../test/seasonFixture';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import { refreshSupply, runReplayAction, toWorldState, type WorldInit } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { warFixture } from '../test/warFixture';
import { readWorldState } from './world/persistence';
import { acquireLease, LeaseLostError, releaseLease, renewLease } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';
import { loadReplayState } from './monthly';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const users: string[] = [];
afterAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function create(initial?: WorldInit, armies: FixtureArmy[] = warArmies) {
  initial ??= await warFixture();
  initial.cities.push({
    ...initial.cities[0]!,
    cityKey: 999,
    name: 'Replay boundary',
    nationId: null,
    connections: [],
    supplied: false,
  });
  const saved = await prepareBattleFixture(db, initial, armies);
  users.push(...saved.users);
  return { ...saved, initial: await readWorldState(db, saved.worldId) };
}
async function queue(worldId: string, generalId: number, commandKey: string, args: Prisma.InputJsonValue) {
  await recordTestTurns(db, worldId, generalId, commandKey, args);
}

async function snapshot(worldId: string) {
  return {
    state: await readWorldState(db, worldId),
    replay: await db.$transaction((tx) => loadReplayState(tx, worldId)),
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    logs: await db.generalLog.findMany({ where: { worldId } }),
    battle: await db.battleLog.findMany({ where: { worldId } }),
    history: await db.nationHistory.findMany({ where: { worldId } }),
  };
}

// 명령 하나의 기록. INT-29 기록 조각 v1부터 명령 줄마다 한 행이므로 행 수 대신 같은 명령 묶음(sequence)
// 하나이고 순번이 0부터 이어지며 본문에 줄바꿈이 없는지 본다.
async function expectOneCommandLog(where: Prisma.GeneralLogWhereInput) {
  const rows = await db.generalLog.findMany({ where, orderBy: { ordinal: 'asc' } });
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((row) => `${row.generalId}:${row.tick}:${row.sequence}`)).size).toBe(1);
  expect(rows.map((row) => row.ordinal)).toEqual(rows.map((_, ordinal) => ordinal));
  expect(rows.every((row) => !/[\r\n]/.test(row.text))).toBe(true);
}

describe('AC-M1-14~16 실제 PostgreSQL 명령·전투', () => {
  it.each(['basic', 'effects'] as const)(
    'AC-INT-22 %s의 새 계산식은 실제 전투·rollback·12개월 재생·재적재가 같다',
    async (mode) => {
      const initial = await warFixture();

      initial.generals[1]!.crewType = 1200;

      if (mode === 'effects') {
        initial.unitSet.coefMode = 'multiply';
        for (const row of initial.unitSet.crewTypes)
          row.effects = row.armType === 1 ? ['guard5'] : ['firstVolley', 'avoid'];
      }
      const { worldId, loop, lease } = await create(initial, [
        { generalId: 1, troops: 1000, crewType: 1100 },
        { generalId: 2, troops: 1000, crewType: 1200 },
      ]);
      try {
        await queue(worldId, 1, 'attack', { cityKey: 2 });
        const before = await snapshot(worldId);
        await expect(
          new TurnLoop(db, lease, {
            beforeCommit: async () => {
              throw Error('int22 battle rollback');
            },
          }).advanceTo(100100),
        ).rejects.toThrow('int22 battle rollback');
        expect(await snapshot(worldId)).toEqual(before);
        const expected = runReplayAction(
          await db.$transaction((tx) => loadReplayState(tx, worldId)),
          initial.seed,
          initial.unitSet,
        ).state;
        await loop.advanceTo(100100);
        await loop.advanceTo(100100);
        expect(hashState((await db.$transaction((tx) => loadReplayState(tx, worldId))).state)).toBe(
          hashState(expected),
        );
        await expectOneCommandLog({ worldId, generalId: 1, tick: 100100 });
        for (let month = 1; month <= 12; month++) {
          await renewLease(db, lease);
          await loop.advanceTo((month + 10) * 10000);
        }
        const archive = await exportReplay(db, worldId);
        const result = replayArchive(archive, 22);
        expect(result.map((row) => row.stateHash)).toEqual(archive.months.map((row) => row.stateHash));
        const reopened = createDb(url!);
        try {
          expect(hashState(await reopened.$transaction((tx) => loadReplayState(tx, worldId)))).toBe(
            result.at(-1)!.stateHash,
          );
        } finally {
          await reopened.$disconnect();
        }
      } finally {
        await releaseLease(db, lease);
      }
    },
  );
  it('국가포상·수비2명·성벽·멸망·재야·국가예턴 삭제와 로그를 한 번 저장하고 12개월 재생한다', async () => {
    const { initial, worldId, loop, lease } = await create();
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    const expected = runReplayAction(
      await db.$transaction((tx) => loadReplayState(tx, worldId)),
      initial.seed,
      initial.unitSet,
    ).state;
    await loop.advanceTo(100100);
    await loop.advanceTo(100100);
    const stored = (await db.$transaction((tx) => loadReplayState(tx, worldId))).state;
    expect(hashState(stored)).toBe(hashState(expected));
    expect(await db.nationTurn.count({ where: { worldId, nationId: 2 } })).toBe(0);
    expect(await db.nationTurn.count({ where: { worldId } })).toBe(0);
    expect(await db.nationOfficeTurn.count({ where: { worldId, nationId: 1, officerLevel: 12 } })).toBe(12);
    expect(await db.battleLog.findMany({ where: { worldId }, orderBy: { generalId: 'asc' } })).toMatchObject([
      { generalId: 2, text: expect.stringContaining('점령') },
      { generalId: 3, text: expect.stringContaining('점령') },
    ]);
    expect(
      await db.nationHistory.findUniqueOrThrow({
        where: { worldId_tick_nationId: { worldId, tick: 100100, nationId: 2 } },
      }),
    ).toMatchObject({ data: { events: expect.arrayContaining([expect.stringContaining('멸망')]) } });
    await expectOneCommandLog({ worldId, tick: { gt: 100000 } });
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
      turnRevision: 14,
      nextTurnTick: 110100,
    });
    const rewardHistory = await db.nationHistory.findUniqueOrThrow({
      where: { worldId_tick_nationId: { worldId, tick: 100100, nationId: 1 } },
    });
    expect(rewardHistory.data).toMatchObject({
      events: expect.arrayContaining([expect.stringMatching(/^포상: .*포상: 금 10$/)]),
    });
    expect(JSON.stringify((rewardHistory.data as { events: string[] }).events)).not.toContain('nation_reward');
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo((month + 10) * 10000);
    }
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive, archive.months.length).map((e) => e.stateHash)).toEqual(
      archive.months.map((m) => m.stateHash),
    );
    expect(archive.months[10]!.data.nations.map((n) => n.nationId)).toEqual([1]);
  });
  it.each([
    { key: 'nation_declare', name: '선전포고', relation: 'neutral' },
    { key: 'nation_peace', name: '종전 제의', relation: 'WAR' },
    { key: 'nation_pact', name: '불가침 제의', relation: 'neutral' },
    { key: 'nation_break_pact', name: '불가침 파기 제의', relation: 'NON_AGGRESSION' },
    { key: 'nation_aid', name: '원조', relation: 'neutral' },
  ] as const)('$name 국가 역사는 양국에 한 번만 남긴다', async ({ key, name, relation }) => {
    const initial = await warFixture();
    initial.diplomacies =
      relation === 'neutral' ? [] : [{ nationA: 1, nationB: 2, state: relation, untilTick: 110000 }];
    initial.nationTurns![1]![0] = {
      commandKey: key,
      args: key === 'nation_aid' ? { nationId: 2, resource: 'gold', amount: 10 } : { nationId: 2 },
    };
    const { worldId, loop } = await create(initial);
    await loop.advanceTo(100100);
    await loop.advanceTo(100100);
    const histories = await db.nationHistory.findMany({
      where: { worldId, tick: 100100 },
      orderBy: { nationId: 'asc' },
    });
    expect(histories.map((entry) => entry.nationId)).toEqual([1, 2]);
    for (const history of histories) {
      expect(history.data).toMatchObject({ events: [expect.stringContaining(name)] });
      expect(JSON.stringify((history.data as { events: string[] }).events)).not.toContain('nation_');
    }
    expect(histories[0]!.data).toEqual(histories[1]!.data);
  });
  it('국가 명령 실패도 표시 이름과 실패 이유를 한 번 남긴다', async () => {
    const initial = await warFixture();
    initial.nationTurns![1]![0] = {
      commandKey: 'nation_reward',
      args: { generalId: 4, resource: 'gold', amount: 10 },
    };
    const { worldId, loop } = await create(initial);
    await queue(worldId, 1, 'farm', {});
    await loop.advanceTo(100100);
    await loop.advanceTo(100100);
    const history = await db.nationHistory.findUniqueOrThrow({
      where: { worldId_tick_nationId: { worldId, tick: 100100, nationId: 1 } },
    });
    expect(history.data).toMatchObject({ events: ['포상: BAD_TARGET: 자기 국가 장수만 가능합니다.'] });
  });
  it.each(['success', 'error', 'token', 'expiry'] as const)(
    '수도 함락 %s 뒤 자동 천도·보급·반격·역사를 저장하고 롤백·재생한다',
    async (failure) => {
      const initial = await warFixture();
      initial.cities[2]!.nationId = 2;
      initial.cities[2]!.population = initial.cities[2]!.populationMax = 500000;
      initial.cities[3]!.nationId = 2;
      initial.cities.push({ ...initial.cities[3]!, cityKey: 5, name: '고립 도시', population: 10000, connections: [] });

      initial.generals[1]!.cityKey = 3;

      initial.generals[1]!.nextTurnTick = 200;
      delete initial.nationTurns;
      const ready = toWorldState(initial);
      refreshSupply(ready);
      initial.cities = Object.values(ready.cities);
      const { worldId, lease } = await create(initial, [
        { generalId: 1, troops: 1000, crewType: 1100 },
        { generalId: 2, troops: 10000, crewType: 1100 },
        { generalId: 3, troops: 10, crewType: 1100 },
      ]);
      await queue(worldId, 1, 'attack', { cityKey: 2 });
      await queue(worldId, 2, 'attack', { cityKey: 2 });
      if (failure !== 'success') {
        const before = await snapshot(worldId);
        const interrupted = new TurnLoop(db, lease, {
          beforeCommit: async (tx) => {
            if (failure === 'error') throw new Error('천도 저장 중단');
            await tx.engineLease.update({
              where: { worldId },
              data: failure === 'token' ? { fencingToken: { increment: 1 } } : { expiresAt: new Date(0) },
            });
          },
        });
        if (failure === 'error') await expect(interrupted.advanceTo(100100)).rejects.toThrow('천도 저장 중단');
        else await expect(interrupted.advanceTo(100100)).rejects.toBeInstanceOf(LeaseLostError);
        expect(await snapshot(worldId)).toEqual(before);
        expect(interrupted.state).toBeNull();
      }
      const loop = new TurnLoop(db, lease);
      await loop.advanceTo(100100);
      await loop.advanceTo(100100);
      const captured = await readWorldState(db, worldId);
      expect(captured.nations.find((n) => n.id === 2)).toMatchObject({ capitalCityKey: 3 });
      expect(captured.cities.find((c) => c.cityKey === 2)).toMatchObject({ nationId: 1 });
      for (const cityKey of [3, 4])
        expect(captured.cities.find((c) => c.cityKey === cityKey)).toMatchObject({ nationId: 2, supplied: true });
      expect(captured.cities.find((c) => c.cityKey === 5)).toMatchObject({ nationId: 2, supplied: false });
      expect(await db.nationTurn.count({ where: { worldId } })).toBe(0);
      const history = await db.nationHistory.findUniqueOrThrow({
        where: { worldId_tick_nationId: { worldId, tick: 100100, nationId: 2 } },
      });
      const events = (history.data as { events: string[] }).events;
      expect(events.filter((event) => event.includes('천도'))).toEqual([
        `${initial.nations[1]!.name} 수도 함락, 도시3 천도`,
      ]);
      const counterattackSequence = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).actionSequence + 1;
      await loop.advanceTo(100200);
      expect(
        await db.generalLog.findFirstOrThrow({
          // 명령 줄마다 한 행이라 점령 요약 줄을 고른다(INT-29 기록 조각 v1).
          where: {
            worldId,
            generalId: 2,
            tick: 100200,
            sequence: counterattackSequence,
            text: { contains: '도시2 점령:' },
          },
        }),
      ).toMatchObject({ kind: 'success', text: expect.stringContaining('도시2 점령:') });
      expect(await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 2 } } })).toMatchObject({
        nationId: 2,
      });
      for (const tick of [110000, 120000]) {
        await renewLease(db, lease);
        await loop.advanceTo(tick);
      }
      const archive = await exportReplay(db, worldId);
      expect(replayArchive(archive, 12).map((entry) => entry.stateHash)).toEqual(
        archive.months.map((entry) => entry.stateHash),
      );
    },
  );
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
      if (failure === 'error') await expect(loop.advanceTo(100100)).rejects.toThrow('전투 중단');
      else await expect(loop.advanceTo(100100)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await snapshot(worldId)).toEqual(before);
      expect(loop.state).toBeNull();
      await new TurnLoop(db, lease).advanceTo(100100);
      expect(await db.battleLog.count({ where: { worldId } })).toBe(2);
    },
  );
  it.each(['beforeCommit', 'committed'])(
    '실제 SIGKILL %s 후 전투·멸망·국가예턴은 정확히 한 번 반영된다',
    async (phase) => {
      const { worldId, lease } = await create();
      await queue(worldId, 1, 'attack', { cityKey: 2 });
      await releaseLease(db, lease);
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'apps/engine/test/turnWorker.ts', worldId, phase, '100100'],
        {
          env: { ...process.env, TEST_DATABASE_URL: url },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
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
        expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
          battleWins: phase === 'committed' ? 2 : 0,
          captures: phase === 'committed' ? 1 : 0,
        });
        await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "worldId" = ${worldId}`;
        const loop = new TurnLoop(db, (await acquireLease(db, worldId))!);
        await loop.advanceTo(100500);
        await loop.advanceTo(100500);
        expect(await db.battleLog.count({ where: { worldId } })).toBe(2);
        await expectOneCommandLog({ worldId, tick: { gt: 100000 } });
        expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).toMatchObject({
          battleWins: 2,
          captures: 1,
        });
        expect(await db.nation.count({ where: { worldId } })).toBe(1);
        expect(
          await db.nationOfficeTurn.findUniqueOrThrow({
            where: { worldId_nationId_officerLevel_slot: { worldId, nationId: 1, officerLevel: 12, slot: 0 } },
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
  it('AC-P2-24 마지막 국가의 임관 제한은 멸망 턴에 저장되며 재적재와 재생이 일치한다', async () => {
    const initial = await warFixture();
    initial.startYear = 195;
    initial.commandMeta = {
      nextNationId: 3,
      offers: { 4: 1 },
      lastNationRecruitmentLock: { fromYear: 195 },
    };
    for (const general of initial.generals) general.nextTurnTick = general.id * 100;
    const { worldId, loop, lease } = await create(initial);
    try {
      await queue(worldId, 1, 'attack', { cityKey: 2 });
      await queue(worldId, 2, 'join', { nationId: 1 });
      await queue(worldId, 3, 'join_random', {});
      await queue(worldId, 4, 'accept_invite', {});
      await expect(
        new TurnLoop(db, lease, {
          beforeCommit: async () => {
            throw Error('recruitment lock rollback');
          },
        }).advanceTo(100100),
      ).rejects.toThrow('recruitment lock rollback');
      expect((await readWorldState(db, worldId)).commandMeta).toEqual(initial.commandMeta);
      await loop.advanceTo(100100);
      const captured = await readWorldState(db, worldId);
      expect(captured.nations.map(({ id }) => id)).toEqual([1]);
      expect(captured.cities.find(({ cityKey }) => cityKey === 999)!.nationId).toBeNull();
      expect(captured.commandMeta?.lastNationRecruitmentLock).toEqual({ fromYear: 195, blockedNationId: 1 });
      const restarted = new TurnLoop(db, lease);
      await restarted.advanceTo(110000);
      const final = await readWorldState(db, worldId);
      expect(final.commandMeta?.lastNationRecruitmentLock).toEqual(captured.commandMeta?.lastNationRecruitmentLock);
      expect(final.generals.filter(({ id }) => id !== 1).map(({ nationId }) => nationId)).toEqual([null, null, null]);
      expect(final.commandMeta?.offers[4]).toBe(1);
      expect(
        (await db.generalLog.findMany({ where: { worldId, generalId: { in: [2, 3, 4] }, tick: { gt: 100000 } } })).map(
          ({ code, text }) => ({ code, text }),
        ),
      ).toEqual(Array(3).fill({ code: 'PROTECTED', text: '이 국가에는 임관할 수 없습니다.' }));
      const archive = await exportReplay(db, worldId);
      expect(archive.months).toHaveLength(11);
      expect(replayArchive(archive, 11).map(({ stateHash }) => stateHash)).toEqual(
        archive.months.map(({ stateHash }) => stateHash),
      );
    } finally {
      await releaseLease(db, lease);
    }
  });

  it('건국·등용제안·수락은 DB 재적재 후 유지되고 재생도 일치한다', async () => {
    const initial = await warFixture();
    initial.generals[3]!.nextTurnTick = 50;
    const { worldId, loop, lease } = await create(initial);
    await queue(worldId, 4, 'found', { name: '새나라', color: '#123456' });
    await queue(worldId, 3, 'resign', {});
    await loop.advanceTo(100050);
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toMatchObject({
      capitalCityKey: 3,
    });
    await queue(worldId, 4, 'invite', { generalId: 3 });
    await loop.advanceTo(110050);
    expect((await readWorldState(db, worldId)).commandMeta?.offers[3]).toBe(3);
    await queue(worldId, 3, 'accept_invite', {});
    await loop.advanceTo(115000);
    expect(await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toMatchObject({
      nationId: 3,
      cityKey: 3,
    });
    expect((await readWorldState(db, worldId)).commandMeta?.offers[3]).toBeUndefined();
    for (let month = 2; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo((month + 10) * 10000);
    }
    expect(replayArchive(await exportReplay(db, worldId), 22)).toHaveLength(22);
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

    initial.generals[2]!.nationId = 1;
    initial.generals[2]!.cityKey = 3;
    const ready = toWorldState(initial);
    refreshSupply(ready);
    initial.cities = Object.values(ready.cities);
    const { worldId, loop, lease } = await create(initial, [
      { generalId: 1, troops: 10000, crewType: 1100 },
      { generalId: 2, troops: 10000, crewType: 1100 },
      { generalId: 3, troops: 10, crewType: 1100 },
    ]);
    const agriculture = (await readWorldState(db, worldId)).cities[2]!.agriculture;
    await queue(worldId, 2, 'attack', { cityKey: 2 });
    await loop.advanceTo(100099);
    const attackSequence = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).actionSequence + 1;
    await loop.advanceTo(100100);
    expect(
      await db.generalLog.findFirstOrThrow({
        where: { worldId, generalId: 2, tick: 100100, sequence: attackSequence },
      }),
    ).toMatchObject({ kind: 'success' });
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({ supplied: false, agriculture });
    for (const tick of [200, 5000, 9999]) {
      await loop.advanceTo(tick + 100000);
      const state = await readWorldState(db, worldId);
      expect(state.cities[1], `tick ${tick} 회랑 소유권`).toMatchObject({ nationId: 2 });
      expect(state.cities[2], `tick ${tick} 뒤쪽 도시`).toMatchObject({ nationId: 1, supplied: false });
    }
    await loop.advanceTo(110000);
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({
      supplied: false,
      agriculture: Math.round(agriculture * 0.9),
    });
    await queue(worldId, 2, 'move', { cityKey: 4 });
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await renewLease(db, lease);
    await loop.advanceTo(110200);
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({
      supplied: true,
      agriculture: Math.round(agriculture * 0.9),
    });
    await loop.advanceTo(120000);
    expect((await readWorldState(db, worldId)).cities[2]).toMatchObject({
      supplied: true,
      agriculture: Math.round(agriculture * 0.9),
    });
    expect(replayArchive(await exportReplay(db, worldId), 12)).toHaveLength(12);
  });
});
