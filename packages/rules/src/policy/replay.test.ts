import { expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { applyRecordedInput, initialReplayState, runReplayAction } from '../replay';
import { hashState } from '@opensamguk/shared/node';
import { assertSlotSet, emptyQueue, isPolicyMode } from './index';
import { assertReplayPolicy, emptyGeneralIdsSchema, enableReplayPolicy, validatePolicyRecordedInput } from './replay';

it('F의 앞·경계·새 월드 0·옛 null을 같은 함수로 고른다', () => {
  expect(isPolicyMode({ fromSequence: null, actionSequence: 100 })).toBe(false);
  expect(isPolicyMode({ fromSequence: 5, actionSequence: 4 })).toBe(false);
  expect(isPolicyMode({ fromSequence: 5, actionSequence: 5 })).toBe(true);
  expect(isPolicyMode({ fromSequence: 0, actionSequence: 0 })).toBe(true);
  expect(() => assertSlotSet(Array.from({ length: 30 }, (_, slot) => ({ slot })))).not.toThrow();
  expect(() => assertSlotSet(Array.from({ length: 30 }, (_, slot) => ({ slot: slot + 1 })))).toThrow();
});

it('archive5 거절은 이유만 요구하고 모르는 kind와 전환 거절은 거부한다', () => {
  const rejected = {
    sequence: 1,
    generalId: 1,
    status: 'REJECTED',
    kind: 'general.setPolicy',
    payload: { policy: 'farm' },
    result: { code: 'ACTOR_INACTIVE', message: '활성 계정이 아닙니다.' },
  };
  expect(() => validatePolicyRecordedInput(rejected, true)).not.toThrow();
  expect(() => validatePolicyRecordedInput({ ...rejected, kind: 'unknown' }, true)).toThrow();
  expect(() => validatePolicyRecordedInput({ ...rejected, kind: 'system.policy.enable' }, true)).toThrow();
  expect(() => validatePolicyRecordedInput({ ...rejected, status: 'APPLIED' }, true)).toThrow();
  for (const ids of [[2, 1], [1, 1], [0], [1.5]]) expect(emptyGeneralIdsSchema.safeParse(ids).success).toBe(false);
});

it('전환은 기존 세계·확장 상태를 보존하고 직접 휴식과 빈칸만 구분한다', () => {
  const initial = commandInitial();
  initial.generals[0]!.userId = 'human';
  const legacy = initialReplayState(initial);
  const beforeHash = hashState(legacy);
  const next = enableReplayPolicy(legacy, 30, 0, [2]);
  expect(hashState(legacy)).toBe(beforeHash);
  expect(next.state).toEqual(legacy.state);
  expect(next.turns[1]![0]!.explicit).toBe(true);
  expect(next.turns[2]![0]!.explicit).toBe(false);
  expect(next.policy!.lastActiveTicks).toEqual({ 1: 0 });
  expect(() => assertReplayPolicy(next)).not.toThrow();
});

it('정책 재생은 예턴 저장·방침·활동을 반영하고 활동 tick을 뒤로 돌리지 않는다', () => {
  const initial = commandInitial();
  initial.generals = initial.generals.slice(0, 1);
  initial.generals[0]!.userId = 'human';
  initial.generals[0]!.nextTurnTick = 1;
  let replay = enableReplayPolicy(initialReplayState(initial), 30, 0);
  const applied = { sequence: 1, generalId: 1, status: 'APPLIED' as const };
  replay = applyRecordedInput(replay, {
    ...applied,
    kind: 'general.setPolicy',
    payload: { policy: 'farm' },
    result: { policy: 'farm', activeTick: 10 },
  });
  replay = applyRecordedInput(replay, { ...applied, kind: 'general.active', payload: {}, result: { activeTick: 5 } });
  expect(replay.policy!.lastActiveTicks[1]).toBe(10);
  replay = applyRecordedInput(replay, {
    ...applied,
    kind: 'turns.set',
    payload: { revision: 0, turns: emptyQueue() },
    result: { revision: 1, activeTick: 11 },
  });
  const next = runReplayAction(replay, initial.seed, initial.unitSet);
  expect(next.state.cities[1]!.agriculture).toBeGreaterThan(replay.state.cities[1]!.agriculture);
  expect(next.turns[1]![29]!.explicit).toBe(false);
  expect(next.policy!.lastActiveTicks[1]).toBe(11);
});
