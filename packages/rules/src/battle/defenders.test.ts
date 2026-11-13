import { expect, it } from 'vitest';
import { canDefend, DEFENSE_STANCE_FEATURE, DEFENSE_STANCE_KIND, storedDefenseStance } from './defenders';
import { commandInitial } from '../../test/commandFixture';
import { applyRecordedInput, initialReplayState } from '../replay';

it('preserves the original threshold in legacy worlds and applies the configured value to both stats', () => {
  expect(canDefend(1, 20, 20)).toBe(true);
  expect(canDefend(1, 19, 20)).toBe(false);
  expect(canDefend(1, 20, 20, false, 999)).toBe(true);
  expect(canDefend(1, 79, 80, true)).toBe(false);
  expect(canDefend(1, 80, 80, true)).toBe(true);
  expect(canDefend(1, 60, 59, true, 60)).toBe(false);
  expect(canDefend(1, 60, 60, true, 60)).toBe(true);
  expect(canDefend(1, 100, 100, true, 999)).toBe(false);
  expect(canDefend(0, 100, 100, true)).toBe(false);
  expect(storedDefenseStance(false, null)).toEqual({});
  expect(() => storedDefenseStance(false, 90)).toThrow();
});

it('replays a validated stance change only for a human general in a compatible world', () => {
  const initial = commandInitial();
  initial.generals[0]!.userId = 'player';
  const row = {
    sequence: 1,
    tick: 0,
    generalId: initial.generals[0]!.id,
    kind: DEFENSE_STANCE_KIND,
    status: 'APPLIED' as const,
    payload: { threshold: 60 },
    result: { threshold: 60 },
  };
  expect(() => applyRecordedInput(initialReplayState(initial), row)).toThrow();
  const replay = initialReplayState({ ...initial, ruleFeatures: [DEFENSE_STANCE_FEATURE] });
  expect(() => applyRecordedInput(replay, { ...row, result: { threshold: 80 } })).toThrow();
  expect(applyRecordedInput(replay, row).state.generals[row.generalId]?.defenseThreshold).toBe(60);
  expect(replay.state.generals[row.generalId]?.defenseThreshold).toBeUndefined();
});
