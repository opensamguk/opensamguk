import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { runGeneralTurn, toWorldState } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { warFixture } from '../test/warFixture';
import { saveInitialWorld, readWorldState } from './world/persistence';
import { controlClock } from './world/clock';
import { acquireLease, LeaseLostError, renewLease } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
afterAll(async () => {
  await db.world.deleteMany();
  await db.user.deleteMany({ where: { id: 'npc-test-human' } });
  await db.$disconnect();
});

async function create() {
  const initial = await warFixture();
  delete initial.nationTurns;
  await db.user.upsert({
    where: { id: 'npc-test-human' },
    update: {},
    create: { id: 'npc-test-human', email: 'npc-test-human@example.invalid', passwordHash: 'test-only' },
  });
  initial.generals[0]!.userId = 'npc-test-human';
  const { worldId } = await saveInitialWorld(db, initial, { name: 'NPC 통합', turnTermMinutes: 60, endYear: null });
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  return { initial, worldId, lease };
}

describe('AC-M1-17 실제 PostgreSQL NPC 턴', () => {
  it('빈 NPC 턴만 선택해 실행하고 사람 휴식·12개월 입력 재생을 보존한다', async () => {
    const { worldId, lease } = await create();
    const loop = new TurnLoop(db, lease);
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo(month * 10000);
    }
    const human = await db.generalLog.findMany({ where: { worldId, generalId: 1 } });
    expect(human).toHaveLength(12);
    expect(human.every((log) => log.commandKey === 'rest')).toBe(true);
    const npc = await db.generalLog.findMany({ where: { worldId, generalId: { not: 1 } } });
    expect(npc.some((log) => log.commandKey !== 'rest')).toBe(true);
    expect(npc.every((log) => log.kind === 'success')).toBe(true);
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive).map((entry) => entry.stateHash)).toEqual(
      archive.months.map((month) => month.stateHash),
    );
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(0);
  });
  it.each(['error', 'fencing'])(
    'NPC 선택 뒤 %s이면 상태·로그·메모리를 롤백하고 같은 명령을 재실행한다',
    async (failure) => {
      const { initial, worldId, lease } = await create();
      // 첫 턴부터 실제 NPC 선택을 검사한다.
      initial.generals[0]!.userId = null;
      await db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { userId: null } });
      const before = await readWorldState(db, worldId);
      const failing = new TurnLoop(db, lease, {
        beforeCommit: async (tx) => {
          if (failure === 'error') throw new Error('NPC 저장 중단');
          await tx.engineLease.update({ where: { worldId }, data: { fencingToken: { increment: 1 } } });
        },
      });
      if (failure === 'error') await expect(failing.advanceTo(100)).rejects.toThrow('NPC 저장 중단');
      else await expect(failing.advanceTo(100)).rejects.toBeInstanceOf(LeaseLostError);
      expect(failing.state).toBeNull();
      expect(await readWorldState(db, worldId)).toEqual(before);
      expect(await db.generalLog.count({ where: { worldId } })).toBe(0);
      const expected = runGeneralTurn(
        toWorldState(initial),
        { generalId: 1, tick: 100, unitSet: initial.unitSet },
        { commandKey: 'rest', args: {} },
        initial.seed,
      );
      expected.state.generals[1]!.nextTurnTick = 10100;
      const loop = new TurnLoop(db, lease);
      expect(await loop.advanceTo(100)).toEqual([{ generalId: 1, tick: 100, commandKey: expected.commandKey }]);
      expect(hashState(toWorldState(await readWorldState(db, worldId)))).toBe(hashState(expected.state));
      expect(await loop.advanceTo(100)).toEqual([]);
    },
  );
});
