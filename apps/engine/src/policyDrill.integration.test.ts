import { afterAll, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { nextGameAction, runReplayAction } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { prepareBattleFixture } from '../test/battleFixture';
import { warFixture } from '../test/warFixture';
import { releaseLease, renewLease } from './lease';
import { loadReplayState } from './monthly';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
afterAll(() => db.$disconnect());

it('AC-M2-17 / AC-INT-28 훈련 방침의 부곡 훈련·사기 전환은 실제 DB와 재생 해시가 같다', async () => {
  const initial = await warFixture();
  initial.generals.forEach((general) => (general.deathYear = 250));
  const fixture = await prepareBattleFixture(db, initial, [{ generalId: 1, troops: 100, crewType: 1100 }]);
  const { worldId, lease, loop, users } = fixture;
  try {
    const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const event = await db.inputEvent.create({
      data: {
        worldId,
        generalId: 1,
        userId: general.userId!,
        kind: 'general.setPolicy',
        idempotencyKey: 'policy-drill-regression',
        payload: { policy: 'drill' },
      },
    });
    await loop.advanceTo(100_000);
    expect((await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('APPLIED');
    const commands = new Set<string>();
    for (let turn = 0; turn < 20 && !commands.has('morale'); turn++) {
      await renewLease(db, lease);
      const before = await db.$transaction((tx) => loadReplayState(tx, worldId));
      const tick = before.state.generals[1]!.nextTurnTick;
      let expected = before;
      while (nextGameAction(expected).tick <= tick) expected = runReplayAction(expected, initial.seed, initial.unitSet);
      const actions = await loop.advanceTo(tick);
      const action = actions.find((action) => action.generalId === 1)!;
      commands.add(action.commandKey);
      const actual = await db.$transaction((tx) => loadReplayState(tx, worldId));
      expect(hashState(actual)).toBe(hashState(expected));
      expect(actual.state.generals[1]!.crew).toBe(0);
      const previous = before.state.campaign!.units.find((unit) => unit.ownerId === 1)!;
      const unit = actual.state.campaign!.units.find((unit) => unit.id === previous.id)!;
      expect(action.commandKey).toBe(previous.train >= 100 ? 'morale' : 'train');
      if (action.commandKey === 'train') expect(unit.train).toBeGreaterThan(previous.train);
      else expect(unit.atmos).toBeGreaterThan(previous.atmos);
    }
    expect([...commands].sort()).toEqual(['morale', 'train']);
  } finally {
    await releaseLease(db, lease);
    await db.world.delete({ where: { id: worldId } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}, 30_000);
