import { expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { initialReplayState, settleReplayMonth } from '../replay';
import { INACTIVE_REMOVAL_FEATURE, inactiveRemovalTick } from './inactiveRemoval';
import { PLAYER_AUTOPLAY_FEATURE } from './index';

function fixture() {
  const initial = commandInitial();
  initial.generals[0]!.userId = 'inactive-ruler';
  initial.generals[0]!.officerLevel = 12;
  initial.ruleFeatures = [INACTIVE_REMOVAL_FEATURE, PLAYER_AUTOPLAY_FEATURE, 'policy'];
  const replay = initialReplayState(initial, { policy: { version: 1, turnTermMinutes: 1440 } });
  return { initial, replay, tick: inactiveRemovalTick(0, 1440) };
}

it('removes the expired general and settles a successorless nation while preserving references', () => {
  const { initial, replay, tick } = fixture();
  const ruler = initial.generals[0]!;
  expect(settleReplayMonth(replay, initial.seed, tick - 10000).replay.state.generals[ruler.id]?.userId).toBe(
    'inactive-ruler',
  );
  const result = settleReplayMonth(replay, initial.seed, tick);
  expect(result.effects[INACTIVE_REMOVAL_FEATURE]).toEqual([ruler.id]);
  expect(result.replay.state.generals[ruler.id]).toMatchObject({
    userId: null,
    nationId: null,
    removedAt: tick,
    officerLevel: 0,
    crew: 0,
  });
  expect(result.replay.state.nations[ruler.nationId!]).toBeUndefined();
  expect(result.replay.policy!.lastActiveTicks[ruler.id]).toBeUndefined();
});

it('promotes an available successor, keeps their nation, and ignores recent activity', () => {
  const { initial, replay, tick } = fixture();
  const ruler = initial.generals[0]!;
  const successor = replay.state.generals[4]!;
  successor.nationId = ruler.nationId;
  successor.officerLevel = 1;
  successor.userId = 'recent';
  replay.policy!.lastActiveTicks[successor.id] = tick - 10000;
  const next = settleReplayMonth(replay, initial.seed, tick).replay;
  expect(next.state.generals[successor.id]).toMatchObject({ userId: 'recent', officerLevel: 12 });
  expect(next.state.nations[ruler.nationId!]?.isNpc).toBe(false);
  expect(next.state.generals[ruler.id]?.removedAt).toBe(tick);
});
